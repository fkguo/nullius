Command, script and asset paths in this reference are relative to the `research-team` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

## Non-negotiable contracts (fail-fast)

- **Strict convergence, severity-graded**: if either member reports mismatch/fail/needs revision, you must fix and rerun until converged (or explicitly narrow/kill as `SCOPE`/`MATCHING`). Review findings carry a severity grade, and only the top grade blocks by itself:
  - **Blocking**: the finding changes a recorded result, invalidates a verification claim, breaks input identity / target-value isolation / origin traceability, is a mismatch/fail inside the declared reproduction scope, or is a Major Gap inside the declared scope (a load-bearing item that cannot be verified from the packet, or required evidence that is missing). Convergence requires every blocking finding fixed and re-reviewed.
  - **Non-blocking** (hardening beyond the declared scope, mutation-style test-strengthening ideas, style): reported under Minor Issues, never flipping the verdict by itself. Each non-blocking finding gets an explicit disposition in the adjudication — fix now, attach to a named later acceptance point, or discard with a stated reason — never a silent drop and never an undated "later". This is machine-enforced at the fold boundary: the convergence result carries per-member `minor_issues_count`, and `scripts/gates/check_adjudication_completeness.py` fails closed when a converged cycle's recorded minor issues lack completed disposition rows in the adjudication — run it before folding a converged cycle's results into the durable record.
  - A reviewer whose only findings are non-blocking reports `ready` with the findings listed for disposition; reporting `needs revision` on non-blocking findings alone is a grading error, not extra rigor.
- **Symbolic claims route through `derivation-verify`**: when a converging milestone rests on a symbolic / derivation claim (a closed form, an identity, a sign/branch choice), the independent confirmation for that claim is at least two independent blind re-derivations via [`derivation-verify`](../../derivation-verify/SKILL.md) — reviewer agreement that a written derivation "looks right" is not independent confirmation. Computed numbers route through `numerical-reliability-gate`, the sibling gate.
- **Result registration at convergence (mandatory where the project has a
  nullius launcher)**: milestone convergence is when "which result is
  current" changes, so the convergence deliverable includes updating the
  project's traceability record, not only producing the new numbers:
  - a converged headline result gets a row in the results registry
    (`nullius result set-current <result_id> --run <run_id> ...` in
    `project_index.md`) — selection is the research judgment just made at
    adjudication, so record it while it is being made;
  - every run the new result replaces is superseded on the validity ledger
    with the reason (`nullius trace supersede <old_run> --by <new_run>
    --reason ...`); a run found wrong rather than replaced is voided. This
    is what later makes "which of these hundreds of runs still count"
    answerable by a machine instead of by archaeology;
  - rewritten memo sections carry a fresh version stamp
    (`<!-- written-against: <commit> -->` at the section end), so the
    per-section staleness check keeps discriminating current prose from
    holdover prose;
  - before folding, `nullius current` must answer cleanly for the affected
    result chain — no defective registry rows, no stale stamped sections
    citing the milestone's runs — or the residual is named in the
    adjudication with a disposition, same as any non-blocking finding.
  - This contract is machine-enforced at the fold boundary: the adjudication
    template carries a `Result registration` declaration section, and
    `scripts/gates/check_convergence_registration.py` fails closed when a
    converged cycle's declaration is missing, malformed, or does not match
    the project's traceability record — run it alongside
    `check_adjudication_completeness.py` before folding. A declared fact
    that is not on the record is a refusal, not a warning. The same gate
    refuses when the notebook's machine-maintained current-state block is
    present but OUT OF SYNC with its canonical render (a present block
    claims currency; refresh with `nullius notebook sync`), and when a
    section this fold declares rewritten still links a superseded/void run
    as live-looking prose with no acknowledgment (a visible superseded/void
    word in the citing paragraph or list item, a link to the replacement
    run anywhere in the section, or a declared log-role section all count). A MISSING block never refuses a fold — it
    is named as advisory by `nullius status --json` until adopted.
