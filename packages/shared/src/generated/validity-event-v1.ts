/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * supersede: run_id's result is replaced by by_run_id's (reason required). void: run_id's result no longer counts, with no replacement (reason required). reinstate: reverses the last full-scope negative event on run_id (reason required). stamp: origin binding for run_id (payload in `stamp`; also how backfill records land). attempt: execution history, never a validity ruling — closes a resultless execution attempt of run_id (payload in `attempt`, reason required) and, when the payload embeds an origin, atomically opens the next attempt with a fresh launch-time code capture.
 *
 * This interface was referenced by `ValidityEventV1`'s JSON-Schema
 * via the `definition` "EventType".
 */
export type EventType =
  | "supersede"
  | "void"
  | "reinstate"
  | "stamp"
  | "attempt";
/**
 * Origin stamp binding one run to the exact code state that produced it. The authoritative copy of this payload is the `stamp` event appended to the project validity ledger; the run-directory `run_origin.json` is a best-effort human-browsable mirror of the same object. The binding_quality ladder is the honesty core: `exact` wording is reserved for the two levels where the recorded commit tree IS the tracked code that ran. Exactness refers to the snapshot object captured at stamp time; runs launched while the same worktree was being edited concurrently are outside this guarantee (one-worktree-per-lane norm).
 */
export type RunOriginV1 = {
  [k: string]: unknown;
};
/**
 * Origin stamp binding one run to the exact code state that produced it. The authoritative copy of this payload is the `stamp` event appended to the project validity ledger; the run-directory `run_origin.json` is a best-effort human-browsable mirror of the same object. The binding_quality ladder is the honesty core: `exact` wording is reserved for the two levels where the recorded commit tree IS the tracked code that ran. Exactness refers to the snapshot object captured at stamp time; runs launched while the same worktree was being edited concurrently are outside this guarantee (one-worktree-per-lane norm).
 */
export type RunOriginV11 = {
  [k: string]: unknown;
};

/**
 * One line of the project validity ledger (artifacts/runs/validity_ledger.jsonl): the append-only record separating result VALIDITY (does this run's result still count) from execution status (did it finish). Events are never rewritten; supersession is declared by the NEW run's author (new-to-old direction) and the reverse direction is derived at read time. Effective order is always re-derived from (ts_utc, event_id), never from line position, which makes git merge=union safe for this file. Readers deduplicate by event_id under canonical-JSON equality; two lines sharing an event_id with different payloads are a fail-closed ledger-integrity defect (affected runs classify at the worst candidate state: void > superseded > active).
 */
export interface ValidityEventV1 {
  /**
   * Schema discriminator, always validity_event_v1.
   */
  schema_id: "validity_event_v1";
  /**
   * ULID minted once per logical event; retries (including cross-process crash recovery via --event-id) reuse it so readers can deduplicate after union merges.
   */
  event_id: string;
  event: EventType;
  /**
   * The run this event is ABOUT (for supersede: the OLD run being superseded).
   */
  run_id: string;
  /**
   * supersede only: the NEW run whose result replaces run_id. superseded_by is derived at read time from these events; old run directories are never edited.
   */
  by_run_id?: string | null;
  /**
   * "full" (default) is the ONLY scope that changes a run's effective validity (last full-scope event wins). Any other non-empty value is a named partial scope (e.g. a budget-only supersession): it accumulates as an annotation on the run and never changes overall validity. reinstate applies to full scope only.
   */
  scope?: string;
  /**
   * Required non-empty prose for supersede and void: WHY the result no longer counts. The measured real-project practice (withdrawal_reason, supersedes.reason) standardized, not invented.
   */
  reason?: string | null;
  /**
   * Agent or human identity appending the event.
   */
  actor: string;
  /**
   * ISO 8601 UTC timestamp; with event_id it defines the deterministic replay order.
   */
  ts_utc: string;
  stamp?: RunOriginV1;
  attempt?: AttemptRecord;
}
/**
 * attempt events only.
 */
export interface AttemptRecord {
  /**
   * The attempt ordinal being closed (the initial stamp is ordinal 1). Explicit — chain logic never keys on sub-millisecond event order.
   */
  closes_ordinal: number;
  /**
   * failed: execution evidence records failure. missing: the stamp predates the source/status that never materialized (self-heal; never counts against attempt budgets). stalled: declared stall of a long execution. declared_no_result: operator declaration where no machine evidence exists (visibly second-class).
   */
  previous_outcome: "failed" | "missing" | "stalled" | "declared_no_result";
  evidence: {
    /**
     * execution_status and outputs_scan are machine-verified; declared is an operator claim and is surfaced second-class everywhere.
     */
    method: "execution_status" | "outputs_scan" | "declared";
    detail: string;
    /**
     * SHA-256 of the execution-status file backing a failed/completed determination, chaining the ruling to the runner's own record.
     */
    execution_status_sha256?: string;
    exit_code?: number;
    quarantined_paths_count?: number;
  };
  /**
   * Run-relative directory the prior attempt's residue was archived into (never deleted), or null when the surface was already clean.
   */
  quarantined_to: string | null;
  /**
   * The event that opened the attempt being closed (the initial stamp event for ordinal 1). Skew-immune predecessor binding alongside the explicit ordinal.
   */
  supersedes_attempt_event: string | null;
  /**
   * The NEXT attempt's full origin payload (attempt_ordinal = closes_ordinal + 1), captured fresh at ITS launch; null records the closure without opening a retry (abandonment bookkeeping).
   */
  origin: RunOriginV11 | null;
}
/**
 * attempt events only: closure of a resultless execution attempt, with machine evidence, and optionally the NEXT attempt's embedded origin (one atomic event — a silent rebind of a run id is unrepresentable because a new binding can only ride inside a closure).
 *
 * This interface was referenced by `ValidityEventV1`'s JSON-Schema
 * via the `definition` "AttemptRecord".
 */
export interface AttemptRecord1 {
  /**
   * The attempt ordinal being closed (the initial stamp is ordinal 1). Explicit — chain logic never keys on sub-millisecond event order.
   */
  closes_ordinal: number;
  /**
   * failed: execution evidence records failure. missing: the stamp predates the source/status that never materialized (self-heal; never counts against attempt budgets). stalled: declared stall of a long execution. declared_no_result: operator declaration where no machine evidence exists (visibly second-class).
   */
  previous_outcome: "failed" | "missing" | "stalled" | "declared_no_result";
  evidence: {
    /**
     * execution_status and outputs_scan are machine-verified; declared is an operator claim and is surfaced second-class everywhere.
     */
    method: "execution_status" | "outputs_scan" | "declared";
    detail: string;
    /**
     * SHA-256 of the execution-status file backing a failed/completed determination, chaining the ruling to the runner's own record.
     */
    execution_status_sha256?: string;
    exit_code?: number;
    quarantined_paths_count?: number;
  };
  /**
   * Run-relative directory the prior attempt's residue was archived into (never deleted), or null when the surface was already clean.
   */
  quarantined_to: string | null;
  /**
   * The event that opened the attempt being closed (the initial stamp event for ordinal 1). Skew-immune predecessor binding alongside the explicit ordinal.
   */
  supersedes_attempt_event: string | null;
  /**
   * The NEXT attempt's full origin payload (attempt_ordinal = closes_ordinal + 1), captured fresh at ITS launch; null records the closure without opening a retry (abandonment bookkeeping).
   */
  origin: RunOriginV11 | null;
}
