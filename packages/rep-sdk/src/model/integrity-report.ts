import type { ArtifactRef } from './artifact.js';

export type IntegrityOverallStatus = 'pass' | 'fail' | 'advisory_only';
export type IntegrityCheckStatus = 'pass' | 'fail' | 'advisory' | 'skipped';
export type IntegrityCheckSeverity = 'blocking' | 'advisory';
export type IntegrityEvidenceType =
  | 'computation'
  | 'reference'
  | 'comparison'
  | 'limit_check'
  | 'statistical';

export interface IntegrityEvidence {
  type: IntegrityEvidenceType;
  artifact_ref?: Partial<ArtifactRef>;
  description: string;
  data?: Record<string, unknown>;
}

export interface IntegrityCheckResult {
  check_id: string;
  check_name: string;
  status: IntegrityCheckStatus;
  severity: IntegrityCheckSeverity;
  confidence?: number;
  evidence?: IntegrityEvidence[];
  message: string;
  remediation?: string;
  duration_ms?: number;
}

export interface IntegrityReport {
  schema_version: 1;
  report_id: string;
  target_ref: ArtifactRef;
  checks: IntegrityCheckResult[];
  overall_status: IntegrityOverallStatus;
  blocking_failures?: string[];
  domain: string;
  domain_pack_version?: string;
  run_id?: string;
  trace_id?: string;
  created_at: string;
  duration_ms?: number;
}
