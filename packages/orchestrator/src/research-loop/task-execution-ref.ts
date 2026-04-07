import type { ResearchHandoff } from './handoff-types.js';
import type { ResearchTask, ResearchTaskKind } from './task-types.js';

export interface ResearchTaskExecutionRef {
  task_id: string;
  task_kind: ResearchTaskKind;
  target_node_id: string | null;
  parent_task_id: string | null;
  workspace_id: string;
  handoff_id: string | null;
  handoff_kind: ResearchHandoff['handoff_kind'] | null;
  source_task_id: string | null;
}

type TaskRefCarrier = Pick<ResearchTask, 'task_id' | 'kind' | 'target_node_id' | 'parent_task_id'>;
type HandoffRefCarrier = Pick<ResearchHandoff, 'handoff_id' | 'handoff_kind' | 'source_task_id'>;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isResearchTaskExecutionRef(value: unknown): value is ResearchTaskExecutionRef {
  if (!isObjectRecord(value)) return false;
  return typeof value.task_id === 'string'
    && typeof value.task_kind === 'string'
    && (typeof value.target_node_id === 'string' || value.target_node_id === null)
    && (typeof value.parent_task_id === 'string' || value.parent_task_id === null)
    && typeof value.workspace_id === 'string'
    && (typeof value.handoff_id === 'string' || value.handoff_id === null)
    && (typeof value.handoff_kind === 'string' || value.handoff_kind === null)
    && (typeof value.source_task_id === 'string' || value.source_task_id === null);
}

export function cloneResearchTaskExecutionRef(
  ref: ResearchTaskExecutionRef | null | undefined,
): ResearchTaskExecutionRef | null {
  if (!ref) return null;
  return {
    task_id: ref.task_id,
    task_kind: ref.task_kind,
    target_node_id: ref.target_node_id,
    parent_task_id: ref.parent_task_id,
    workspace_id: ref.workspace_id,
    handoff_id: ref.handoff_id,
    handoff_kind: ref.handoff_kind,
    source_task_id: ref.source_task_id,
  };
}

export function buildResearchTaskExecutionRef(params: {
  workspace_id: string;
  task?: TaskRefCarrier;
  task_id?: string;
  task_kind?: ResearchTaskKind;
  target_node_id?: string | null;
  parent_task_id?: string | null;
  handoff?: HandoffRefCarrier | null;
  handoff_id?: string | null;
  handoff_kind?: ResearchHandoff['handoff_kind'] | null;
  source_task_id?: string | null;
}): ResearchTaskExecutionRef {
  const taskId = params.task?.task_id ?? params.task_id;
  const taskKind = params.task?.kind ?? params.task_kind;
  if (!taskId || !taskKind) {
    throw new Error('research task execution ref requires task identity');
  }
  return {
    task_id: taskId,
    task_kind: taskKind,
    target_node_id: params.task?.target_node_id ?? params.target_node_id ?? null,
    parent_task_id: params.task?.parent_task_id ?? params.parent_task_id ?? null,
    workspace_id: params.workspace_id,
    handoff_id: params.handoff?.handoff_id ?? params.handoff_id ?? null,
    handoff_kind: params.handoff?.handoff_kind ?? params.handoff_kind ?? null,
    source_task_id: params.handoff?.source_task_id ?? params.source_task_id ?? null,
  };
}
