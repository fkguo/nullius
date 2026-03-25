import { randomUUID } from 'node:crypto';
import type {
  ResearchSignal,
  ResearchSignalPriority,
  ResearchSignalType,
} from '../model/research-signal.js';
import type { StrategyPreset } from '../model/research-strategy.js';
import { sha256Hex } from '../protocol/index.js';

export interface ExtractSignalsOptions {
  dedupWindowsMs?: Partial<Record<ResearchSignalType, number>>;
  stagnationThreshold?: number;
  currentStrategy?: string;
  currentGoal?: string;
}

export interface SelectStrategyInput {
  signals: readonly ResearchSignal[];
}

export interface StrategyScore {
  signal_match_score: number;
  final_score: number;
}

export interface StrategySelectionResult {
  selected_strategy: StrategyPreset;
  score: number;
  all_scores: Record<StrategyPreset, StrategyScore>;
  reasoning: string;
  decisive_signals: string[];
}

export interface EventSignalCandidate {
  signal_type: ResearchSignalType;
  payload: ResearchSignal['payload'];
  confidence: number;
  priority: ResearchSignalPriority;
  fingerprint_key: string;
  expires_at?: string;
}

export const RECURSIVE_EVENT_TYPES = new Set<string>([
  'signal_detected',
  'stagnation_detected',
  'diagnostic_emitted',
]);

export const PRIORITY_WEIGHTS: Record<ResearchSignalPriority, number> = {
  critical: 4,
  high: 2,
  medium: 1,
  low: 0.5,
};

export const DEFAULT_DEDUP_WINDOWS_MS: Record<ResearchSignalType, number> = {
  gap_detected: 0,
  calculation_divergence: 0,
  known_result_match: 0,
  integrity_violation: 3_600_000,
  method_plateau: 43_200_000,
  parameter_sensitivity: 0,
  cross_check_opportunity: 604_800_000,
  stagnation: 21_600_000,
};

export const SELECTOR_SIGNAL_STRATEGY_MAP: Partial<Record<ResearchSignalType, StrategyPreset>> = {
  method_plateau: 'explore',
  cross_check_opportunity: 'verify',
  stagnation: 'explore',
};

export function createSignalFromCandidate(
  candidate: EventSignalCandidate,
  detectedAt: string,
  sourceEventIds: readonly string[],
  runId?: string,
): ResearchSignal {
  if (sourceEventIds.length === 0) {
    throw new Error('ResearchSignal requires at least one source event ID.');
  }
  if (!Number.isFinite(Date.parse(detectedAt))) {
    throw new Error(`ResearchSignal detected_at must be an ISO timestamp: ${detectedAt}`);
  }
  // SAFETY: callers pair `signal_type` and `payload` from the same detector candidate.
  return {
    schema_version: 1,
    signal_id: randomUUID(),
    signal_type: candidate.signal_type,
    source_event_ids: [...sourceEventIds],
    fingerprint: sha256Hex(`${candidate.signal_type}:${candidate.fingerprint_key}`),
    confidence: Math.max(0, Math.min(1, candidate.confidence)),
    priority: candidate.priority,
    payload: candidate.payload,
    detected_at: detectedAt,
    ...(candidate.expires_at ? { expires_at: candidate.expires_at } : {}),
    ...(runId ? { run_id: runId } : {}),
  } as ResearchSignal;
}

export function addDurationMs(timestamp: string, durationMs: number): string {
  return new Date(Date.parse(timestamp) + durationMs).toISOString();
}

export function isMeaningfulSignalPriority(priority: ResearchSignalPriority): boolean {
  return priority !== 'low';
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
