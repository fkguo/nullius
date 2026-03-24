export type ResearchEventType =
  | 'strategy_proposed'
  | 'strategy_selected'
  | 'strategy_rejected'
  | 'computation_started'
  | 'computation_completed'
  | 'computation_failed'
  | 'verification_started'
  | 'verification_passed'
  | 'verification_failed'
  | 'outcome_published'
  | 'outcome_superseded'
  | 'outcome_revoked'
  | 'integrity_check_started'
  | 'integrity_check_completed'
  | 'signal_detected'
  | 'stagnation_detected'
  | 'diagnostic_emitted';

export interface ResearchEvent {
  schema_version: 1;
  event_id: string;
  event_type: ResearchEventType;
  timestamp: string;
  run_id: string;
  trace_id?: string;
  sequence_number?: number;
  payload: Record<string, unknown>;
}
