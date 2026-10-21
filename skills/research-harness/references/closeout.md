# Closeout

Read the section relevant to the current operation. Commands and script paths are relative to the installed `research-harness` skill directory unless an external project root is specified.

## Closeout

Once producers have stopped, complete [Run Storage](run-storage-workflow.md#run-storage-bulk-outputs-out-of-git-history) before a
run-output commit or handoff: classify outputs, stow and verify selected
files, and commit their manifest/ignore records with the small evidence.
Run `check --staged --strict` before committing and `inventory` before
considering local retention. Never stow live output or infer deletion safety
from age, size or duplicate bytes. This is a storage check, not scientific
acceptance; the commands below keep their own research requirements.

Before handing off or claiming completion, finish the human-notebook rewrite, result-link check and accepted current full-text review described in **Fold Results Back**, identically in file and engine mode. `nullius notebook sync` refreshes only the automatic table; neither an in-sync table nor a fresh version stamp establishes that the human account was updated. If the task changes no scientific understanding, no notebook rewrite is owed. Record unresolved content gaps in the plan rather than declaring the scientific stage complete.

Run the narrowest applicable closeout command:

```bash
nullius verify
nullius final-conclusions
nullius approve <approval_id>
nullius decision record "<what was decided>" --by <who>
nullius decision land
nullius export --run-id <run_id>
nullius report-validate
```

Use the command that matches the project state. If approval is pending, stop at the approval boundary and report the exact approval id and evidence path. In projects that do not use the engine's approval flow (declared `execution_mode: file`, or any project where the go-ahead was given in conversation), record that go-ahead with `nullius decision record` at the closeout boundary — it is the engine-visible counterpart of the approval receipt, and open questions recorded with `nullius decision pending` stay counted in every status receipt (the oldest ten itemized; the rest via `nullius decision list`) until resolved. `nullius decision land` is a separate trunk-only fold after branch integration, not a command to run inside an unmerged worktree.

Run `nullius report-validate` only when a main report is being promoted or
superseded. It fails closed on structural incompleteness, stale current
pointers, mutated registered reports, broken supersession relations,
machine-only evidence, and replay mislabeled as independent validation. Its
pass is structural; scientific sufficiency remains a judgment on the report.

Run the `research-integrity` skill's M1-M7 checklist at the moments
work becomes durable. These triggers are observable file events — none
of them requires the engine's approval flow to be active:

- before folding a new number, claim, or result into
  `research_plan.md#Current Status` or the `research_contract.md`
  claims table,
- before checking off a task-board item whose output later work will
  build on — the item that makes a claim, interface, or result durable,
  not each sub-step or remediation retry inside it; sub-steps inherit
  the walk owed at their parent boundary,
- before a milestone closeout commit,
- when a `research-team` convergence gate reports the cycle converged,
- before assembling submission or handoff material,
- and before invoking `nullius approve` for any A1-A5 gate, in
  projects that use the engine's approval flow.

M1-M7 is the agent-side discipline that
catches hallucinated citations, hallucinated measurements, shortcut
graph claims, bugs-as-insights, methodology fabrication, and frame-lock
before they reach the durable record. The machine gates and the
`HARNESS_INVOCATION_REQUIRED` anchor remain authoritative; the
integrity check is owed to the next agent who reads your work.

Optional closeout retrospective (recommended at milestone or project
closeout): list the workflow lessons from the finished stretch of work;
split the generalizable verification philosophy (how results of this
kind should be verified anywhere) into the toolchain backlog, and keep
the project-specific instantiation (what was verified here, with which
tests) in the project repo; and when the project owner had to ask for
the same type of verification more than once, promote that moment into
the event → workflow dispatch table as a default trigger instead of
leaving it a reminder.

All newly generated managed project runs use `artifacts/runs/<run_id>/`; team and draft executor payloads live in `research_team/` beneath that run. Origin stamps bind the parent run. Historical `team/runs/<run_id>/` remains read-only evidence: status, run listing, index links and export retain its original location, stamps, validity rulings and result references. Reads do not migrate or rewrite it, and `init --runtime-only` reconnects without moving evidence. Unreadable historical locations are reported as unavailable without blocking unrelated readable runs. Duplicate IDs are reported as ambiguous; bare-ID reads refuse ambiguity, and new execution cannot reuse any historical ID. Stamping, backfill, staging, execution and resume cannot write historical run payloads. Use a distinct ID under `artifacts/runs/` for new work. The `inventory_run_relocation.py --fixture-root <anonymous-fixture> --source-manifest <hash-manifest>` helper only inventories pinned fixture bytes, references, collisions and unresolved bindings; it has no apply mode. Independent reviewer snapshots omit every run's executor payload and all workspace trees, retain production artifacts, and allow only each member's own declared output prefix. Historical reports/adjudications remain coordinator evidence. `team/LATEST*.md` and `artifacts/LATEST.md` are navigation pointers.

The generic scaffold creates `project_index.md`; the team helper updates only executor-local latest pointers and requires `nullius init` when the root index is missing. Selected-result and derived-block writers share a short path lock, reread their inputs, and make at most three attempts when edits are detected while preserving human bytes, mode and EOL outside their marked region. Arbitrary writers that ignore the lock remain outside its guarantee. Generic run counts do not interpret execution round limits; the Python executor resolver and suffix gate own those settings.

Existing `PROJECT_INDEX_AUTO` blocks are historical, unmaintained observations; the team helper neither parses nor updates them. Current `RUN_INDEX` navigation and curated result/report registries have separate owners. Do not silently rewrite or delete an old block.
## Fold Results Back

`research-team` payloads live under `artifacts/runs/<run_id>/research_team/`. Durable conclusions belong in the human notebook, project contract, plan and immutable reports with evidence pointers. Executor status and navigation pointers do not supply scientific acceptance.

Keep three artifact classes separate at this boundary. A checkpoint, status,
or closeout summary coordinates state and may stay concise. A main research
report is a complete researcher-facing scientific narrative that can be
reviewed independently. JSON, JSONL, hashes, manifests, and receipts bind the
execution but never replace explanatory prose or a clickable human-readable
evidence chain. When a milestone changes the promoted scientific account,
create a new report under `reports/`; never overwrite a registered report.
Update the bidirectional supersession registry and the single current pointer
in `project_index.md`, then require `nullius report-validate` to pass.

After a milestone or run produces a stable result, gate each result by its type before folding it (the [result-type dispatch table](routing.md#route-the-work), applied at the fold boundary):

- A computed number passes the [`numerical-reliability-gate`](../../numerical-reliability-gate/SKILL.md) — converged under refinement (no coarse-grid mirage), agreed across `>=2` orthogonal methods, and regression-anchored. A coarse, intermediate, or non-converged value is labeled as such or discarded, never silently promoted. The full multi-method requirement binds **result-bearing** quantities — the numbers conclusions rest on; an auxiliary number folded for context may carry a single-method verdict with an explicit downgraded label instead of the full matrix. Result-bearing is read broadly here: any number that a conclusion, comparison, or interpretive statement rests on is result-bearing by definition — "folded for context" can never be argued over a number the reader is invited to lean on. A downgraded label travels with its number into every appearance (tables, figures, prose), and displayed quantities separately answer to the figure gate's display-acceptance rule, which refuses outward-facing use until every plotted quantity is bound to a verification verdict.
- A derived formula, identity, or sign/branch choice passes [`derivation-verify`](../../derivation-verify/SKILL.md) (at least two independent blind re-derivations) before downstream work consumes it.
- A citation-backed claim passes [`claim-grounding`](../../claim-grounding/SKILL.md); a bibliography being frozen passes [`citation-triangulation`](../../citation-triangulation/SKILL.md).
- A data figure passes [`figure-hygiene`](../../figure-hygiene/SKILL.md) (once per generating script); a schematic diagram passes [`physics-diagrams`](../../physics-diagrams/SKILL.md).
- A speedup or performance claim passes its reproducible benchmark gate ([`julia-perf`](../../julia-perf/SKILL.md) for Julia code; an equivalent gate for other languages).
- A Julia package change meets [`julia-package`](../../julia-package/SKILL.md)'s affected interface and lifecycle checks; these establish package behavior, not independent scientific acceptance.
- Walk the [`research-integrity`](../../research-integrity/SKILL.md) M1-M7 checklist immediately before the fold itself.

Then land the folded result (the same obligations apply in engine and file mode):

- Rewrite the affected `research_notebook.md` sections into a coherent scientific account: assumptions and conventions, starting relations, non-obvious derivation steps, results and interpretation, validity limits and unresolved questions. Keep already verified intermediate understanding current; do not wait for whole-project acceptance. Label unverified reasoning explicitly rather than silently treating it as established. Topic notes may carry extended detail, but links or result tables alone do not replace the notebook's load-bearing reasoning.
- Link each adopted result's registered artifact directly from the relevant human `##` section, outside the automatic block, comments and code examples. After rewriting, record the section's `written-against` commit. `notebook.result_links` recognizes direct inline and explicit reference links, not recursive documents, HTML, shortcut references or indented link lines. A `linked` result is a navigation witness only.
- Finish the whole notebook and refresh its automatic block before running `nullius notebook review --model claude/opus` with repeated `--dependency <project-relative-path>` for every required supporting file. This actually executes the existing review-swarm launcher in bounded calls; the default hard timeout is 1200 seconds (`--timeout-secs <N>` overrides it), with no automatic reviewer retry. Freeze the complete UTF-8 notebook, including its automatic block, and declared dependency SHA-256 from actual bytes, including uncommitted edits. A commit or section stamp alone is insufficient. Any changed input bytes make prior acceptance stale; preserve the original review and input identity as readable history.
- Require a reviewer report covering every notebook section, with source anchors and reasons addressing complete derivation steps, logical consistency, notation, definitions, assumptions and conventions. Do not give the reviewer an expected verdict or the writer's initial judgment. Links, automatic tables, formula counts, completed checklists and writing self-assessment cannot supply a content verdict. Semantic review does not prove scientific truth, and a single reviewer leaves limits on model, method and input independence; result-specific verification remains required.
- Run `nullius notebook check --json` without a result selector for final closeout and inspect `nullius current --json`. The read-only check reports `structure` and `content_review` separately; exit 0 requires structural success and an accepted current full-text review, exit 1 means incomplete acceptance (including invalid review evidence), and exit 2 means invalid command/setup input or unavailable execution/runtime. `--result` scopes only the link check; content coverage always remains full-text. `--structure-only` success establishes navigation alone. Missing, partial, failed, unavailable, invalid or stale review leaves closeout incomplete in both file and engine mode; retired historical records remain readable, while every current result participates in the final unscoped structural check.

Read [`references/notebook-review-budget.md`](notebook-review-budget.md) when `nullius notebook review` reports a storage, context or budget shortfall, or an unfinished review is resumed with `--resume` (the material-handling, frozen-storage and execution-budget paragraphs, moved there verbatim).

Converged folds invoke the same unscoped `nullius notebook check --json` required
for final file closeout. `none` declarations and a missing launcher grant no
exception. `--result` is a scoped structural diagnostic; it cannot substitute for
the full default check, whose structural scope includes every current result.

- Summarize the durable conclusion in `research_contract.md`.
- Update `research_plan.md#Current Status` with the current state, next step, blockers, and evidence pointers.
- Cite evidence under the parent `artifacts/runs/<run_id>/`, including its `research_team/` payload where relevant.
- Preserve unresolved questions as explicit blockers rather than burying them in chat or transient team logs. When a question needs the project owner's decision, also record it with `nullius decision pending "<question>"` — it stays counted in every status receipt (the oldest ten itemized; the rest via `nullius decision list`) until a later `nullius decision record "<what was decided>" --resolves <id>` closes it, instead of scrolling away in conversation. Use `--relates <id>` when a new decided or pending entry needs non-closing context from an earlier readable entry; do not overload `--resolves` for a standing directive that remains in force. A replayed malformed relation is diagnosed without voiding the containing record. Legacy string kinds remain readable under current `decided` semantics and retain their original spelling in diagnostics: only the exact persisted `pending` kind creates an open item, while an otherwise valid `resolves` on a normalized entry still closes its pending target. Branch-local records carry provisional six-character handles; after all contributing branch tails are merged into the authoritative trunk, run `nullius decision land` there before citing the resulting durable `D<n>` ids. Never land on an unmerged branch; `decisions_unlanded` in the status receipt names work that is not yet ready for durable citation.
- At a milestone handoff or stakeholder plan-summary, produce a **roadmap dependency-map** (summary table + milestone/lane dependency graph + binding-constraint + critical path) via `research-team` (`assets/roadmap_dependency_map_template.md`, rendered with `nullius graph --kind roadmap`). It is a planning view — distinct from the Claim DAG and from `research_plan.md#Current Status`, and it makes "what gates what / what caps feasibility / shortest route to the goal" legible to whoever picks up the work next.
