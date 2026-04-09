/**
 * RunState V1 — Unified run lifecycle state enum (H-03).
 *
 * Canonical states for the run lifecycle, replacing scattered string literals.
 * Compatible with SkillBridgeJobEnvelope terminal_statuses: ['done', 'failed'].
 */

// ── Run-level States ─────────────────────────────────────────────────────────

/**
 * Canonical run lifecycle states.
 */
export const RUN_STATES = {
  pending: 'pending',
  running: 'running',
  paused: 'paused',
  awaiting_approval: 'awaiting_approval',
  done: 'done',
  failed: 'failed',
  needs_recovery: 'needs_recovery',
} as const;

export type RunState = (typeof RUN_STATES)[keyof typeof RUN_STATES];

/** Terminal states — a run in one of these will not transition further. */
export const TERMINAL_RUN_STATES: readonly RunState[] = ['done', 'failed'] as const;

export function isTerminalRunState(state: RunState): boolean {
  return state === 'done' || state === 'failed';
}

export function isActiveRunState(state: RunState): boolean {
  return state === 'running' || state === 'paused' || state === 'awaiting_approval';
}

// ── Step-level States ────────────────────────────────────────────────────────

/**
 * States for individual steps within a run.
 * Uses `in_progress` instead of `running` to distinguish from run-level state.
 */
export const RUN_STEP_STATES = {
  pending: 'pending',
  in_progress: 'in_progress',
  done: 'done',
  failed: 'failed',
} as const;

export type RunStepState = (typeof RUN_STEP_STATES)[keyof typeof RUN_STEP_STATES];

export function isTerminalStepState(state: RunStepState): boolean {
  return state === 'done' || state === 'failed';
}
