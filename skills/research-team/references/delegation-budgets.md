Command, script and asset paths in this reference are relative to the `research-team` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

## Delegation budgets and weight tiers: the record matches the risk

A delegated executing agent's default drift is to refine precision
indefinitely and to expand scope on its own initiative; a delegation without
explicit budgets is drift by construction. So every **full-tier** delegated
computation or verification workstream (a lane, a compute job, a
result-bearing verification pass handed to another agent — the tier rule
below decides) gets a **budget contract** written by the coordinator
**before dispatch** — one JSON file per delegation under
`team/delegations/`, from `assets/delegation_budget_contract_template.json`
(`delegation_budget_contract_v1`).

**Delegation weight tiers — the packet matches the risk, not the ritual.**
Not every dispatch pays the full pre-dispatch freeze. A delegation is
**full-tier** — this budget contract plus the freeze-then-hash input
discipline — exactly when it executes computation, produces a result a
durable claim will rest on, or depends on blindness / frozen inputs for its
evidential value. Every other dispatch — a read-only analysis, a review-only
reading pass, a consultation — is **light-tier**: it records one
append-only line in `team/delegations/LEDGER.md`
(date | delegation id | seat | one-line workstream | outcome reference)
and mints no contract file, no frozen packet, and no per-dispatch budget
gate. The boundary is risk-anchored, not effort-anchored: anything that
could change a recorded number or seal a claim is full-tier by definition,
and when in doubt, full tier. Review seats are already bounded by the
review-cycle machinery (bounded rounds, severity grading, adjudication
dispositions); wrapping a second frozen packet around a bounded review pays
full dispatch cost to duplicate an existing brake — the measured signature
of that duplication is a run ledger where packet files outnumber and outweigh
the scientific objects produced. With tiers in force,
`delegation_budget.required=true` on a milestone asserts that at least one
**full-tier** delegation is expected there; light-tier ledger lines never
satisfy it, and a milestone dispatching only light-tier work leaves it
unset.

Required field groups of the full-tier contract, all machine-checked:

- **`tolerance_ceiling`** — choose exactly one machine-checked stopping form,
  always with a one-line `anchor_note` stating which task requirement derives
  it (what the result is *for*, never what the method can achieve):
  - **Numeric** (backward-compatible default): omit `mode`, or set
    `mode: "numeric"`; provide a finite positive `value` and no `predicate`.
    Reaching that ceiling means **stop**. Numeric zero remains invalid.
  - **Exact predicate**: set `mode: "exact_predicate"`; provide a non-empty
    one-line `predicate` naming the exact equality / boolean condition that
    ends the task, and omit `value`. Use this for exact-only work that has no
    approximation tolerance; never fabricate a positive tolerance or encode
    exactness as numeric zero.
  The two forms are mutually exclusive. Unknown modes, missing or multiline
  predicates, and contracts carrying fields from both forms fail closed.
  This ceiling is the delegation-side form of the `numerical-reliability-gate`
  G0 required accuracy: derive it the same way, and an undelegated result-bearing
  number still owes G0 through that gate.
- **`time_box`** — a hard wall-clock budget for the workstream, sized the
  way the memory estimate is, in one of two machine-checked forms. A box
  sized by guess is the recorded way a complex task is killed before it can
  finish, and a budget death only teaches the real need one wasted run
  later. **Measured** (`basis: "measured"`, required when the contract
  declares `launches_full_scale_computation: true`): `unit_seconds` is the
  wall clock of a single-unit dry run made before the full launch, `units`
  is how many units the workstream runs, and `seconds` must be at least
  `unit_seconds × units` (leave margin above that floor; the gate refuses a
  box below it as `TIME_BOX_BELOW_MEASURED_NEED`). **Declared**
  (`basis: "declared"`): a short workstream that launches no full-scale
  computation gives a one-line `note` instead, together with the explicit
  top-level declaration `launches_full_scale_computation: false` (absent
  fails closed); the two forms are mutually exclusive. When the box expires while
  the run is still advancing (checkpoint rows still landing), the
  coordinator may extend it, as a contract amendment carrying `retry_of`
  with `exhausted_budget: "time_box_seconds"`, `kind:
  "advancing_extension"`, the projected need from the measured rate as
  `measured_requirement`, and the measurement as `progress`
  (`elapsed_seconds`, `completed_units`, `total_units`, an `earlier`
  observation showing the completed count grew, the `row` of each
  observation — 1-based physical line numbers in the `probe_log`, one
  observation per line, the earlier row immediately before the current one
  (`EXTENSION_ROWS_NOT_ADJACENT` otherwise) — and `previous_extension_row`,
  the current row the previous extension used, 0 for the first: both rows
  must come after it (`EXTENSION_OBSERVATIONS_NOT_FRESH`), so an extension
  cannot reuse the observations an earlier one already used). The projected need
  is the larger of the whole-run rate (elapsed × total ÷ completed) and the
  latest interval's rate (elapsed + remaining units × the time per unit
  between the two observations), so a run that slowed down is not cut short
  again. Every time-box re-budget names its kind and records its
  progress with work remaining; a run wrapped up at its deadline is
  re-dispatched with `kind: "rebudget_after_wrap_up"`. The gate recomputes
  the projection (`TIME_BOX_RETRY_BELOW_PROGRESS`), refuses an extension
  whose observations show no advance (`EXTENSION_NOT_ADVANCING`) or do not
  name the probe log and both rows in order
  (`MISSING_EXTENSION_PROBE_REFERENCE` — the gate does not open the log;
  a reviewer checks the rows against it) and applies
  the existing strict-exceedance check. What the gate cannot see: whether
  the two observations are the last checks before the deadline (the
  coordinator attests it; a reviewer confirms it from the probe log), and
  whether `previous_extension_row` is the row the previous extension really
  used (it reads one contract revision, so the value is the coordinator's
  record; it catches an extension that reuses old observations, not a false
  entry). There is no fixed number of extensions; a run that has stopped
  advancing is wrapped up instead.
- **`max_attempts`** — a cap on "one last attempt" retries; exhausting it
  means wrap up, not retry. Attempts count deliberate re-entries into the
  delivered task (the `research-harness` attempt semantics), **not**
  individual diagnostic invocations, build fixes, targeted test runs, or
  diagnostic-scale parameter tuning inside the time box — those are ordinary
  development iteration and are bounded by the time box alone. A full-scale
  relaunch of the delivered task with revised parameters is a deliberate
  re-entry and consumes an attempt. Choose a value in the 3–5 band by default;
  reserve `1` for genuinely one-shot frozen-acceptance executions, and never
  write a development-phase contract that forbids diagnostics outright.
- **`scope_negative_list`** — expansions the executor must **not** undertake
  on its own initiative (e.g. infrastructure rewrites, building a full test
  suite beyond the delegated checks, third-party benchmarking).
- **`peak_memory_estimate`** — sized to the workstream, in one of two
  machine-checked forms. When the workstream launches a computation whose
  scale could threaten memory (a long or production-scale job), the estimate
  is **measured**: peak resident-set size from a **single-unit dry run before
  the full launch**, plus the explicit heap cap the full run is launched with
  (estimating wall-clock alone is not a resource estimate). For a short,
  bounded workstream that launches no such computation (a quick verification
  pass, a symbolic or review-only task), a **declared cap** is the honest
  form: `mode: "declared_cap"` with the heap cap and a one-line `basis`
  stating why a dry-run measurement is not warranted. Measuring the RSS of an
  unrelated command to satisfy the field is exactly the empty formality the
  declared form exists to remove. The eligibility choice is an auditable
  declaration, never an unstated assumption: a declared-cap contract **must**
  carry `launches_full_scale_computation: false` at the top level (absent or
  null fails closed; `true` together with the declared-cap form is
  machine-rejected as contradictory). Measured-form contracts may carry the
  same field optionally.

Two further blocks are optional in shape but **mandatory in the named
situations**, and machine-checked whenever present:

- **`independence_requirement`** — mandatory whenever the acceptance
  criterion for the delegated work demands two or more independent routes /
  confirmations (blind re-derivations, independent recomputation). Declare
  `routes_required` (what acceptance needs), `routes_budgeted_here` (what
  this delegation's budget is sized for), `per_route_seconds_floor` (the
  declared minimum wall-clock one route needs), optionally
  `routes_execution` (`"sequential"` — the conservative default when absent
  — or `"concurrent"`; unknown values fail closed), and — exactly when
  `routes_budgeted_here < routes_required` — a one-line
  `remaining_routes_source` naming the delegation(s) or planned dispatch
  that covers the rest. The gate cross-checks **joint satisfiability**
  (`INDEPENDENCE_BUDGET_UNSATISFIABLE`): sequential routes stack their
  floors inside the time box, concurrent routes share the wall clock but
  the box must still fit one full per-route floor. This closes a
  self-defeating freeze pattern: an acceptance target requiring N
  independent routes frozen over a budget that admits fewer cannot converge
  **by construction** — the budget, not the science, dictates the "not
  converged" verdict, the inadmissible attempt contributes nothing, and the
  same work is re-dispatched to hit the same wall. Freeze the acceptance
  criterion and the budget that can satisfy it together, or do not freeze.
- **`retry_of`** — mandatory on any contract or amendment that re-dispatches
  work whose previous contract ended by budget exhaustion. Declare
  `supersedes` (the previous contract revision / delegation id),
  `exhausted_budget` (`time_box_seconds` | `max_attempts` | `heap_limit_mb`
  | `unit_ceiling` | `other`), `measured_requirement` (the **measured** need
  in that dimension — a finite positive number for time / heap in the same
  units; a number or one line otherwise), and a one-line `adjustment_note`
  deriving the new budget from the measurement (for exhausted attempts: what
  changed in the approach — more identical attempts is not an adjustment).
  The gate cross-checks (`RETRY_BUDGET_BELOW_MEASURED_NEED`) that the
  matching budget field — `time_box.seconds`, `heap_limit_mb`, or
  `max_attempts` — **strictly exceeds** a numeric `measured_requirement`,
  because a budget-boundary death measures a **censored lower bound**: the
  run was cut at the boundary with work remaining, the true need lies above
  the measured value, and equality is the exhausted number with a stamp on
  it. An attempts retry that keeps its cap because the *approach* changed
  states that change as a one-line `measured_requirement` instead of a
  number; dimensions without a matching contract field (`unit_ceiling`,
  `other`) validate shape only, with the old and new ceiling values named
  in `adjustment_note`. Re-dispatching after a budget death with an
  unchanged numeric budget is forbidden — with or without a recorded
  shortfall: **one measured re-budget decision,
  never a chain of identical exhaustions** — every boundary death whose
  partial output was discarded and whose successor got the same budget pays
  the full dispatch cost to learn nothing.

The check is fail-closed and machine-judged
(`scripts/gates/check_delegation_budget.py`, machine verdict
`delegation_budget_gate_result_v1`): a contract
missing any required field, still carrying an unfilled template placeholder,
or using an unknown contract version does **not** pass. `run_team_cycle.sh`
validates every contract present at preflight in every project stage (no
exploration downgrade); set `delegation_budget.required=true` in the team
config when a milestone dispatches **full-tier** delegated workstreams
(execution / claim-bearing results / blindness-dependent — the tier rule
above), so a run with no full-tier contract also fails
(`NO_CONTRACTS_FOUND`); a milestone dispatching only light-tier work leaves
the flag unset — its ledger lines are deliberately not contracts.

Directory hygiene keeps `required` meaningful: the configured delegations
directory (`delegation_budget.delegations_dir`, scanned non-recursively)
holds only the contracts of **active** delegations; when a delegation
completes, archive its contract with the run or review record it governed,
so a stale contract can never satisfy `required=true` in place of the
missing new one. And set `required=true` per milestone that actually
dispatches **full-tier** delegations (or pass `--require` when invoking the
gate script directly), not as a standing flag — a
standing `true` over a clean directory rejects every cycle of a milestone
that delegates nothing or delegates only light-tier work.

When a budget is exhausted, the workstream **wraps up from the atomic
results already flushed to disk — it never voids the batch** — and abandoned
approaches go into the failed-approaches ledger (`failed_approaches_v1`);
both semantics are specified in the `research-harness` skill's long-running
compute jobs contract, which is where a delegated long job's checkpointing,
deadline, and resume behavior live.
