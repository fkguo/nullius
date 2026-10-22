/**
 * LOG-03 item 3: every event name that changes run_status through
 * transitionStatus() must have a branch in the ledger read model, so a
 * ledger-derived status never lags behind the state file. The list below is
 * checked against the production call sites by name; add a row whenever a
 * new transitionStatus() caller introduces an event name.
 */
import { describe, expect, it } from 'vitest';
import { deriveLedgerStatusFromOperatorEvent } from '../src/operator-read-model-summary.js';

/** eventType passed to transitionStatus() -> run_status it moves the run to. */
const STATUS_CHANGING_EVENTS: Array<[string, string, Record<string, unknown>]> = [
  ['run_started', 'running', {}],                       // state-manager.ts createRun
  ['approval_approved', 'running', { category: 'A1' }], // state-manager.ts approve (non-final)
  ['approval_approved', 'completed', { category: 'A5' }],
  ['approval_rejected', 'paused', {}],
  ['approval_requested', 'awaiting_approval', {}],
  ['planning_started', 'running', {}],                  // computation/bridge.ts
  ['execution_completed', 'completed', {}],             // computation/runner.ts
  ['execution_failed', 'failed', {}],                   // computation/runner.ts, native-control.ts
];

describe('ledger status derivation covers every status-changing event name', () => {
  for (const [eventType, expected, details] of STATUS_CHANGING_EVENTS) {
    it(`${eventType} -> ${expected}`, () => {
      const result = deriveLedgerStatusFromOperatorEvent(eventType, details, 'unknown');
      expect(result.unmappedEvent).toBeNull();
      expect(result.status).toBe(expected);
    });
  }

  it('synthesised status_<run_status> names map to that status', () => {
    expect(deriveLedgerStatusFromOperatorEvent('status_needs_recovery', {}, 'running'))
      .toEqual({ status: 'needs_recovery', unmappedEvent: null });
  });

  it.each(['idle', 'running', 'paused', 'failed', 'completed'])('acceptance observation preserves execution status %s', status => {
    expect(deriveLedgerStatusFromOperatorEvent('workflow_acceptance_checked', { status: 'incomplete' }, status))
      .toEqual({ status, unmappedEvent: null });
  });

  it('an unknown name keeps the previous status and is reported, never dropped', () => {
    expect(deriveLedgerStatusFromOperatorEvent('fleet_claimed', {}, 'running'))
      .toEqual({ status: 'running', unmappedEvent: 'fleet_claimed' });
    expect(deriveLedgerStatusFromOperatorEvent('', {}, 'paused'))
      .toEqual({ status: 'paused', unmappedEvent: '(missing event_type)' });
  });
});
