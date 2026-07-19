/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Machine-decided preflight verdict for starting a large production run. Authorization holds only when every precondition is demonstrated: the frozen plan's content hash is registered and matches the live plan file, at least the required number of independent review verdicts are bound to exactly that hash, and the live execution-environment fingerprint equals the fingerprint registered at authorization time. Any missing or mismatched precondition refuses the launch with a falsification-labeled verdict; a reviewer recorded as unavailable never counts as an approval.
 */
export interface LaunchAuthorizationResultV1 {
  schema_id: "launch_authorization_v1";
  schema_version: 1;
  /**
   * authorized only when every check passes. Refusal verdicts name what was falsified: invalid_record (authorization record missing/malformed, including an impossible quorum), missing_plan_hash (no registered plan hash, or the plan file is missing/unreadable), stale_review (the live plan content differs from the hash the record and/or the review verdicts bound — the plan changed after authorization or review), missing_review (a listed review verdict is absent, unreadable, malformed, or attributed to a different reviewer), review_rejected (a reviewer returned changes_needed and the quorum is not met), reviewer_unavailable (a reviewer was explicitly recorded unavailable and the quorum is not met — unavailability is never approval), fingerprint_mismatch (the observed execution-environment fingerprint is not exactly equal to the registered one).
   */
  verdict:
    | "authorized"
    | "invalid_record"
    | "missing_plan_hash"
    | "stale_review"
    | "missing_review"
    | "review_rejected"
    | "reviewer_unavailable"
    | "fingerprint_mismatch";
  /**
   * Convenience boolean for launchers; true exactly when verdict is authorized.
   */
  launch_authorized: boolean;
  /**
   * 0 only for authorized; 2 for invalid_record (unusable authorization record); 3 for every other refusal.
   */
  exit_code: 0 | 2 | 3;
  generated_at: string;
  /**
   * Path of the authorization record that was evaluated.
   */
  record_path?: string;
  /**
   * SHA-256 of the authorization record bytes, for audit.
   */
  record_sha256?: string | null;
  /**
   * Approval quorum declared by the record (0 only when the record itself was invalid).
   */
  required_approvals: number;
  /**
   * Number of review verdicts that counted as approvals: verdict approved AND reviewed_plan_sha256 exactly equal to the live plan hash.
   */
  approvals_counted: number;
  plan: {
    /**
     * Plan path as declared by the record (project-root-relative).
     */
    path: string | null;
    /**
     * Plan content hash frozen in the authorization record.
     */
    registered_sha256: string | null;
    /**
     * SHA-256 of the plan file as read at preflight time.
     */
    live_sha256: string | null;
  };
  reviews: {
    reviewer: string;
    verdict_path?: string;
    /**
     * Observed state of this review at preflight time. approved/changes_needed/unavailable come from the verdict file; missing means the file is absent or unreadable; invalid means the file exists but is malformed, unbound, or attributed to a different reviewer.
     */
    verdict:
      | "approved"
      | "changes_needed"
      | "unavailable"
      | "missing"
      | "invalid";
    /**
     * Plan hash the verdict file states it reviewed; null when absent.
     */
    reviewed_plan_sha256: string | null;
    /**
     * True only for verdict approved with reviewed_plan_sha256 exactly equal to the live plan hash. Unavailability, rejection, malformation, or a stale bound hash never count.
     */
    counts_as_approval: boolean;
    detail: string;
  }[];
  fingerprint: {
    /**
     * Environment fingerprint registered at authorization time (string values only, so semantically equal values cannot diverge by representation).
     */
    expected: {
      [k: string]: string;
    } | null;
    /**
     * Environment fingerprint observed at the launch site.
     */
    observed: {
      [k: string]: string;
    } | null;
    /**
     * True only for exact symmetric equality: identical key sets and identical string values.
     */
    equal: boolean;
    /**
     * Keys missing on either side or carrying unequal values.
     */
    mismatched_keys: string[];
  };
  checks: {
    check_id: "plan_frozen" | "review_binding" | "fingerprint_match";
    /**
     * not_evaluated appears only after an earlier check already refused the launch; it is never a pass.
     */
    status: "pass" | "fail" | "not_evaluated";
    detail: string;
  }[];
  errors: string[];
}
