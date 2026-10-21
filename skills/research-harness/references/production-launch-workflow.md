# Production Launch Authorization (A3 Preflight)

Read the section relevant to the current operation. Commands and script paths are relative to the installed `research-harness` skill directory unless an external project root is specified.

## Production Launch Authorization (A3 Preflight)

Adopt this preflight when a project is about to start a **large production run** — a computation whose output will be trusted downstream and whose cost makes "rerun it under the corrected conditions" expensive. It machine-decides whether the launch preconditions actually hold, instead of trusting the agent's recollection that they do. Freeze the plan at the granularity of the production run it authorizes: a frozen plan is for launches, not for development iteration — routing every in-progress edit through a hash-frozen plan voids review verdicts on every keystroke and turns the preflight into a per-patch re-review loop. It targets three observed AI failure modes:

1. A missing or timed-out review silently treated as consent — silence read as a green light.
2. A plan modified after review still riding on the old verdict — the review approved a different plan than the one about to run.
3. An execution environment (code version, solver build, key dependencies) that differs from the one the review actually covered.

The discipline, all machine-checked and all required:

1. **Frozen plan.** The authorization record registers the production plan's content hash (SHA-256); the live plan file must hash to exactly that value.
2. **Review verdicts bound to the plan hash.** Each independent review verdict file states the hash of the plan it reviewed; an approval counts only when that hash equals the live plan hash. Editing the plan after review voids the old verdict — the refusal is `stale_review`.
3. **Reviewer unavailability is never approval.** Whoever runs the review must record a timed-out or errored reviewer with verdict `unavailable`; that entry never counts toward the quorum. An absent verdict file refuses as `missing_review`. When the quorum is met by genuine hash-bound approvals, an unavailable extra reviewer is not a veto — it just never counts as a yes.
4. **Exact environment fingerprint.** The record registers the fingerprint of the reviewed environment as string key-value pairs; the launcher supplies the fingerprint it observes at launch time; the two must be exactly, symmetrically equal — any missing key on either side or any unequal value refuses with `fingerprint_mismatch`. String-typed values on both sides keep semantically equal numbers from diverging by representation.

Any unmet precondition makes the checker exit non-zero, so a launcher chained on it produces **zero production output** on refusal.

**Artifacts** (all domain-neutral JSON; commit them like any other run evidence, recommended under `artifacts/runs/<run_id>/`):

```json
{
  "record_version": 1,
  "plan_path": "artifacts/runs/<run_id>/production_plan.md",
  "plan_sha256": "<64 lowercase hex of the frozen plan content>",
  "required_approvals": 1,
  "reviews": [
    {"reviewer": "reviewer-one", "verdict_path": "artifacts/runs/<run_id>/reviews/reviewer-one.json"}
  ],
  "environment_fingerprint": {
    "code_commit": "<git commit of the production code>",
    "solver_version": "9.9.1",
    "dependency_lock_sha256": "<hash of the committed lockfile>"
  }
}
```

Each review verdict file (written by whoever ran that review, after the plan hash was frozen):

```json
{"verdict_version": 1, "reviewer": "reviewer-one", "verdict": "approved",
 "reviewed_plan_sha256": "<the plan hash this reviewer actually reviewed>"}
```

`verdict` is one of `approved`, `changes_needed`, `unavailable`; the bound hash is mandatory for the first two (an unbound approval never counts). The launcher produces the observed fingerprint as a flat JSON object of string values — typically from `git rev-parse HEAD`, the solver's version query, and the lockfile hash — then runs:

```bash
python3 scripts/check_launch_authorization.py \
    --record artifacts/runs/<run_id>/launch_authorization_record.json \
    --observed-fingerprint /tmp/observed_fingerprint.json \
    --output artifacts/runs/<run_id>/launch_authorization.json \
  && exec <production command>
```

The record's relative paths resolve against `--project-root`, which defaults to the git toplevel enclosing the record; a project outside git must pass `--project-root` explicitly.

Read [`references/launch-authorization.md`](launch-authorization.md) when a launch-authorization refusal or verdict needs explaining (the default-refuse semantics bullets, moved there verbatim).

This preflight is the machine arm of the A3 (`compute_runs`) gate — the shared gate registry's A3 policy names `launch_authorization_v1` as its result contract, so launchers know what to produce. The enforcement locus is the **project-side launcher**: chain the checker before the production command as shown above; the engine's bounded-computation runner does not invoke it. In projects using the engine's approval flow, `nullius approve <A3-...>` records the *human* go-ahead; this preflight checks the *technical* launch preconditions at the moment of launch. They are complementary: neither substitutes for the other.
