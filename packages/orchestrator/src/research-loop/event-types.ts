import type { ResearchEventSource } from './task-types.js';

export type ResearchEventType =
  | 'task_created'
  | 'task_injected'
  | 'task_followup_created'
  | 'task_status_changed'
  | 'handoff_registered'
  | 'checkpoint_created'
  | 'checkpoint_restored'
  | 'intervention_recorded';

export interface ResearchEvent {
  event_id: string;
  event_type: ResearchEventType;
  created_at: string;
  source: ResearchEventSource;
  actor_id: string | null;
  task_id: string | null;
  checkpoint_id: string | null;
  handoff_id: string | null;
  payload: Record<string, unknown>;
}

export type LoopInterventionKind = 'pause' | 'resume' | 'redirect' | 'inject_task' | 'approve' | 'cancel' | 'cascade_stop';

export interface LoopIntervention {
  intervention_id: string;
  intervention_kind: LoopInterventionKind;
  created_at: string;
  source: ResearchEventSource;
  actor_id: string | null;
  payload: Record<string, unknown>;
}
