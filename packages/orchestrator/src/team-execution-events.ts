import { randomUUID } from 'node:crypto';
import { utcNowIso } from './util.js';
import type { TeamDelegateAssignment, TeamExecutionEvent, TeamExecutionState } from './team-execution-types.js';

export function appendTeamEvent(
  state: TeamExecutionState,
  input: {
    kind: TeamExecutionEvent['kind'];
    assignment?: TeamDelegateAssignment | null;
    checkpoint_id?: string | null;
    payload?: Record<string, unknown>;
  },
): TeamExecutionEvent {
  const event: TeamExecutionEvent = {
    event_id: randomUUID(),
    kind: input.kind,
    created_at: utcNowIso(),
    assignment_id: input.assignment?.assignment_id ?? null,
    task_id: input.assignment?.task_id ?? null,
    checkpoint_id: input.checkpoint_id ?? null,
    payload: { ...(input.payload ?? {}) },
  };
  state.event_log.push(event);
  state.updated_at = event.created_at;
  return event;
}
