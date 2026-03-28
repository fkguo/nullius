import type { ArtifactRef } from './artifact.js';

export type VerificationCheckPriority = 'low' | 'medium' | 'high';

export type VerificationSubjectKind =
  | 'claim'
  | 'result'
  | 'deliverable'
  | 'acceptance_test'
  | 'reference_action'
  | 'forbidden_proxy'
  | 'comparison_target';

export type VerificationSubjectVerdictStatus =
  | 'verified'
  | 'partial'
  | 'failed'
  | 'blocked'
  | 'not_attempted';

export type ReproducibilityProjectionStatus = 'verified' | 'pending' | 'failed' | 'blocked';
export type VerificationIntegrityStatus =
  | 'decisive_verification_complete'
  | 'pending_decisive_verification'
  | 'blocked_by_execution_failure'
  | 'decisive_verification_failed';
export type VerificationGateDecision = 'pass' | 'hold' | 'block';

export interface VerificationLinkedIdentifier {
  id_kind: string;
  id_value: string;
}

export interface MissingDecisiveCheck {
  check_kind: string;
  reason: string;
  priority: VerificationCheckPriority;
}

export interface VerificationSubject {
  schema_version: 1;
  subject_id: string;
  subject_kind: VerificationSubjectKind;
  run_id: string;
  title: string;
  description?: string;
  source_refs: ArtifactRef[];
  linked_identifiers?: VerificationLinkedIdentifier[];
}

export interface VerificationSubjectVerdict {
  schema_version: 1;
  verdict_id: string;
  run_id: string;
  subject_id: string;
  subject_ref: ArtifactRef;
  status: VerificationSubjectVerdictStatus;
  summary: string;
  check_run_refs: ArtifactRef[];
  missing_decisive_checks: MissingDecisiveCheck[];
}

export interface VerificationCoverageSummary {
  subjects_total: number;
  subjects_verified: number;
  subjects_partial: number;
  subjects_failed: number;
  subjects_blocked: number;
  subjects_not_attempted: number;
}

export interface VerificationCoverageGap extends MissingDecisiveCheck {
  subject_id: string;
  subject_ref: ArtifactRef;
}

export interface VerificationCoverage {
  schema_version: 1;
  coverage_id: string;
  run_id: string;
  generated_at: string;
  subject_refs: ArtifactRef[];
  subject_verdict_refs: ArtifactRef[];
  summary: VerificationCoverageSummary;
  missing_decisive_checks: VerificationCoverageGap[];
}

export interface ReproducibilityProjectionRefs {
  subject: ArtifactRef;
  subject_verdict: ArtifactRef;
  coverage: ArtifactRef;
}

export interface VerificationIntegritySemantics {
  status: VerificationIntegrityStatus;
  gate_decision: VerificationGateDecision;
  summary: string;
}

export interface ReproducibilityProjection {
  source: 'verification_kernel_v1';
  run_id: string;
  subject_id: string;
  subject_kind: VerificationSubjectKind;
  subject_title: string;
  verdict_status: VerificationSubjectVerdictStatus;
  reproducibility_status: ReproducibilityProjectionStatus;
  summary: string;
  decisive_check_missing: boolean;
  missing_decisive_checks: MissingDecisiveCheck[];
  coverage_summary: VerificationCoverageSummary;
  integrity: VerificationIntegritySemantics;
  refs: ReproducibilityProjectionRefs;
}
