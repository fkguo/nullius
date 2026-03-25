import { describe, expect, it } from 'vitest';
import { extractSignals } from '../src/signals/index.js';
import type { ResearchEvent } from '../src/model/research-event.js';

describe('extractSignals', () => {
  it('extracts bounded event-native signals and skips recursive event types', () => {
    const events: ResearchEvent[] = [
      strategySelectedEvent('2026-03-25T00:00:00.000Z'),
      computationFailedEvent('2026-03-25T00:10:00.000Z'),
      computationFailedEvent('2026-03-25T00:20:00.000Z'),
      computationFailedEvent('2026-03-25T00:30:00.000Z'),
      computationFailedEvent('2026-03-25T00:40:00.000Z'),
      signalDetectedEvent('2026-03-25T00:45:00.000Z'),
      diagnosticEvent('2026-03-25T00:46:00.000Z'),
      outcomePublishedEvent('outcome-1', '2026-03-25T01:00:00.000Z'),
      outcomePublishedEvent('outcome-2', '2026-03-25T02:00:00.000Z'),
    ];

    const signals = extractSignals(events);
    const methodPlateau = signals.find((signal) => signal.signal_type === 'method_plateau');
    const crossCheck = signals.find((signal) => signal.signal_type === 'cross_check_opportunity');

    expect(signals.map((signal) => signal.signal_type)).toEqual([
      'method_plateau',
      'cross_check_opportunity',
    ]);
    expect(methodPlateau?.source_event_ids).toHaveLength(2);
    expect(methodPlateau?.payload).toMatchObject({
      current_method: 'comp-alpha',
      cycles_without_improvement: 4,
    });
    expect(crossCheck?.payload).toMatchObject({
      new_outcome_ref: 'outcome-2',
      existing_outcome_refs: ['outcome-1'],
      cross_check_type: 'shared_strategy_ref',
    });
    expect(signals.flatMap((signal) => signal.source_event_ids)).not.toContain('signal-detected-event');
    expect(signals.flatMap((signal) => signal.source_event_ids)).not.toContain('diagnostic-event');
  });

  it('splits identical fingerprints outside the dedup window', () => {
    const events: ResearchEvent[] = [
      strategySelectedEvent('2026-03-25T00:00:00.000Z'),
      computationFailedEvent('2026-03-25T00:10:00.000Z'),
      computationFailedEvent('2026-03-25T00:20:00.000Z'),
      computationFailedEvent('2026-03-25T00:30:00.000Z'),
      computationFailedEvent('2026-03-25T00:40:00.000Z'),
      computationFailedEvent('2026-03-25T13:50:00.000Z'),
      computationFailedEvent('2026-03-25T14:00:00.000Z'),
    ];

    const plateauSignals = extractSignals(events).filter((signal) => signal.signal_type === 'method_plateau');

    expect(plateauSignals).toHaveLength(2);
    expect(plateauSignals[0]?.payload).toMatchObject({ cycles_without_improvement: 4 });
    expect(plateauSignals[1]?.payload).toMatchObject({ cycles_without_improvement: 6 });
  });

  it('synthesizes stagnation only when explicit strategy-selected cycles stay empty', () => {
    const events: ResearchEvent[] = [
      strategySelectedEvent('2026-03-25T00:00:00.000Z', 'strategy-a', 'select-1'),
      diagnosticEvent('2026-03-25T00:10:00.000Z', 'diag-1'),
      strategySelectedEvent('2026-03-25T01:00:00.000Z', 'strategy-a', 'select-2'),
      signalDetectedEvent('2026-03-25T01:10:00.000Z', 'signal-detected-cycle-2'),
      strategySelectedEvent('2026-03-25T02:00:00.000Z', 'strategy-a', 'select-3'),
      diagnosticEvent('2026-03-25T02:10:00.000Z', 'diag-3'),
    ];

    const signals = extractSignals(events, {
      currentGoal: 'derive-bounded-result',
      stagnationThreshold: 3,
    });

    expect(signals.at(-1)).toMatchObject({
      signal_type: 'stagnation',
      priority: 'high',
      payload: {
        consecutive_empty_cycles: 3,
        threshold: 3,
        current_strategy: 'strategy-a',
        recommended_action: 'switch_strategy',
      },
    });
  });

  it('escalates stagnation to abandon_direction after twice the empty-cycle threshold', () => {
    const events: ResearchEvent[] = [
      strategySelectedEvent('2026-03-25T00:00:00.000Z', 'strategy-a', 'select-1'),
      strategySelectedEvent('2026-03-25T01:00:00.000Z', 'strategy-a', 'select-2'),
      strategySelectedEvent('2026-03-25T02:00:00.000Z', 'strategy-a', 'select-3'),
      strategySelectedEvent('2026-03-25T03:00:00.000Z', 'strategy-a', 'select-4'),
      strategySelectedEvent('2026-03-25T04:00:00.000Z', 'strategy-a', 'select-5'),
      strategySelectedEvent('2026-03-25T05:00:00.000Z', 'strategy-a', 'select-6'),
    ];

    const signals = extractSignals(events, {
      currentGoal: 'stalled-direction',
      stagnationThreshold: 3,
    });

    expect(signals.at(-1)).toMatchObject({
      signal_type: 'stagnation',
      payload: {
        consecutive_empty_cycles: 6,
        threshold: 3,
        current_strategy: 'strategy-a',
        recommended_action: 'abandon_direction',
      },
    });
  });
});

function strategySelectedEvent(timestamp: string, strategyId = 'strategy-a', eventId = 'strategy-selected-event'): ResearchEvent {
  return {
    schema_version: 1,
    event_id: eventId,
    event_type: 'strategy_selected',
    timestamp,
    run_id: 'run-1',
    payload: {
      strategy_id: strategyId,
      reason: 'selected after bounded ranking',
    },
  };
}

function computationFailedEvent(timestamp: string): ResearchEvent {
  return {
    schema_version: 1,
    event_id: `computation-failed-${timestamp}`,
    event_type: 'computation_failed',
    timestamp,
    run_id: 'run-1',
    payload: {
      computation_id: 'comp-alpha',
      error: {
        code: 'timeout',
        message: 'timed out while converging',
      },
    },
  };
}

function outcomePublishedEvent(outcomeId: string, timestamp: string): ResearchEvent {
  return {
    schema_version: 1,
    event_id: `outcome-published-${outcomeId}`,
    event_type: 'outcome_published',
    timestamp,
    run_id: 'run-1',
    payload: {
      outcome_id: outcomeId,
      strategy_ref: 'strategy-a',
    },
  };
}

function signalDetectedEvent(timestamp: string, eventId = 'signal-detected-event'): ResearchEvent {
  return {
    schema_version: 1,
    event_id: eventId,
    event_type: 'signal_detected',
    timestamp,
    run_id: 'run-1',
    payload: {
      signal_id: '22fa2477-b406-465c-b59b-a1cb31edc987',
      signal_type: 'method_plateau',
      confidence: 0.8,
    },
  };
}

function diagnosticEvent(timestamp: string, eventId = 'diagnostic-event'): ResearchEvent {
  return {
    schema_version: 1,
    event_id: eventId,
    event_type: 'diagnostic_emitted',
    timestamp,
    run_id: 'run-1',
    payload: {
      diagnostic_type: 'taxonomy_miss',
      message: 'ignored by the signal extractor',
    },
  };
}
