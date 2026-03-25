export type ResearchSignalType =
  | 'gap_detected'
  | 'calculation_divergence'
  | 'known_result_match'
  | 'integrity_violation'
  | 'method_plateau'
  | 'parameter_sensitivity'
  | 'cross_check_opportunity'
  | 'stagnation';

export type ResearchSignalPriority = 'critical' | 'high' | 'medium' | 'low';

export interface GapDetectedPayload {
  gap_description: string;
  domain_area: string;
  related_literature?: Array<{
    record_id: string;
    source: string;
    title?: string;
    similarity_score?: number;
    matched_quantities?: string[];
  }>;
  estimated_impact?: 'high' | 'medium' | 'low';
}

export interface CalculationDivergencePayload {
  outcome_a_ref: string;
  outcome_b_ref: string;
  divergent_quantities: Array<{
    name: string;
    value_a: number;
    value_b: number;
    relative_deviation: number;
  }>;
  deviation_report_ref?: string;
}

export interface KnownResultMatchPayload {
  outcome_ref: string;
  matching_literature: Array<{
    record_id: string;
    source: string;
    title?: string;
    similarity_score: number;
    matched_quantities?: string[];
  }>;
}

export interface IntegrityViolationPayload {
  integrity_report_ref: string;
  failed_checks: Array<{
    check_id: string;
    severity: 'blocking' | 'advisory';
    message?: string;
  }>;
}

export interface MethodPlateauPayload {
  current_method: string;
  cycles_without_improvement: number;
  best_achieved_metric?: string;
  suggested_alternatives?: string[];
}

export interface ParameterSensitivityPayload {
  parameter_name: string;
  sensitivity_measure: number;
  parameter_range_tested?: { min?: number; max?: number };
  affected_quantities?: string[];
}

export interface CrossCheckOpportunityPayload {
  new_outcome_ref: string;
  existing_outcome_refs: string[];
  cross_check_type?: string;
}

export interface StagnationPayload {
  consecutive_empty_cycles: number;
  threshold: number;
  current_strategy?: string;
  last_productive_cycle?: string;
  recommended_action?: 'switch_strategy' | 'abandon_direction' | 'request_guidance';
}

interface ResearchSignalBase<TType extends ResearchSignalType, TPayload> {
  schema_version: 1;
  signal_id: string;
  signal_type: TType;
  source_event_ids: string[];
  fingerprint: string;
  confidence: number;
  priority: ResearchSignalPriority;
  payload: TPayload;
  detected_at: string;
  expires_at?: string;
  run_id?: string;
  suppressed?: boolean;
}

export type ResearchSignal =
  | ResearchSignalBase<'gap_detected', GapDetectedPayload>
  | ResearchSignalBase<'calculation_divergence', CalculationDivergencePayload>
  | ResearchSignalBase<'known_result_match', KnownResultMatchPayload>
  | ResearchSignalBase<'integrity_violation', IntegrityViolationPayload>
  | ResearchSignalBase<'method_plateau', MethodPlateauPayload>
  | ResearchSignalBase<'parameter_sensitivity', ParameterSensitivityPayload>
  | ResearchSignalBase<'cross_check_opportunity', CrossCheckOpportunityPayload>
  | ResearchSignalBase<'stagnation', StagnationPayload>;
