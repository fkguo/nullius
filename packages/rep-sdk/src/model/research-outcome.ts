import type { ArtifactRef } from './artifact.js';

export type ResearchOutcomeStatus = 'pending' | 'verified' | 'rejected' | 'superseded';
export type ReproducibilityStatus = 'verified' | 'pending' | 'failed' | 'not_applicable';

export interface OutcomeMetric {
  value: unknown;
  uncertainty?: number;
  unit?: string;
  method?: string;
}

export interface RdiScores {
  gate_passed: boolean;
  novelty: number;
  generality: number;
  significance: number;
  citation_impact: number;
  rank_score: number;
}

export interface OutcomeProducer {
  agent_id: string;
  run_id?: string;
  tool_versions?: Record<string, string>;
}

export interface ResearchOutcome {
  schema_version: 1;
  outcome_id: string;
  lineage_id: string;
  version: number;
  strategy_ref: string;
  status: ResearchOutcomeStatus;
  metrics: Record<string, OutcomeMetric>;
  artifacts: ArtifactRef[];
  integrity_report_ref?: string;
  reproducibility_report_ref?: string;
  reproducibility_status?: ReproducibilityStatus;
  confidence?: number;
  rdi_scores?: RdiScores;
  applicability_range?: Record<string, { min?: number; max?: number; unit?: string }>;
  produced_by: OutcomeProducer;
  created_at: string;
  supersedes?: string;
  superseded_by?: string;
  tags?: string[];
}
