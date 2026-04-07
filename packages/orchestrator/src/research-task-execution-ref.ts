import { utcNowIso } from './util.js';
import {
  buildResearchTaskExecutionRef,
  cloneResearchTaskExecutionRef,
  type ResearchTaskExecutionRef,
} from './research-loop/task-execution-ref.js';
import type { TeamExecutionState } from './team-execution-types.js';

export interface ResearchTaskExecutionRefRegistry {
  schema_version: 1;
  run_id: string;
  refs_by_task_id: Record<string, ResearchTaskExecutionRef>;
  refs_by_assignment_id: Record<string, ResearchTaskExecutionRef>;
  refs_by_checkpoint_id: Record<string, ResearchTaskExecutionRef>;
  refs_by_session_id: Record<string, ResearchTaskExecutionRef>;
  updated_at: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneIfValid(value: unknown): ResearchTaskExecutionRef | null {
  if (!value || !isObjectRecord(value)) return null;
  return cloneResearchTaskExecutionRef(value as unknown as ResearchTaskExecutionRef);
}

export function createResearchTaskExecutionRefRegistry(
  runId: string,
  updatedAt: string = utcNowIso(),
): ResearchTaskExecutionRefRegistry {
  return {
    schema_version: 1,
    run_id: runId,
    refs_by_task_id: {},
    refs_by_assignment_id: {},
    refs_by_checkpoint_id: {},
    refs_by_session_id: {},
    updated_at: updatedAt,
  };
}

export function normalizeResearchTaskExecutionRefRegistry(
  runId: string,
  value: unknown,
): ResearchTaskExecutionRefRegistry {
  if (!isObjectRecord(value)) {
    return createResearchTaskExecutionRefRegistry(runId);
  }
  const refsByTaskId = isObjectRecord(value.refs_by_task_id) ? value.refs_by_task_id : {};
  const refsByAssignmentId = isObjectRecord(value.refs_by_assignment_id) ? value.refs_by_assignment_id : {};
  const refsByCheckpointId = isObjectRecord(value.refs_by_checkpoint_id) ? value.refs_by_checkpoint_id : {};
  const refsBySessionId = isObjectRecord(value.refs_by_session_id) ? value.refs_by_session_id : {};
  return {
    schema_version: 1,
    run_id: typeof value.run_id === 'string' ? value.run_id : runId,
    refs_by_task_id: Object.fromEntries(
      Object.entries(refsByTaskId)
        .map(([key, ref]) => [key, cloneIfValid(ref)])
        .filter((entry): entry is [string, ResearchTaskExecutionRef] => entry[1] !== null),
    ),
    refs_by_assignment_id: Object.fromEntries(
      Object.entries(refsByAssignmentId)
        .map(([key, ref]) => [key, cloneIfValid(ref)])
        .filter((entry): entry is [string, ResearchTaskExecutionRef] => entry[1] !== null),
    ),
    refs_by_checkpoint_id: Object.fromEntries(
      Object.entries(refsByCheckpointId)
        .map(([key, ref]) => [key, cloneIfValid(ref)])
        .filter((entry): entry is [string, ResearchTaskExecutionRef] => entry[1] !== null),
    ),
    refs_by_session_id: Object.fromEntries(
      Object.entries(refsBySessionId)
        .map(([key, ref]) => [key, cloneIfValid(ref)])
        .filter((entry): entry is [string, ResearchTaskExecutionRef] => entry[1] !== null),
    ),
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : utcNowIso(),
  };
}

export function upsertResearchTaskExecutionRef(
  registry: ResearchTaskExecutionRefRegistry,
  ref: ResearchTaskExecutionRef,
  keys: {
    assignment_id?: string | null;
    checkpoint_id?: string | null;
    session_id?: string | null;
  } = {},
  updatedAt: string = utcNowIso(),
): ResearchTaskExecutionRefRegistry {
  const cloned = cloneResearchTaskExecutionRef(ref)!;
  registry.refs_by_task_id[cloned.task_id] = cloned;
  if (keys.assignment_id) registry.refs_by_assignment_id[keys.assignment_id] = cloneResearchTaskExecutionRef(cloned)!;
  if (keys.checkpoint_id) registry.refs_by_checkpoint_id[keys.checkpoint_id] = cloneResearchTaskExecutionRef(cloned)!;
  if (keys.session_id) registry.refs_by_session_id[keys.session_id] = cloneResearchTaskExecutionRef(cloned)!;
  registry.updated_at = updatedAt;
  return registry;
}

export function resolveResearchTaskExecutionRef(
  registry: ResearchTaskExecutionRefRegistry | null,
  lookup: {
    task_id?: string | null;
    assignment_id?: string | null;
    checkpoint_id?: string | null;
    session_id?: string | null;
  },
): ResearchTaskExecutionRef | null {
  if (!registry) return null;
  return cloneResearchTaskExecutionRef(
    (lookup.session_id ? registry.refs_by_session_id[lookup.session_id] : null)
    ?? (lookup.checkpoint_id ? registry.refs_by_checkpoint_id[lookup.checkpoint_id] : null)
    ?? (lookup.assignment_id ? registry.refs_by_assignment_id[lookup.assignment_id] : null)
    ?? (lookup.task_id ? registry.refs_by_task_id[lookup.task_id] : null),
  );
}

export function buildResearchTaskExecutionRefFromAssignment(
  state: Pick<TeamExecutionState, 'workspace_id'>,
  assignment: Pick<
    TeamExecutionState['delegate_assignments'][number],
    'task_id' | 'task_kind' | 'handoff_id' | 'handoff_kind'
  >,
): ResearchTaskExecutionRef {
  return buildResearchTaskExecutionRef({
    workspace_id: state.workspace_id,
    task_id: assignment.task_id,
    task_kind: assignment.task_kind,
    handoff_id: assignment.handoff_id,
    handoff_kind: assignment.handoff_kind,
  });
}

export function syncResearchTaskExecutionRefRegistryFromState(
  registry: ResearchTaskExecutionRefRegistry,
  state: TeamExecutionState,
  updatedAt: string = utcNowIso(),
): ResearchTaskExecutionRefRegistry {
  for (const assignment of state.delegate_assignments) {
    const ref = resolveResearchTaskExecutionRef(registry, {
      assignment_id: assignment.assignment_id,
      task_id: assignment.task_id,
    }) ?? buildResearchTaskExecutionRefFromAssignment(state, assignment);
    upsertResearchTaskExecutionRef(registry, ref, {
      assignment_id: assignment.assignment_id,
      checkpoint_id: assignment.checkpoint_id,
      session_id: assignment.session_id,
    }, updatedAt);
  }
  return registry;
}
