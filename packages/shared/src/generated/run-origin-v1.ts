/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Origin stamp binding one run to the exact code state that produced it. The authoritative copy of this payload is the `stamp` event appended to the project validity ledger; the run-directory `run_origin.json` is a best-effort human-browsable mirror of the same object. The binding_quality ladder is the honesty core: `exact` wording is reserved for the two levels where the recorded commit tree IS the tracked code that ran. Exactness refers to the snapshot object captured at stamp time; runs launched while the same worktree was being edited concurrently are outside this guarantee (one-worktree-per-lane norm).
 */
export interface RunOriginV1 {
  /**
   * Schema discriminator, always run_origin_v1.
   */
  schema_id: "run_origin_v1";
  /**
   * ULID minted ONCE per logical stamp; a retry of the same logical stamp (including cross-process crash recovery via --event-id) reuses it, so ledger readers can deduplicate.
   */
  event_id: string;
  /**
   * Run directory name this stamp binds. Unparseable legacy names are accepted verbatim (slug degrades to the whole name).
   */
  run_id: string;
  /**
   * ISO 8601 UTC instant the stamp was taken. This, not the run_id timestamp, is the machine time truth.
   */
  captured_at_utc: string;
  /**
   * exact_clean: tree clean, code IS baseline_commit. exact_tracked_snapshot: tracked modifications captured as snapshot_commit (tree = snapshot_tree), untracked_count 0. head_plus_untracked: untracked files present — tracked-history identity is baseline_commit (or snapshot_commit when tracked modifications were also present) but the binding is NOT exact; consumers must render outcomes against it as qualified (e.g. current-modulo-untracked), never as unqualified exact/current. aligned_heuristic: retroactive timestamp alignment (backfill) — a heuristic, never presented as exact. unbound: no repository or no alignable identity (no_repo_reason required).
   */
  binding_quality:
    | "exact_clean"
    | "exact_tracked_snapshot"
    | "head_plus_untracked"
    | "aligned_heuristic"
    | "unbound";
  /**
   * Full sha of HEAD at stamp time (null only when unbound).
   */
  baseline_commit: string | null;
  /**
   * Commit object capturing tracked modifications (git stash create semantics; parent = baseline_commit), pinned at refs/nullius/runs/<sanitized-run-id> so gc cannot prune it. Null when the tracked tree was clean. The EFFECTIVE CODE IDENTITY of a run is snapshot_commit ?? baseline_commit.
   */
  snapshot_commit?: string | null;
  /**
   * Tree sha of the snapshot commit (or of baseline_commit when clean). Byte-identical code between two runs is decidable by equality of this field.
   */
  snapshot_tree?: string | null;
  dirty: {
    /**
     * Count of tracked paths differing from baseline_commit, derived FROM the snapshot commit's diff (one object-level operation — no inspect-then-snapshot window).
     */
    tracked_modified: number;
    /**
     * Untracked, non-ignored paths present at stamp time (instantaneous observation). Never auto-ignored and never snapshotted: whether to track or ignore them is an explicit project decision.
     */
    untracked_count: number;
    /**
     * Up to 20 untracked path names for human triage; the run-directory mirror may carry the full list.
     *
     * @maxItems 20
     */
    untracked_sample?:
      | []
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ];
    /**
     * Submodules whose contents differ from their recorded gitlink. Dirty submodule CONTENTS are not captured (known limit); a nonzero count demotes the honesty wording the same way untracked files do.
     */
    submodules_dirty?: number;
  };
  /**
   * Optional dependency-repository commits, keyed by a caller-chosen repository name.
   */
  deps?: {
    [k: string]: string;
  };
  /**
   * Required non-empty when binding_quality is unbound: why no commit identity exists (e.g. project has no git repository; unparseable_run_id with no usable timestamp).
   */
  no_repo_reason?: string | null;
  /**
   * Backfill only: the latest commit at or before the run timestamp. A heuristic binding — rebased or force-pushed history can make it plausible-but-wrong, which is why aligned_heuristic is never rendered as exact.
   */
  aligned_commit?: string | null;
  /**
   * Backfill only: the evidence behind an aligned_heuristic binding.
   */
  alignment?: {
    /**
     * Seconds from the aligned commit to the run timestamp.
     */
    window_prev_s?: number;
    /**
     * Seconds from the run timestamp to the next commit (null when the aligned commit is the newest).
     */
    window_next_s?: number | null;
    /**
     * True when the run_id carries a hand-rounded (nominal) timestamp — alignment confidence is degraded.
     */
    nominal_timestamp?: boolean;
    /**
     * Other commits sharing the boundary timestamp or competing branch tips; non-empty means the alignment choice was not unique.
     */
    ambiguous_candidates?: string[];
  } | null;
  /**
   * True when writing the run-directory mirror failed (e.g. read-only bits on legacy runs). The ledger event remains the truth; backfill never fails on filesystem bits.
   */
  run_dir_unwritable?: boolean;
}
