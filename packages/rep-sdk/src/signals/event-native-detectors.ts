import type { ResearchSignal } from '../model/research-signal.js';
import type { ResearchEvent } from '../model/research-event.js';
import {
  DEFAULT_DEDUP_WINDOWS_MS,
  RECURSIVE_EVENT_TYPES,
  addDurationMs,
  asRecord,
  createSignalFromCandidate,
  readString,
} from './types.js';

const METHOD_PLATEAU_THRESHOLD = 3;

export function detectEventNativeSignals(events: readonly ResearchEvent[]): ResearchSignal[] {
  const rejectedCounts = new Map<string, number>();
  const failedCounts = new Map<string, number>();
  const publishedOutcomes = new Map<string, string[]>();
  const signals: ResearchSignal[] = [];

  for (const event of events) {
    if (RECURSIVE_EVENT_TYPES.has(event.event_type)) {
      continue;
    }
    const payload = asRecord(event.payload);
    if (!payload) {
      continue;
    }

    const methodPlateau = detectMethodPlateau(event, payload, rejectedCounts, failedCounts);
    if (methodPlateau) {
      signals.push(createSignalFromCandidate(methodPlateau, event.timestamp, [event.event_id], event.run_id));
      continue;
    }

    const crossCheck = detectCrossCheckOpportunity(event, payload, publishedOutcomes);
    if (crossCheck) {
      signals.push(createSignalFromCandidate(crossCheck, event.timestamp, [event.event_id], event.run_id));
    }
  }

  return signals;
}

function detectMethodPlateau(
  event: ResearchEvent,
  payload: Record<string, unknown>,
  rejectedCounts: Map<string, number>,
  failedCounts: Map<string, number>,
) {
  if (event.event_type === 'strategy_rejected') {
    const strategyId = readString(payload, 'strategy_id');
    if (!strategyId) {
      return null;
    }
    const count = (rejectedCounts.get(strategyId) ?? 0) + 1;
    rejectedCounts.set(strategyId, count);
    if (count < METHOD_PLATEAU_THRESHOLD) {
      return null;
    }
    return {
      signal_type: 'method_plateau' as const,
      confidence: Math.min(0.9, 0.5 + 0.1 * count),
      priority: 'medium' as const,
      fingerprint_key: `strategy:${strategyId}`,
      payload: {
        current_method: strategyId,
        cycles_without_improvement: count,
        suggested_alternatives: [],
      },
    };
  }

  if (event.event_type !== 'computation_failed') {
    return null;
  }

  const computationId = readString(payload, 'computation_id');
  if (!computationId) {
    return null;
  }
  const count = (failedCounts.get(computationId) ?? 0) + 1;
  failedCounts.set(computationId, count);
  if (count < METHOD_PLATEAU_THRESHOLD) {
    return null;
  }

  return {
    signal_type: 'method_plateau' as const,
    confidence: 0.8,
    priority: 'high' as const,
    fingerprint_key: `computation:${computationId}`,
    payload: {
      current_method: computationId,
      cycles_without_improvement: count,
      suggested_alternatives: [],
    },
  };
}

function detectCrossCheckOpportunity(
  event: ResearchEvent,
  payload: Record<string, unknown>,
  publishedOutcomes: Map<string, string[]>,
) {
  if (event.event_type !== 'outcome_published') {
    return null;
  }

  const strategyRef = readString(payload, 'strategy_ref');
  const outcomeId = readString(payload, 'outcome_id');
  if (!strategyRef || !outcomeId) {
    return null;
  }

  const seenOutcomes = publishedOutcomes.get(strategyRef) ?? [];
  if (!seenOutcomes.includes(outcomeId)) {
    seenOutcomes.push(outcomeId);
    publishedOutcomes.set(strategyRef, seenOutcomes);
  }
  const existingOutcomeRefs = seenOutcomes.filter((value) => value !== outcomeId).sort();
  if (existingOutcomeRefs.length === 0) {
    return null;
  }

  return {
    signal_type: 'cross_check_opportunity' as const,
    confidence: 0.65,
    priority: 'low' as const,
    fingerprint_key: `strategy:${strategyRef}`,
    expires_at: addDurationMs(event.timestamp, DEFAULT_DEDUP_WINDOWS_MS.cross_check_opportunity),
    payload: {
      new_outcome_ref: outcomeId,
      existing_outcome_refs: existingOutcomeRefs,
      cross_check_type: 'shared_strategy_ref',
    },
  };
}
