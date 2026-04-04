import { McpError, internalError } from '@autoresearch/shared';
import type { MessageContent, MessageParam, ToolResultContent, ToolUseContent } from './backends/chat-backend.js';
import { normalizeStopReason } from './agent-runner-stop-reasons.js';
import { buildTruncationRecovery, type AgentRuntimeMarkerEvent, type AgentRuntimeState } from './agent-runner-runtime-state.js';
import { groupToolUsesForExecution } from './agent-runner-tool-groups.js';
import type { McpToolResult, ToolCaller } from './mcp-client.js';
import type { RunManifest, StepCheckpoint } from './run-manifest.js';
import type { SpanCollector } from './tracing.js';

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; input: unknown; result: unknown }
  | { type: 'approval_required'; approvalId: string; packetPath: string }
  | AgentRuntimeMarkerEvent
  | { type: 'done'; stopReason: string; turnCount: number }
  | { type: 'error'; error: McpError };

export function asMcpError(error: unknown, prefix = ''): McpError {
  if (error instanceof McpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new McpError('INTERNAL_ERROR', `${prefix}${message}`);
}

function checkpointSummary(result: McpToolResult): string {
  if (typeof result.rawText === 'string' && result.rawText.length > 0) {
    return result.rawText;
  }
  if (result.json !== null) {
    return JSON.stringify(result.json);
  }
  return '';
}

async function executeToolCall(params: {
  block: ToolUseContent;
  turnCount: number;
  traceId: string;
  mcpClient: ToolCaller;
  spanCollector: SpanCollector | null;
  checkpointRecorder?: ((stepId: string, resultSummary: string) => void | Promise<void>) | null;
}): Promise<{ events: AgentEvent[]; toolResult: ToolResultContent; done: boolean }> {
  const toolSpan = params.spanCollector?.startSpan(params.block.name, params.traceId);
  try {
    const result = await params.mcpClient.callTool(params.block.name, params.block.input);
    await params.checkpointRecorder?.(params.block.id, checkpointSummary(result));
    toolSpan?.end(result.isError ? 'ERROR' : 'OK');
    const resultValue = result.json ?? result.rawText;
    const events: AgentEvent[] = [{ type: 'tool_call', name: params.block.name, input: params.block.input, result: resultValue }];
    const json = result.json as Record<string, unknown> | null;
    if (json?.['requires_approval'] === true) {
      events.push({ type: 'approval_required', approvalId: String(json['approval_id'] ?? ''), packetPath: String(json['packet_path'] ?? '') });
      events.push({ type: 'done', stopReason: 'approval_required', turnCount: params.turnCount });
      return { events, toolResult: { type: 'tool_result', tool_use_id: params.block.id, content: result.rawText }, done: true };
    }
    return { events, toolResult: { type: 'tool_result', tool_use_id: params.block.id, content: result.rawText }, done: false };
  } catch (error) {
    toolSpan?.end('ERROR');
    throw asMcpError(error, 'Tool call failed: ');
  }
}

async function executeToolUseGroups(params: {
  blocks: ToolUseContent[];
  turnCount: number;
  traceId: string;
  mcpClient: ToolCaller;
  spanCollector: SpanCollector | null;
  checkpointRecorder?: ((stepId: string, resultSummary: string) => void | Promise<void>) | null;
}): Promise<{ events: AgentEvent[]; toolResults: ToolResultContent[]; done: boolean }> {
  const events: AgentEvent[] = [];
  const toolResults: ToolResultContent[] = [];

  for (const group of groupToolUsesForExecution(params.blocks, params.mcpClient)) {
    const executions = group.length > 1
      ? await Promise.all(group.map(block => executeToolCall({ ...params, block })))
      : [await executeToolCall({ ...params, block: group[0]! })];

    for (const [index, execution] of executions.entries()) {
      if (group.length > 1 && execution.done) {
        throw internalError(
          `Batch-safe tool ${group[index]!.name} unexpectedly requested approval during parallel execution.`,
        );
      }
      events.push(...execution.events);
      if (execution.done) {
        return { events, toolResults, done: true };
      }
      toolResults.push(execution.toolResult);
    }
  }

  return { events, toolResults, done: false };
}

export async function handleAssistantResponse(params: {
  blocks: MessageContent[];
  messages: MessageParam[];
  stopReason: string;
  turnCount: number;
  runtimeState: AgentRuntimeState;
  traceId: string;
  mcpClient: ToolCaller;
  spanCollector: SpanCollector | null;
  checkpointRecorder?: ((stepId: string, resultSummary: string) => void | Promise<void>) | null;
}): Promise<{ events: AgentEvent[]; messages: MessageParam[]; done: boolean }> {
  const assistantContent: MessageContent[] = [];
  const toolResults: ToolResultContent[] = [];
  const events: AgentEvent[] = [];
  let pendingToolUses: ToolUseContent[] = [];

  const flushPendingToolUses = async (): Promise<boolean> => {
    if (pendingToolUses.length === 0) {
      return false;
    }
    const grouped = await executeToolUseGroups({
      blocks: pendingToolUses,
      turnCount: params.turnCount,
      traceId: params.traceId,
      mcpClient: params.mcpClient,
      spanCollector: params.spanCollector,
      checkpointRecorder: params.checkpointRecorder,
    });
    pendingToolUses = [];
    events.push(...grouped.events);
    if (grouped.done) {
      return true;
    }
    toolResults.push(...grouped.toolResults);
    return false;
  };

  for (const block of params.blocks) {
    if (block.type === 'text') {
      if (await flushPendingToolUses()) return { events, messages: params.messages, done: true };
      assistantContent.push(block);
      if (block.text.trim()) events.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type !== 'tool_use') {
      if (await flushPendingToolUses()) return { events, messages: params.messages, done: true };
      assistantContent.push(block);
      continue;
    }
    assistantContent.push(block);
    pendingToolUses.push(block);
  }

  if (await flushPendingToolUses()) return { events, messages: params.messages, done: true };

  const stopReason = normalizeStopReason(params.stopReason);
  if (toolResults.length > 0) {
    if (stopReason.kind === 'truncation') {
      throw internalError('Assistant response hit max_tokens while requesting tool execution.');
    }
    return {
      events,
      messages: [
        ...params.messages,
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: toolResults },
      ],
      done: false,
    };
  }
  if (stopReason.kind === 'tool_use') {
    throw internalError('Assistant returned tool_use stop_reason without tool_use blocks.');
  }
  if (stopReason.kind === 'truncation') {
    const recovery = buildTruncationRecovery({
      messages: params.messages,
      assistantContent,
      turnCount: params.turnCount,
      runtimeState: params.runtimeState,
    });
    if (!recovery) {
      throw internalError('Assistant response remained truncated after the bounded recovery budget was exhausted.');
    }
    events.push(recovery.marker);
    return { events, messages: recovery.messages, done: false };
  }
  events.push({ type: 'done', stopReason: stopReason.normalized, turnCount: params.turnCount });
  return { events, messages: params.messages, done: true };
}

export async function resolveIncompleteToolUses(params: {
  messages: MessageParam[];
  manifest: RunManifest | null;
  mcpClient: ToolCaller;
  checkpointRecorder?: ((stepId: string, resultSummary: string) => void | Promise<void>) | null;
  shouldSkipStep?: ((manifest: RunManifest, stepId: string) => boolean) | null;
}): Promise<{ events: AgentEvent[]; messages: MessageParam[]; done: boolean } | null> {
  const last = params.messages[params.messages.length - 1];
  if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) return null;
  const pendingToolUses = last.content.filter((block): block is ToolUseContent => (block as MessageContent).type === 'tool_use');
  if (pendingToolUses.length === 0) return null;

  const events: AgentEvent[] = [];
  const toolResults: ToolResultContent[] = [];
  for (const toolUse of pendingToolUses) {
    const checkpoint = params.manifest?.checkpoints.find((item: StepCheckpoint) => item.step_id === toolUse.id);
    const shouldSkip = checkpoint && params.manifest
      ? (params.shouldSkipStep?.(params.manifest, toolUse.id) ?? Boolean(params.manifest.resume_from))
      : false;
    if (checkpoint && shouldSkip) {
      const cached = checkpoint.result_summary ?? '';
      events.push({ type: 'tool_call', name: toolUse.name, input: toolUse.input, result: cached });
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: cached });
      continue;
    }
    try {
      const result = await params.mcpClient.callTool(toolUse.name, toolUse.input);
      await params.checkpointRecorder?.(toolUse.id, checkpointSummary(result));
      const resultValue = result.json ?? result.rawText;
      const json = result.json as Record<string, unknown> | null;
      events.push({ type: 'tool_call', name: toolUse.name, input: toolUse.input, result: resultValue });
      if (json?.['requires_approval'] === true) {
        events.push({ type: 'approval_required', approvalId: String(json['approval_id'] ?? ''), packetPath: String(json['packet_path'] ?? '') });
        events.push({ type: 'done', stopReason: 'approval_required', turnCount: 0 });
        return { events, messages: [...params.messages, { role: 'user', content: toolResults }], done: true };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result.rawText });
    } catch (error) {
      const mcpError = asMcpError(error);
      events.push({ type: 'error', error: mcpError });
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `Error: ${mcpError.message}` });
    }
  }

  return { events, messages: [...params.messages, { role: 'user', content: toolResults }], done: false };
}
