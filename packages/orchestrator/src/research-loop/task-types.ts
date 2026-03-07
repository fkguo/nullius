export type ResearchEventSource = 'user' | 'agent' | 'system';

export type ResearchTaskKind =
  | 'literature'
  | 'idea'
  | 'compute'
  | 'evidence_search'
  | 'finding'
  | 'draft_update'
  | 'review';

export type ResearchTaskStatus = 'pending' | 'active' | 'completed' | 'blocked' | 'cancelled';

export interface ResearchTaskInput {
  kind: ResearchTaskKind;
  title: string;
  target_node_id: string;
  /** Audit source for the task request or registration event. */
  source: ResearchEventSource;
  /** Nullable principal identifier when the source is not attributable to a concrete actor. */
  actor_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ResearchTask extends ResearchTaskInput {
  task_id: string;
  status: ResearchTaskStatus;
  parent_task_id: string | null;
  created_at: string;
  updated_at: string;
  actor_id: string | null;
}
