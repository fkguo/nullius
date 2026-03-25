import type { ResearchSignal } from '../model/research-signal.js';
import type { ResearchEvent } from '../model/research-event.js';
import {
  DEFAULT_DEDUP_WINDOWS_MS,
  addDurationMs,
  asRecord,
  createSignalFromCandidate,
  isMeaningfulSignalPriority,
  readString,
  type ExtractSignalsOptions,
} from './types.js';

interface StrategyCycle {
  event_ids: string[];
  detected_at: string;
  run_id: string;
  strategy_id?: string;
  has_meaningful_signal: boolean;
}

export function synthesizeStagnation(
  events: readonly ResearchEvent[],
  signals: readonly ResearchSignal[],
  options: ExtractSignalsOptions = {},
): ResearchSignal[] {
  const cycles = collectCycles(events, signals, options.currentStrategy);
  if (cycles.length === 0) {
    return [];
  }

  const threshold = options.stagnationThreshold ?? 5;
  let consecutiveEmptyCycles = 0;
  let lastProductiveCycle: string | undefined;
  let latestStagnationSignal: ResearchSignal | undefined;

  for (const cycle of cycles) {
    if (cycle.has_meaningful_signal) {
      consecutiveEmptyCycles = 0;
      lastProductiveCycle = cycle.detected_at;
      latestStagnationSignal = undefined;
      continue;
    }

    consecutiveEmptyCycles += 1;
    if (consecutiveEmptyCycles < threshold) {
      continue;
    }

    const strategyId = cycle.strategy_id ?? options.currentStrategy;
    latestStagnationSignal = createSignalFromCandidate(
      {
        signal_type: 'stagnation',
        confidence: Math.min(0.99, 0.7 + 0.05 * consecutiveEmptyCycles),
        priority: 'high',
        fingerprint_key: `${strategyId ?? 'unknown'}:${options.currentGoal ?? 'unscoped'}`,
        expires_at: addDurationMs(cycle.detected_at, DEFAULT_DEDUP_WINDOWS_MS.stagnation),
        payload: {
          consecutive_empty_cycles: consecutiveEmptyCycles,
          threshold,
          ...(strategyId ? { current_strategy: strategyId } : {}),
          ...(lastProductiveCycle ? { last_productive_cycle: lastProductiveCycle } : {}),
          recommended_action:
            consecutiveEmptyCycles >= threshold * 2 ? 'abandon_direction' : 'switch_strategy',
        },
      },
      cycle.detected_at,
      cycle.event_ids,
      cycle.run_id,
    );
  }

  return latestStagnationSignal ? [latestStagnationSignal] : [];
}

function collectCycles(
  events: readonly ResearchEvent[],
  signals: readonly ResearchSignal[],
  currentStrategy?: string,
): StrategyCycle[] {
  const cycleStarts = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.event_type === 'strategy_selected');
  if (cycleStarts.length === 0) {
    return [];
  }

  const meaningfulEventIds = new Set(
    signals
      .filter((signal) => isMeaningfulSignalPriority(signal.priority))
      .flatMap((signal) => signal.source_event_ids),
  );

  return cycleStarts.map(({ event, index }, cycleIndex) => {
    const nextIndex = cycleStarts[cycleIndex + 1]?.index ?? events.length;
    const cycleEvents = events.slice(index, nextIndex);
    const payload = asRecord(event.payload);
    const strategyId = payload ? readString(payload, 'strategy_id') : currentStrategy;
    return {
      event_ids: cycleEvents.map((cycleEvent) => cycleEvent.event_id),
      detected_at: cycleEvents[cycleEvents.length - 1]?.timestamp ?? event.timestamp,
      run_id: event.run_id,
      strategy_id: strategyId,
      has_meaningful_signal: cycleEvents.some((cycleEvent) => meaningfulEventIds.has(cycleEvent.event_id)),
    };
  });
}
