import type { AgentEvent } from '../agent-runner-ops.js';

export type DelegatedRuntimeTurnPhase = 'recovery' | 'dialogue';
export type DelegatedRuntimeMarkerKind = Extract<AgentEvent, { type: 'runtime_marker' }>['kind'];

export interface DelegatedRuntimeTerminalOutcomeV1 {
  type: 'done' | 'error';
  phase: DelegatedRuntimeTurnPhase;
  turn_count: number;
  stop_reason?: string;
  error_code?: string | null;
}

export interface DelegatedRuntimeTurnProjectionV1 {
  phase: DelegatedRuntimeTurnPhase;
  turn_count: number;
  text_count: number;
  tool_call_count: number;
  runtime_marker_kinds: DelegatedRuntimeMarkerKind[];
  approval_requested: boolean;
  terminal_outcome: DelegatedRuntimeTerminalOutcomeV1 | null;
}

export interface DelegatedRuntimeProjectionV1 {
  version: 1;
  turn_count: number;
  recovery_turn_count: number;
  dialogue_turn_count: number;
  projected_turns: DelegatedRuntimeTurnProjectionV1[];
  runtime_marker_kinds: DelegatedRuntimeMarkerKind[];
  approval_requested: boolean;
  terminal_outcome: DelegatedRuntimeTerminalOutcomeV1 | null;
}

type DelegatedRuntimeProjectionBuilder = {
  turns: DelegatedRuntimeTurnProjectionV1[];
};

function uniqueMarkerKinds(
  events: AgentEvent[],
): DelegatedRuntimeMarkerKind[] {
  return [...new Set(
    events.flatMap((event) => (event.type === 'runtime_marker' ? [event.kind] : [])),
  )].sort();
}

function terminalOutcomeFromEvents(
  phase: DelegatedRuntimeTurnPhase,
  turnCount: number,
  events: AgentEvent[],
): DelegatedRuntimeTerminalOutcomeV1 | null {
  const terminal = [...events].reverse().find((event) => event.type === 'done' || event.type === 'error');
  if (!terminal) {
    return null;
  }
  if (terminal.type === 'done') {
    return {
      type: 'done',
      phase,
      turn_count: terminal.turnCount,
      stop_reason: terminal.stopReason,
    };
  }
  return {
    type: 'error',
    phase,
    turn_count: turnCount,
    error_code: terminal.error.code,
  };
}

export function createDelegatedRuntimeProjectionBuilder(): DelegatedRuntimeProjectionBuilder {
  return { turns: [] };
}

export function recordDelegatedRuntimeProjectionTurn(params: {
  builder: DelegatedRuntimeProjectionBuilder;
  phase: DelegatedRuntimeTurnPhase;
  turnCount: number;
  events: AgentEvent[];
}): void {
  const { builder, phase, turnCount, events } = params;
  const terminalOutcome = terminalOutcomeFromEvents(phase, turnCount, events);
  // Recovery replays intentionally start from turnCount=0; a recovery marker
  // carries the real dialogue counter when we have one.
  const projectedTurnCount = terminalOutcome?.turn_count
    ?? [...events]
      .reverse()
      .find((event) => event.type === 'runtime_marker')
      ?.turnCount
    ?? turnCount;
  builder.turns.push({
    phase,
    turn_count: projectedTurnCount,
    text_count: events.filter((event) => event.type === 'text').length,
    tool_call_count: events.filter((event) => event.type === 'tool_call').length,
    runtime_marker_kinds: uniqueMarkerKinds(events),
    approval_requested: events.some((event) => event.type === 'approval_required'),
    terminal_outcome: terminalOutcome,
  });
}

export function finalizeDelegatedRuntimeProjection(
  builder: DelegatedRuntimeProjectionBuilder,
): DelegatedRuntimeProjectionV1 {
  const terminalOutcome = [...builder.turns]
    .reverse()
    .map((turn) => turn.terminal_outcome)
    .find((turn): turn is DelegatedRuntimeTerminalOutcomeV1 => turn !== null) ?? null;
  return {
    version: 1,
    turn_count: builder.turns.reduce((max, turn) => Math.max(max, turn.turn_count), 0),
    recovery_turn_count: builder.turns.filter((turn) => turn.phase === 'recovery').length,
    dialogue_turn_count: builder.turns.filter((turn) => turn.phase === 'dialogue').length,
    projected_turns: builder.turns,
    runtime_marker_kinds: [...new Set(builder.turns.flatMap((turn) => turn.runtime_marker_kinds))].sort(),
    approval_requested: builder.turns.some((turn) => turn.approval_requested),
    terminal_outcome: terminalOutcome,
  };
}
