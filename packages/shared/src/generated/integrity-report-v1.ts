/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Scientific integrity assessment report. Aggregates results from multiple IntegrityChecks. Content-addressed via SHA-256 of RFC 8785 (JCS) canonical JSON. Used by RDI fail-closed gate to block publication of unverified assets.
 */
export interface IntegrityReportV1 {
  schema_version: 1;
  /**
   * Content-addressed identifier: SHA-256 hex digest of RFC 8785 (JCS) canonical JSON of this object excluding report_id itself.
   */
  report_id: string;
  /**
   * ArtifactRef V1 of the artifact being checked.
   */
  target_ref: {
    uri: string;
    kind?: string;
    schema_version?: number;
    sha256: string;
    size_bytes?: number;
    produced_by?: string;
    created_at?: string;
    [k: string]: unknown;
  };
  /**
   * Results of individual integrity checks.
   */
  checks: IntegrityCheckResult[];
  /**
   * 'fail' if any blocking check failed. 'advisory_only' if all blocking checks passed but advisory checks have findings. 'pass' if all checks passed.
   */
  overall_status: "pass" | "fail" | "advisory_only";
  /**
   * Check IDs of failed blocking checks. Empty array if overall_status is 'pass' or 'advisory_only'.
   */
  blocking_failures?: string[];
  /**
   * Domain of the checks (e.g., 'hep-th', 'cond-mat', 'mathematics').
   */
  domain: string;
  /**
   * Version of the domain pack used for checks.
   */
  domain_pack_version?: string;
  /**
   * Run in which this report was generated.
   */
  run_id?: string;
  /**
   * Trace ID for cross-layer correlation.
   */
  trace_id?: string;
  /**
   * ISO 8601 UTC Z timestamp of report creation.
   */
  created_at: string;
  /**
   * Total time taken for all checks in milliseconds.
   */
  duration_ms?: number;
}
/**
 * This interface was referenced by `IntegrityReportV1`'s JSON-Schema
 * via the `definition` "IntegrityCheckResult".
 */
export interface IntegrityCheckResult {
  /**
   * Unique identifier of the check (e.g., 'theory_cross_check.invariant_consistency').
   */
  check_id: string;
  /**
   * Human-readable name of the check.
   */
  check_name: string;
  /**
   * 'pass' means check succeeded. 'fail' means check found a problem. 'advisory' means informational finding. 'skipped' means check was not applicable.
   */
  status: "pass" | "fail" | "advisory" | "skipped";
  /**
   * Whether this check is blocking (prevents publication) or advisory (informational).
   */
  severity: "blocking" | "advisory";
  /**
   * Confidence in the check result (0-1).
   */
  confidence?: number;
  /**
   * Supporting evidence for the check result.
   */
  evidence?: Evidence[];
  /**
   * Human-readable explanation of the result.
   */
  message: string;
  /**
   * Suggested remediation if check failed.
   */
  remediation?: string;
  duration_ms?: number;
}
/**
 * This interface was referenced by `IntegrityReportV1`'s JSON-Schema
 * via the `definition` "Evidence".
 */
export interface Evidence {
  /**
   * Type of evidence. V1 covers numerical/computational verification domains. V2 will add 'formal_proof' for mechanized verification workflows (see DESIGN_DEBT.md item 6).
   */
  type:
    | "computation"
    | "reference"
    | "comparison"
    | "limit_check"
    | "statistical";
  /**
   * Optional reference to an artifact containing detailed evidence.
   */
  artifact_ref?: {
    uri?: string;
    sha256?: string;
    size_bytes?: number;
    [k: string]: unknown;
  };
  /**
   * Human-readable description of this evidence.
   */
  description: string;
  /**
   * Structured data specific to the evidence type.
   */
  data?: {
    [k: string]: unknown;
  };
}
