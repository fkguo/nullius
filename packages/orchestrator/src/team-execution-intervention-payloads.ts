import type { TeamExecutionAssignmentInput, TeamInterventionCommand, TeamPendingRedirect } from './team-execution-types.js';

const TASK_KINDS = ['literature', 'idea', 'compute', 'evidence_search', 'finding', 'draft_update', 'review'] as const;
const HANDOFF_KINDS = ['compute', 'feedback', 'literature', 'review', 'writing'] as const;

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`team intervention payload requires non-empty string '${key}'`);
  }
  return value;
}

function readOptionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`team intervention payload field '${key}' must be a non-empty string`);
  }
  return value;
}

function readNullableString(payload: Record<string, unknown>, key: string): string | null | undefined {
  const value = payload[key];
  if (value === undefined || value === null) return value as null | undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`team intervention payload field '${key}' must be a non-empty string or null`);
  }
  return value;
}

function readOptionalStage(payload: Record<string, unknown>): number | undefined {
  const value = payload.stage;
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error("team intervention payload field 'stage' must be a non-negative integer");
  }
  return Number(value);
}

function readOptionalEnum<T extends readonly string[]>(
  payload: Record<string, unknown>,
  key: string,
  values: T,
): T[number] | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(`team intervention payload field '${key}' must be one of ${values.join(', ')}`);
  }
  return value as T[number];
}

function readRequiredEnum<T extends readonly string[]>(
  payload: Record<string, unknown>,
  key: string,
  values: T,
): T[number] {
  const value = readOptionalEnum(payload, key, values);
  if (value === undefined) {
    throw new Error(`team intervention payload requires '${key}'`);
  }
  return value;
}

function readOptionalDatetime(payload: Record<string, unknown>, key: string): string | null | undefined {
  const value = readNullableString(payload, key);
  if (value === undefined || value === null) return value;
  if (Number.isNaN(new Date(value).getTime())) {
    throw new Error(`team intervention payload field '${key}' must be a valid datetime string`);
  }
  return value;
}

function readOptionalPayloadObject(
  payload: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null | undefined {
  const value = payload[key];
  if (value === undefined || value === null) {
    return value as null | undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`team intervention payload field '${key}' must be an object or null`);
  }
  return structuredClone(value as Record<string, unknown>);
}

export function buildPendingRedirect(command: TeamInterventionCommand, createdAt: string): TeamPendingRedirect {
  const payload = { ...(command.payload ?? {}) };
  if (!command.note && Object.keys(payload).length === 0) {
    throw new Error('redirect intervention requires note or payload');
  }
  return {
    note: command.note ?? null,
    payload,
    created_at: createdAt,
  };
}

export function buildInjectedAssignmentInput(
  source: {
    owner_role: string;
    stage: number;
  },
  command: TeamInterventionCommand,
): TeamExecutionAssignmentInput {
  const payload = { ...(command.payload ?? {}) };
  return {
    stage: readOptionalStage(payload) ?? source.stage,
    owner_role: readOptionalString(payload, 'owner_role') ?? source.owner_role,
    delegate_role: readString(payload, 'delegate_role'),
    delegate_id: readString(payload, 'delegate_id'),
    task_id: readString(payload, 'task_id'),
    task_kind: readRequiredEnum(payload, 'task_kind', TASK_KINDS),
    handoff_id: readNullableString(payload, 'handoff_id') ?? null,
    handoff_kind: readOptionalEnum(payload, 'handoff_kind', HANDOFF_KINDS) ?? null,
    handoff_payload: readOptionalPayloadObject(payload, 'handoff_payload') ?? null,
    checkpoint_id: readNullableString(payload, 'checkpoint_id') ?? null,
    timeout_at: readOptionalDatetime(payload, 'timeout_at') ?? null,
  };
}

export function renderPendingRedirect(pending: TeamPendingRedirect | null): string | null {
  if (!pending) return null;
  const lines = ['## OPERATOR REDIRECT'];
  if (pending.note) lines.push(pending.note);
  if (Object.keys(pending.payload).length > 0) {
    lines.push('Structured redirect payload:');
    lines.push('```json');
    lines.push(JSON.stringify(pending.payload, null, 2));
    lines.push('```');
  }
  return lines.join('\n\n');
}
