// @autoresearch/orchestrator — AgentRunner (NEW-RT-01)
// Anthropic SDK agent loop: MCP tool dispatch, lane queue, approval gate injection.

import type { McpClient } from './mcp-client.js';
import type { ApprovalGate } from './approval-gate.js';
import type { SpanCollector } from './tracing.js';
import type { RunManifest, StepCheckpoint } from './run-manifest.js';
import { McpError } from '@autoresearch/shared';
import { generateTraceId } from '@autoresearch/shared';

// ─── Minimal types compatible with @anthropic-ai/sdk ─────────────────────────

type TextContent = { type: 'text'; text: string };
type ToolUseContent = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type ToolResultContent = { type: 'tool_result'; tool_use_id: string; content: string };
type MessageContent = TextContent | ToolUseContent | ToolResultContent;

/** MessageParam compatible with @anthropic-ai/sdk.MessageParam. */
export type MessageParam = {
  role: 'user' | 'assistant';
  content: string | MessageContent[];
};

/** Tool compatible with @anthropic-ai/sdk.Tool. */
export type Tool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

type LlmResponse = { content: MessageContent[]; stop_reason: string };

type MessagesCreateFn = (params: {
  model: string;
  max_tokens: number;
  messages: MessageParam[];
  tools: Tool[];
}) => Promise<LlmResponse>;

// ─── Agent events ─────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; input: unknown; result: unknown }
  | { type: 'approval_required'; approvalId: string; packetPath: string }
  | { type: 'done'; stopReason: string; turnCount: number }
  | { type: 'error'; error: McpError };

// ─── Lane queue (per-run serialization) ──────────────────────────────────────
// Module-level singleton; tests may replace via _resetLaneQueue().

let _laneQueue = new Map<string, Promise<void>>();

/** @internal Reset lane queue for testing isolation. */
export function _resetLaneQueue(): void {
  _laneQueue = new Map();
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface AgentRunnerOptions {
  model: string;
  maxTurns?: number;
  runId: string;
  mcpClient: McpClient;
  /** Injected for future approval-gate checks before tool dispatch. */
  approvalGate: ApprovalGate;
  spanCollector?: SpanCollector;
  /** @internal Injected messages.create for testing without the Anthropic SDK. */
  _messagesCreate?: MessagesCreateFn;
}

// ─── AgentRunner ──────────────────────────────────────────────────────────────

export class AgentRunner {
  private readonly model: string;
  private readonly maxTurns: number;
  readonly runId: string;
  private readonly mcpClient: McpClient;
  /** Reserved for pre-dispatch approval checks (future use). */
  readonly approvalGate: ApprovalGate;
  private readonly spanCollector: SpanCollector | null;
  private createMessage: MessagesCreateFn;

  constructor(options: AgentRunnerOptions) {
    this.model = options.model;
    this.maxTurns = options.maxTurns ?? 50;
    this.runId = options.runId;
    this.mcpClient = options.mcpClient;
    this.approvalGate = options.approvalGate;
    this.spanCollector = options.spanCollector ?? null;

    if (options._messagesCreate) {
      this.createMessage = options._messagesCreate;
    } else {
      // Lazily import the SDK on first call so tests that inject _messagesCreate
      // never need the SDK installed.
      this.createMessage = async (params) => {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic();
        // Replace with a bound method so subsequent calls skip the import.
        this.createMessage = (p) =>
          client.messages.create(p as Parameters<typeof client.messages.create>[0]) as Promise<LlmResponse>;
        return this.createMessage(params);
      };
    }
  }

  /**
   * Run the agent loop as an AsyncGenerator of AgentEvent.
   *
   * Per-run serialization (lane queue): concurrent calls with the same runId
   * queue up and execute one at a time. Different runIds run in parallel.
   *
   * @param messages Initial conversation messages.
   * @param tools    Available MCP tools.
   * @param runOptions.manifest Optional manifest for durable-execution resume.
   */
  async *run(
    messages: MessageParam[],
    tools: Tool[],
    runOptions?: { manifest?: RunManifest },
  ): AsyncGenerator<AgentEvent> {
    // Lane queue: serialize calls for same runId
    const prior = _laneQueue.get(this.runId) ?? Promise.resolve();
    let releaseLane!: () => void;
    const lane = new Promise<void>((r) => {
      releaseLane = r;
    });
    _laneQueue.set(this.runId, lane);

    try {
      await prior; // Wait for any prior run on this lane
      yield* this._runImpl(messages, tools, runOptions?.manifest ?? null);
    } finally {
      releaseLane();
      // Clean up if no newer entry has replaced ours
      if (_laneQueue.get(this.runId) === lane) {
        _laneQueue.delete(this.runId);
      }
    }
  }

  private async *_runImpl(
    messages: MessageParam[],
    tools: Tool[],
    manifest: RunManifest | null,
  ): AsyncGenerator<AgentEvent> {
    let currentMessages: MessageParam[] = [...messages];
    const traceId = generateTraceId();

    // Resume recovery: resolve any incomplete tool_use blocks from a prior crash.
    const recovery = await this._resolveIncompleteToolUses(currentMessages, manifest);
    if (recovery !== null) {
      for (const ev of recovery.events) yield ev;
      if (recovery.done) return; // approval_required or other terminal event during recovery
      currentMessages = recovery.messages;
    }

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const turnSpan = this.spanCollector?.startSpan('agent_turn', traceId);
      turnSpan?.setAttribute('turn', turn);

      let response: LlmResponse;
      try {
        response = await this.createMessage({
          model: this.model,
          max_tokens: 8096,
          messages: currentMessages,
          tools,
        });
        turnSpan?.end('OK');
      } catch (err: unknown) {
        turnSpan?.end('ERROR');
        yield { type: 'error', error: asMcpError(err) };
        return;
      }

      const assistantContent: MessageContent[] = [];
      const toolResults: ToolResultContent[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          assistantContent.push(block);
          if (block.text.trim()) {
            yield { type: 'text', text: block.text };
          }
        } else if (block.type === 'tool_use') {
          assistantContent.push(block);

          const toolSpan = this.spanCollector?.startSpan(block.name, traceId);

          let rawText: string;
          let resultValue: unknown;

          try {
            const toolResult = await this.mcpClient.callTool(block.name, block.input);
            toolSpan?.end(toolResult.isError ? 'ERROR' : 'OK');
            rawText = toolResult.rawText;
            resultValue = toolResult.json ?? toolResult.rawText;

            // Detect approval gate signal: fail-fast — do not execute subsequent tools
            const json = toolResult.json as Record<string, unknown> | null;
            if (json?.['requires_approval'] === true) {
              yield { type: 'tool_call', name: block.name, input: block.input, result: resultValue };
              yield {
                type: 'approval_required',
                approvalId: String(json['approval_id'] ?? ''),
                packetPath: String(json['packet_path'] ?? ''),
              };
              yield { type: 'done', stopReason: 'approval_required', turnCount: turn + 1 };
              return;
            }
          } catch (err: unknown) {
            toolSpan?.end('ERROR');
            yield { type: 'error', error: asMcpError(err, `Tool call failed: `) };
            return;
          }

          yield { type: 'tool_call', name: block.name, input: block.input, result: resultValue };
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: rawText });
        }
      }

      // end_turn or no tool calls → agent is done for this turn
      if (response.stop_reason === 'end_turn' || toolResults.length === 0) {
        yield { type: 'done', stopReason: response.stop_reason, turnCount: turn + 1 };
        return;
      }

      // Append assistant message + tool results, then loop
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: toolResults },
      ];
    }

    yield { type: 'done', stopReason: 'max_turns', turnCount: this.maxTurns };
  }

  /**
   * Handle incomplete tool_use blocks left in the messages from a prior crash.
   *
   * If the last message is an assistant message with unanswered tool_use blocks
   * (i.e., the messages array ends with the assistant turn), we resolve each
   * tool_use either from a manifest checkpoint (cached, no re-execution) or by
   * re-calling the tool.
   *
   * Returns null if no recovery is needed.
   * `done: true` means the caller should stop the run (e.g. approval_required during recovery).
   */
  private async _resolveIncompleteToolUses(
    messages: MessageParam[],
    manifest: RunManifest | null,
  ): Promise<{ events: AgentEvent[]; messages: MessageParam[]; done: boolean } | null> {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) {
      return null;
    }

    const pendingToolUses = last.content.filter(
      (b): b is ToolUseContent => (b as MessageContent).type === 'tool_use',
    );
    if (pendingToolUses.length === 0) return null;

    const events: AgentEvent[] = [];
    const toolResults: ToolResultContent[] = [];

    for (const tu of pendingToolUses) {
      const checkpoint = manifest?.checkpoints.find((c: StepCheckpoint) => c.step_id === tu.id);
      if (checkpoint && manifest?.resume_from) {
        // Inject cached result — skip re-execution of side-effectful tool
        const cached = checkpoint.result_summary ?? '';
        events.push({ type: 'tool_call', name: tu.name, input: tu.input, result: cached });
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: cached });
      } else {
        try {
          const result = await this.mcpClient.callTool(tu.name, tu.input);
          const json = result.json as Record<string, unknown> | null;

          // Approval gate: fail-fast during recovery — same semantics as main loop
          if (json?.['requires_approval'] === true) {
            events.push({ type: 'tool_call', name: tu.name, input: tu.input, result: result.json ?? result.rawText });
            events.push({
              type: 'approval_required',
              approvalId: String(json['approval_id'] ?? ''),
              packetPath: String(json['packet_path'] ?? ''),
            });
            events.push({ type: 'done', stopReason: 'approval_required', turnCount: 0 });
            return {
              events,
              messages: [...messages, { role: 'user', content: toolResults }],
              done: true,
            };
          }

          events.push({ type: 'tool_call', name: tu.name, input: tu.input, result: result.json ?? result.rawText });
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result.rawText });
        } catch (err: unknown) {
          const mcpErr = asMcpError(err);
          events.push({ type: 'error', error: mcpErr });
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: ${mcpErr.message}` });
        }
      }
    }

    return {
      events,
      messages: [...messages, { role: 'user', content: toolResults }],
      done: false,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function asMcpError(err: unknown, prefix = ''): McpError {
  if (err instanceof McpError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new McpError('INTERNAL_ERROR', `${prefix}${msg}`);
}
