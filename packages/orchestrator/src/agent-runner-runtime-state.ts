import { internalError } from '@autoresearch/shared';
import type { LlmUsage, MessageContent, MessageParam } from './backends/chat-backend.js';
import { compactMessagesForOverflow } from './agent-runner-history-compaction.js';

type WindowPressure = 'normal' | 'high';

export type AgentRuntimeMarkerEvent = {
  type: 'runtime_marker';
  kind: 'context_overflow_retry' | 'truncation_retry' | 'low_gain_turn' | 'diminishing_returns_stop';
  turnCount: number;
  detail: Record<string, unknown>;
};

export interface AgentRuntimeState {
  windowPressure: WindowPressure;
  overflowRetryCount: number;
  truncationRetryCount: number;
  lastTurnUsage: Required<LlmUsage> | null;
  usageTotals: Required<LlmUsage>;
  lowGainStreak: number;
  lastToolCallSignature: string | null;
  lastToolOutcomeSignature: string | null;
}

const MARKER_PREFIX = '[runtime marker]';
const MAX_OVERFLOW_RETRIES = 1;
const MAX_TRUNCATION_RETRIES = 1;
const MAX_LOW_GAIN_STREAK = 2;
const CONTEXT_OVERFLOW_RE = /prompt (?:is )?too long|context length|context window|maximum context length|too many tokens/i;

export function createAgentRuntimeState(): AgentRuntimeState {
  return {
    windowPressure: 'normal',
    overflowRetryCount: 0,
    truncationRetryCount: 0,
    lastTurnUsage: null,
    usageTotals: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0 },
    lowGainStreak: 0,
    lastToolCallSignature: null,
    lastToolOutcomeSignature: null,
  };
}

export function recordTurnUsage(state: AgentRuntimeState, usage?: LlmUsage | null): void {
  if (!usage) return;
  const normalized: Required<LlmUsage> = {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    // Fallback assumes cache_* token fields are disjoint from input_tokens/output_tokens.
    total_tokens: usage.total_tokens
      ?? (usage.input_tokens ?? 0)
        + (usage.output_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0)
        + (usage.cache_read_input_tokens ?? 0),
  };
  state.lastTurnUsage = normalized;
  state.usageTotals.input_tokens += normalized.input_tokens;
  state.usageTotals.output_tokens += normalized.output_tokens;
  state.usageTotals.cache_creation_input_tokens += normalized.cache_creation_input_tokens;
  state.usageTotals.cache_read_input_tokens += normalized.cache_read_input_tokens;
  state.usageTotals.total_tokens += normalized.total_tokens;
}

export function resetLowGainTracking(state: AgentRuntimeState): void {
  state.lowGainStreak = 0;
  state.lastToolCallSignature = null;
  state.lastToolOutcomeSignature = null;
}

export function evaluateLowGainTurn(params: {
  turnCount: number;
  runtimeState: AgentRuntimeState;
  toolCallSignature: string;
  toolOutcomeSignature: string;
  toolCallCount: number;
  toolErrorCount: number;
}): { markers: AgentRuntimeMarkerEvent[]; shouldStop: boolean } {
  if (params.toolCallCount === 0) {
    params.runtimeState.lowGainStreak = 0;
    params.runtimeState.lastToolCallSignature = null;
    params.runtimeState.lastToolOutcomeSignature = null;
    return { markers: [], shouldStop: false };
  }

  const repeatedOutcome = params.toolOutcomeSignature.length > 0
    && params.toolOutcomeSignature === params.runtimeState.lastToolOutcomeSignature;
  const allToolErrors = params.toolErrorCount === params.toolCallCount;
  const lowGain = repeatedOutcome || allToolErrors;

  params.runtimeState.lastToolCallSignature = params.toolCallSignature;
  params.runtimeState.lastToolOutcomeSignature = params.toolOutcomeSignature;
  params.runtimeState.lowGainStreak = lowGain ? params.runtimeState.lowGainStreak + 1 : 0;

  if (!lowGain) return { markers: [], shouldStop: false };

  const markers: AgentRuntimeMarkerEvent[] = [
    {
      type: 'runtime_marker',
      kind: 'low_gain_turn',
      turnCount: params.turnCount,
      detail: {
        low_gain_streak: params.runtimeState.lowGainStreak,
        threshold: MAX_LOW_GAIN_STREAK,
        reason: allToolErrors ? 'all_tools_errored' : 'repeated_tool_outcome',
        tool_call_count: params.toolCallCount,
        tool_error_count: params.toolErrorCount,
        tool_call_signature: params.toolCallSignature,
        tool_outcome_signature: params.toolOutcomeSignature,
        last_turn_usage: params.runtimeState.lastTurnUsage,
      },
    },
  ];

  if (params.runtimeState.lowGainStreak < MAX_LOW_GAIN_STREAK) {
    return { markers, shouldStop: false };
  }

  markers.push({
    type: 'runtime_marker',
    kind: 'diminishing_returns_stop',
    turnCount: params.turnCount,
    detail: {
      low_gain_streak: params.runtimeState.lowGainStreak,
      threshold: MAX_LOW_GAIN_STREAK,
      tool_call_count: params.toolCallCount,
      tool_error_count: params.toolErrorCount,
      tool_call_signature: params.toolCallSignature,
      tool_outcome_signature: params.toolOutcomeSignature,
      last_turn_usage: params.runtimeState.lastTurnUsage,
    },
  });
  return { markers, shouldStop: true };
}

export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return CONTEXT_OVERFLOW_RE.test(message);
}

export function recoverFromContextOverflow(params: {
  error: unknown;
  messages: MessageParam[];
  turnCount: number;
  runtimeState: AgentRuntimeState;
}): { messages: MessageParam[]; marker: AgentRuntimeMarkerEvent } | null {
  if (!isContextOverflowError(params.error) || params.runtimeState.overflowRetryCount >= MAX_OVERFLOW_RETRIES) {
    return null;
  }
  const compacted = compactMessagesForOverflow(params.messages);
  if (!compacted) {
    return null;
  }
  params.runtimeState.overflowRetryCount += 1;
  params.runtimeState.windowPressure = 'high';
  return {
    messages: compacted.messages,
    marker: {
      type: 'runtime_marker',
      kind: 'context_overflow_retry',
      turnCount: params.turnCount,
      detail: {
        attempt: params.runtimeState.overflowRetryCount,
        window_pressure: params.runtimeState.windowPressure,
        compacted_messages: compacted.stats.changedMessages,
        compacted_blocks: compacted.stats.compactedBlocks,
        compacted_tool_results: compacted.stats.compactedToolResults,
        removed_messages: compacted.stats.removedMessages,
        last_turn_usage: params.runtimeState.lastTurnUsage,
      },
    },
  };
}

export function buildTruncationRecovery(params: {
  messages: MessageParam[];
  assistantContent: MessageContent[];
  turnCount: number;
  runtimeState: AgentRuntimeState;
}): { messages: MessageParam[]; marker: AgentRuntimeMarkerEvent } | null {
  if (params.runtimeState.truncationRetryCount >= MAX_TRUNCATION_RETRIES) {
    return null;
  }
  if (params.assistantContent.length === 0) {
    throw internalError('Assistant response hit max_tokens without any content to continue.');
  }
  params.runtimeState.truncationRetryCount += 1;
  params.runtimeState.windowPressure = 'high';
  return {
    messages: [
      ...params.messages,
      { role: 'assistant', content: params.assistantContent },
      {
        role: 'user',
        content: `${MARKER_PREFIX} Previous assistant response was truncated by max_tokens. Continue from the unfinished point without repeating completed content unless needed.`,
      },
    ],
    marker: {
      type: 'runtime_marker',
      kind: 'truncation_retry',
      turnCount: params.turnCount,
      detail: {
        attempt: params.runtimeState.truncationRetryCount,
        window_pressure: params.runtimeState.windowPressure,
        last_turn_usage: params.runtimeState.lastTurnUsage,
      },
    },
  };
}
