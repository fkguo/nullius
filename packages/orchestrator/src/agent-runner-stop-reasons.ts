import { internalError } from '@autoresearch/shared';

export type NormalizedStopReason = 'tool_use' | 'end_turn' | 'stop_sequence' | 'max_tokens';
export type StopReasonKind = 'tool_use' | 'completion' | 'truncation';

const STOP_REASON_MAP: Record<string, { normalized: NormalizedStopReason; kind: StopReasonKind }> = {
  tool_use: { normalized: 'tool_use', kind: 'tool_use' },
  end_turn: { normalized: 'end_turn', kind: 'completion' },
  endTurn: { normalized: 'end_turn', kind: 'completion' },
  stop_sequence: { normalized: 'stop_sequence', kind: 'completion' },
  stopSequence: { normalized: 'stop_sequence', kind: 'completion' },
  max_tokens: { normalized: 'max_tokens', kind: 'truncation' },
  maxTokens: { normalized: 'max_tokens', kind: 'truncation' },
};

export function normalizeStopReason(stopReason: string): { normalized: NormalizedStopReason; kind: StopReasonKind } {
  const normalized = STOP_REASON_MAP[stopReason];
  if (normalized) {
    return normalized;
  }
  throw internalError(`Unknown assistant stop_reason: ${stopReason}`);
}

export function isTerminalCompletionStopReason(stopReason: string): boolean {
  try {
    return normalizeStopReason(stopReason).kind === 'completion';
  } catch {
    return false;
  }
}
