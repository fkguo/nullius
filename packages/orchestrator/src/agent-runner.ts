// @nullius/orchestrator — AgentRunner (NEW-RT-01 + NEW-RT-06)
// Provider-agnostic agent loop: MCP tool dispatch, lane queue.

import { generateTraceId } from '@nullius/shared';
import { createChatBackend, type ChatBackendFactory } from './backends/backend-factory.js';
import type { ChatBackend, MessageParam, MessagesCreateFn, Tool, ToolUseContent } from './backends/chat-backend.js';
import type { ToolCaller } from './mcp-client.js';
import { createToolAttemptIdentity, RunManifestManager } from './run-manifest.js';
import type { RuntimePermissionProfileV1 } from './runtime-permission-profile.js';
import {
  buildRuntimeToolPermissionView,
  filterToolsForPermissionView,
  type ToolPermissionView,
} from './tool-execution-policy.js';
import type { ResolvedChatRoute } from './routing/types.js';
import { DEFAULT_CHAT_MAX_TOKENS, loadRoutingConfig, resolveChatRoute } from './routing/loader.js';
import type { SpanCollector } from './tracing.js';
import { asMcpError, handleAssistantResponse, resolveIncompleteToolUses, type AgentEvent } from './agent-runner-ops.js';
import {
  createDelegatedRuntimeProjectionBuilder,
  finalizeDelegatedRuntimeProjection,
  recordDelegatedRuntimeProjectionTurn,
  type DelegatedRuntimeProjectionV1,
} from './research-loop/delegated-runtime-projection.js';
import {
  createAgentRuntimeState,
  recordTurnUsage,
  recoverFromContextOverflow,
  resetLowGainTracking,
} from './agent-runner-runtime-state.js';

export type { AgentEvent } from './agent-runner-ops.js';
export type { MessageParam, Tool } from './backends/chat-backend.js';
export type { ChatRoutingConfig, ResolvedChatRoute } from './routing/types.js';

let _laneQueue = new Map<string, Promise<void>>();

export function _resetLaneQueue(): void {
  _laneQueue = new Map();
}

export interface AgentRunnerOptions {
  model: string;
  maxTurns?: number;
  runId: string;
  approvalRunId: string;
  approvalProjectRoot: string;
  mcpClient: ToolCaller;
  permissionProfile: RuntimePermissionProfileV1;
  spanCollector?: SpanCollector;
  routingConfig?: unknown;
  backendFactory?: ChatBackendFactory;
  manifestManager: RunManifestManager;
  _messagesCreate?: MessagesCreateFn;
}

export class AgentRunner {
  private readonly maxTurns: number;
  readonly runId: string;
  private readonly approvalRunId: string;
  private readonly approvalProjectRoot: string;
  private readonly mcpClient: ToolCaller;
  private readonly spanCollector: SpanCollector | null;
  private readonly manifestManager: RunManifestManager;
  private readonly permissionView: ToolPermissionView;
  private readonly route: ResolvedChatRoute;
  private readonly chatBackend: ChatBackend;
  private lastRuntimeProjection: DelegatedRuntimeProjectionV1 | null = null;

  constructor(options: AgentRunnerOptions) {
    this.maxTurns = options.maxTurns ?? 50;
    this.runId = options.runId;
    this.approvalRunId = options.approvalRunId;
    this.approvalProjectRoot = options.approvalProjectRoot;
    this.mcpClient = options.mcpClient;
    this.spanCollector = options.spanCollector ?? null;
    this.manifestManager = options.manifestManager;
    this.permissionView = buildRuntimeToolPermissionView(options.permissionProfile);
    const routingConfig = loadRoutingConfig(options.routingConfig, options.model);
    this.route = resolveChatRoute(routingConfig, options.model);
    this.chatBackend = (options.backendFactory ?? createChatBackend)(this.route, { messagesCreate: options._messagesCreate });
  }

  async *run(messages: MessageParam[], tools: Tool[]): AsyncGenerator<AgentEvent> {
    this.lastRuntimeProjection = null;
    const prior = _laneQueue.get(this.runId) ?? Promise.resolve();
    let releaseLane!: () => void;
    const lane = new Promise<void>(resolve => {
      releaseLane = resolve;
    });
    _laneQueue.set(this.runId, lane);

    try {
      await prior;
      yield* this.runImpl(messages, filterToolsForPermissionView(tools, this.permissionView));
    } finally {
      releaseLane();
      if (_laneQueue.get(this.runId) === lane) _laneQueue.delete(this.runId);
    }
  }

  get runtimeProjection(): DelegatedRuntimeProjectionV1 | null {
    return this.lastRuntimeProjection;
  }

  private async *runImpl(messages: MessageParam[], tools: Tool[]): AsyncGenerator<AgentEvent> {
    let currentMessages: MessageParam[] = [...messages];
    const runtimeState = createAgentRuntimeState();
    const projectionBuilder = createDelegatedRuntimeProjectionBuilder();
    const traceId = generateTraceId();
    const manifestManager = this.manifestManager;
    const existingManifest = manifestManager.loadManifest(this.runId);
    manifestManager.ensureManifest(this.runId);
    if (!existingManifest) {
      const last = currentMessages.at(-1);
      const initialPendingToolUses = last?.role === 'assistant' && Array.isArray(last.content)
        ? last.content.filter((block): block is ToolUseContent => block.type === 'tool_use')
        : [];
      if (initialPendingToolUses.length > 0) {
        // The public execute-agent contract permits an initial transcript to end
        // with a host-produced assistant tool_use. Make that first dispatch
        // durable before recovery logic sees it. Once a manifest exists, a
        // missing intent remains a hard recovery error.
        manifestManager.observeToolIntents(
          this.runId,
          initialPendingToolUses.map(block => createToolAttemptIdentity({
            stepId: block.id,
            toolName: block.name,
            input: block.input,
          })),
        );
      }
    }
    const recovery = await resolveIncompleteToolUses({
      messages: currentMessages,
      runId: this.runId,
      approvalRunId: this.approvalRunId,
      approvalProjectRoot: this.approvalProjectRoot,
      mcpClient: this.mcpClient,
      permissionView: this.permissionView,
      manifestManager,
      traceId,
      spanCollector: this.spanCollector,
    });
    if (recovery !== null) {
      recordDelegatedRuntimeProjectionTurn({
        builder: projectionBuilder,
        phase: 'recovery',
        turnCount: 0,
        events: recovery.events,
      });
      for (const event of recovery.events) yield event;
      if (recovery.done) {
        this.lastRuntimeProjection = finalizeDelegatedRuntimeProjection(projectionBuilder);
        return;
      }
      currentMessages = recovery.messages;
    }

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      const turnSpan = this.spanCollector?.startSpan('agent_turn', traceId);
      turnSpan?.setAttribute('turn', turn);
      try {
        const response = await this.chatBackend.createMessage({
          model: this.route.model,
          maxTokens: this.route.max_tokens ?? DEFAULT_CHAT_MAX_TOKENS,
          messages: currentMessages,
          tools,
        });
        recordTurnUsage(runtimeState, response.usage);
        turnSpan?.setAttribute('window_pressure', runtimeState.windowPressure);
        if (runtimeState.lastTurnUsage) {
          turnSpan?.setAttribute('input_tokens', runtimeState.lastTurnUsage.input_tokens);
          turnSpan?.setAttribute('output_tokens', runtimeState.lastTurnUsage.output_tokens);
          turnSpan?.setAttribute('total_tokens', runtimeState.lastTurnUsage.total_tokens);
        }
        turnSpan?.end('OK');
        const next = await handleAssistantResponse({
          blocks: response.content,
          messages: currentMessages,
          stopReason: response.stop_reason,
          turnCount: turn + 1,
          runtimeState,
          traceId,
          runId: this.runId,
          approvalRunId: this.approvalRunId,
          approvalProjectRoot: this.approvalProjectRoot,
          mcpClient: this.mcpClient,
          permissionView: this.permissionView,
          manifestManager,
          spanCollector: this.spanCollector,
        });
        recordDelegatedRuntimeProjectionTurn({
          builder: projectionBuilder,
          phase: 'dialogue',
          turnCount: turn + 1,
          events: next.events,
        });
        for (const event of next.events) yield event;
        if (next.done) {
          this.lastRuntimeProjection = finalizeDelegatedRuntimeProjection(projectionBuilder);
          return;
        }
        currentMessages = next.messages;
      } catch (error) {
        const recovery = recoverFromContextOverflow({
          error,
          messages: currentMessages,
          turnCount: turn + 1,
          runtimeState,
        });
        if (recovery) {
          resetLowGainTracking(runtimeState);
          turnSpan?.setAttribute('window_pressure', runtimeState.windowPressure);
          turnSpan?.end('ERROR');
          recordDelegatedRuntimeProjectionTurn({
            builder: projectionBuilder,
            phase: 'dialogue',
            turnCount: turn + 1,
            events: [recovery.marker],
          });
          yield recovery.marker;
          currentMessages = recovery.messages;
          continue;
        }
        turnSpan?.end('ERROR');
        const errorEvent = { type: 'error', error: asMcpError(error) } as const;
        recordDelegatedRuntimeProjectionTurn({
          builder: projectionBuilder,
          phase: 'dialogue',
          turnCount: turn + 1,
          events: [errorEvent],
        });
        yield errorEvent;
        this.lastRuntimeProjection = finalizeDelegatedRuntimeProjection(projectionBuilder);
        return;
      }
    }

    const doneEvent = { type: 'done', stopReason: 'max_turns', turnCount: this.maxTurns } as const;
    recordDelegatedRuntimeProjectionTurn({
      builder: projectionBuilder,
      phase: 'dialogue',
      turnCount: this.maxTurns,
      events: [doneEvent],
    });
    yield doneEvent;
    this.lastRuntimeProjection = finalizeDelegatedRuntimeProjection(projectionBuilder);
  }
}
