---
name: research-harness
description: Use when working inside an external research project that has or may need nullius state, research_plan.md, research_contract.md, artifacts/runs, Codex/Claude Code continuation, recovery, verification, current full-text notebook content review, approval, export, handoff, compute environment/tool readiness validation (import + seeded witness + agent-follows-doc), surviving long-running / kill-prone compute jobs (checkpoint + heartbeat + deadline + resume), an opt-in independent reproduction check (fresh-checkout rerun compared against declared expected values), run-output storage (bulk outputs kept out of git history behind a tracked hash manifest, commit-time size check), or a production launch authorization preflight (frozen plan hash + hash-bound review verdicts + exact environment fingerprint before a large production run may start).
---

# Research Harness

Use this skill as the thin project-harness entrypoint for Codex, Claude Code, OpenCode, or other agents inside a real external research project.

It does not replace the research executors. It restores the project state, routes work to the right surface, and makes sure durable conclusions land back in the project contract and run artifacts.

## Authority Map

- `nullius`: generic TS CLI and project lifecycle control plane.
- `research-team`: milestone execution and multi-agent research progress.
- `markdown-hygiene`: standalone Markdown math, TOC, and formatting cleanup before research handoff.
- `hep-mcp`: HEP literature, evidence, INSPIRE/arXiv, bibliography, and search-export tooling (search exports and other research outputs go into a caller-chosen `output_dir` inside the project, downloads and caches stay in hep-mcp's data root; runs stay with `nullius`).
- `project_index.md#Main research report` + `nullius report-validate`: single
  current report entry point and structural promotion gate.

## Recovery First

Work from the external project root, not from the `nullius` development repo.

1. If `.nullius/HARNESS` exists, treat it as the machine-readable runtime handshake: a status receipt is required before new work, milestone execution, closeout, or handoff.
2. Prefer the project-local CLI when it exists:
   ```bash
   ./.nullius/bin/nullius status --json
   ```
3. Otherwise use the installed CLI:
   ```bash
   nullius status --json
   ```

Session continuation restores only what the host durably recorded. Before a
handoff or restart, put required inputs, intermediate results and the next action
in project files or run evidence. Process-local tool variables and in-memory
stores are not checkpoints; a session ID or a successful resume cannot establish
that those values survived. Verify the needed bytes from durable material after
reconnecting, and report missing state rather than reconstructing it as fact.

A successful `status --json` call also refreshes the session-level anchor
marker at `.nullius/HARNESS_INVOCATION`. Every `*-mcp` dispatcher
(`arxiv-mcp`, `hep-mcp`, `hepdata-mcp`, `idea-mcp`, `openalex-mcp`,
`pdg-mcp`, `zotero-mcp`) verifies this marker for state-touching tool
calls and fails closed with `HARNESS_INVOCATION_REQUIRED` when the marker
is missing, malformed, or older than the most recent change to
`.nullius/state.json` or `.nullius/ledger.jsonl`. The check is
**event-driven, not clock-based**: once you anchor against current
project state, the anchor stays valid until project state actually
changes — long thinking / reading between tool calls does not invalidate
the anchor. Re-run `status --json` after any lifecycle event (own or
other-process `nullius run`/`approve`/`verify`/...) to re-anchor;
you do not need to invoke a separate "anchor" command. The same
event-driven economy applies to routine health re-verification inside a
review or work cycle, scoped to what the receipt actually witnessed: a
status receipt binds the state/ledger identities it was computed from, so
checks whose only inputs are `.nullius/state.json` and
`.nullius/ledger.jsonl` may cite the receipt while those files are
unchanged. Launcher and sentinel health have inputs outside that pair —
re-check them when their own identities (launcher target, sentinel
content) differ or cannot be established, and whenever any relevant
identity is unknown, re-run the full check rather than citing the
receipt. A re-check is owed on state change, never on cadence.

**What in a status receipt stops work, what asks for a repair, and what
is only advisory.** Three classes, machine-readable so nothing has to be
inferred from prose:

- **Stop and surface**: a non-null error field (for example
  `final_conclusions_error`, `project_surface_drift_error`) or a failed
  machine gate (a gate script exiting non-zero in the run evidence).
  These mean the receipt or a gate could not do its job.
- **Repair, then continue**: an invalid `HARNESS` sentinel or an
  unhealthy project-local launcher — authoritative surfaces
  `recovery_context.control_files.harness.valid` and
  `recovery_context.control_files.project_local_launcher.healthy`,
  echoed in the warning array with `severity: "repair"` and the exact
  `repair_command` (typically `nullius init --runtime-only`). The
  repair is cheap and self-contained: run it and keep going — neither
  condition is a reason to abandon the task or escalate.
- **Advisory**: every other entry under
  `recovery_context.derivation_warnings` and all of
  `project_surface_drift.issues`, marked `severity: "advisory"` —
  recoverable observations about auxiliary or derived state (missing
  optional manifests, plan-focus fallbacks, aging uncommitted work).
  Record them in the run evidence and keep working; treating an
  advisory-only receipt as a blocker halts real work over conditions the
  receipt itself classifies as non-blocking. A warning worth acting on
  becomes a task on the plan, not a reason to stop the current one.

The check is also skipped for:

- pure read-only provider queries (`arxiv_search`, `openalex_get`,
  `pdg_find_particle`, `inspire_resolve_citekey`, `hep_health`, etc.;
  full classification per dispatcher in each `*-mcp` package's
  `state-touch-classification.ts`);
- standalone use where `process.cwd()` has no `.nullius/`
  directory (no lifecycle context to drift from);
- `process.cwd()` being the home directory, which is never a project root
  (the CLI's project-root search skips it too; `~/.nullius/` there holds
  user-level data such as the agent roster);
- `NULLIUS_HARNESS_VERIFY=skip` env override (escape hatch) and
  `NODE_ENV=test` default.
4. If `.nullius/` exists but `.nullius/HARNESS` is missing, or if both entrypoints are unavailable, repair only the runtime handshake and launcher, then retry the project-local CLI:
   ```bash
   nullius init --runtime-only
   ./.nullius/bin/nullius status --json
   ```
   If `nullius` is not on `PATH`, run the same one-time repair through your nullius checkout (substitute its absolute path):
   ```bash
   node /absolute/path/to/nullius/packages/orchestrator/dist/cli.js init --runtime-only
   ```
5. Read and align the durable project surfaces:
   - `research_plan.md`, especially `# Current Status`
   - `research_contract.md`
   - `research_notebook.md`: read the human sections as well as the automatic table; inspect `traceability.notebook.result_links` for navigation gaps and `traceability.notebook.content_review` for full-text review identity, coverage and current acceptance; missing acceptance does not prevent ordinary recovery reads
   - the relevant `artifacts/runs/<run_id>/` and `artifacts/runs/` directories
   - the current main research report linked from
     `project_index.md#Main research report`, when one is promoted

**Anchor on the final adopted version — never build on a superseded one.** A long project accumulates earlier fits, methods, grids, and exploratory scripts; a *newer* adopted result (a better minimum, a more robust method, a finer grid) can silently coexist in the repo with the deprecated ones it replaced. Where the project has a nullius launcher, the machine-readable answer comes first: `nullius current` renders the results registry (which result rows are current, produced by which run at which commit) and the validity ledger (which runs are still active, which are superseded or voided and why) — consult it before any manual archaeology, and keep it authoritative by recording supersessions there when you replace a run. Where that surface is absent or silent on the question, resolve from the durable record (`research_plan.md#Current Status`, `research_contract.md`, the latest dated `artifacts/runs/<run_id>/`, and any explicit `superseded` / `voided` markers) **which** parameters, method, and configuration are the *current adopted* version — not the first script you happen to open or the most-cited earlier draft. Then **regression-anchor**: run that adopted reference configuration and assert it reproduces its known result (the published χ²/value/pole) *before* trusting any variation built on it. This is the project-state half of the [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md) G4 anchor; skipping it is how work silently gets rebuilt on a stale fit or a retired method.

Use `nullius init --refresh` to generate missing `AGENTS.md` support guidance (preview with `--dry-run`). Scaffold refresh preserves differing instructions and user-owned seed content (`research_plan.md`, `research_notebook.md`, `research_contract.md`, `project_charter.md`, `project_index.md`, `reports/main_research_report_template.md`, `.gitignore`). The CLI may still synchronize existing machine-managed blocks in the notebook and project index; it does not insert missing blocks during refresh. Template changes do not automatically update existing projects. For updated guidance, render a scaffold in an anonymous temporary external root and manually merge the desired changes, including notebook review instructions, into existing user-owned files.

For an existing project that predates the main-report registry, checkpoint the
project before migration. Render the current scaffold in a separate temporary
external root with `nullius init --project-root <temporary-root>`. Copy only a
missing `reports/main_research_report_template.md`; never overwrite an existing
copy. Manually merge the temporary `project_index.md#Main research report`
section and empty registry into the existing user-owned index. Refresh does not
perform those steps. `nullius report-validate` fails closed with
`invalid_registry_markers` before the registry exists and with
`no_current_report` until a complete current report is registered.

If no project state exists and the user is in a real external research root, initialize with:

```bash
nullius init
```

If `nullius` is unavailable on `PATH`, run the same one-time setup through your
nullius checkout (substitute its absolute path) to create the project-local fallback:

```bash
node /absolute/path/to/nullius/packages/orchestrator/dist/cli.js init --runtime-only
```

## Route The Work

- If the research question is still not scoped, create a plan with:
  ```bash
  nullius workflow-plan --recipe research_brainstorm
  ```
- If the user needs milestone execution, invoke `research-team` and keep the milestone boundary explicit.
- If a compute environment, tool build, or documented invocation is new, rebuilt, or reconfigured, pass the three-layer readiness validation (under Long-Running Compute Jobs below) before routing real work onto it.
- If the task is Markdown formatting, Markdown math escaping, generated TOC LaTeX cleanup, link/citation clickability, or pre-handoff note hygiene, invoke `markdown-hygiene` first, then rerun the relevant project gate.
- If developing or auditing a Julia computational package, use [`julia-package`](../julia-package/SKILL.md) for its API, numerical contracts and package lifecycle; combine with `julia-perf` for kernels and performance claims.
- If the task is physics or adjacent scientific literature research, evidence, INSPIRE/arXiv/OpenAlex provider lookup, source reading, bibliography, or literature search exports into project files, use `hep-mcp`. Web search may supplement broad discovery, but it does not replace the provider citation graph gate below.
- If the task is lifecycle, verification, approval, pause/resume, final conclusions, or export, keep it on `nullius`.

**Verification dispatch by result type.** This uses the same event → workflow vocabulary as the trigger table the scaffolded `AGENTS.md` carries (extended here with two harness-local rows, literature survey and prose; the integrity boundary lives in Closeout below); run the matching workflow at the moment the result appears, not on user reminder, and record the result as unverified when the named skill is unavailable:

| Result type | The moment | Verification workflow |
|---|---|---|
| Symbolic derivation | derived a formula, closed form, identity, or a sign/branch/boundary choice that later work will rely on | [`derivation-verify`](../derivation-verify/SKILL.md) |
| Numerical result | a computed number **that a conclusion or durable artifact will rest on** is about to be trusted, compared, or folded in — a number whose only consumer is a test, a fixture, or internal tooling is covered by ordinary tests, not this gate (a diagnostic that establishes a headline claim's convergence is result-bearing, not exempt) | [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md) |
| Citation-backed claim | wrote citation-backed claims (introduction, related work, discussion) | [`claim-grounding`](../claim-grounding/SKILL.md) |
| Bibliography | freezing a bibliography, or admitting papers into a core reading set | [`citation-triangulation`](../citation-triangulation/SKILL.md) |
| Literature survey | a survey feels thin, or before writing an introduction / related-work section | [`deep-literature-review`](../deep-literature-review/SKILL.md) |
| Data figure | finalized a data or results figure (once per generating script) | [`figure-hygiene`](../figure-hygiene/SKILL.md) |
| Schematic diagram | drew or revised a schematic, process, or geometry diagram | [`physics-diagrams`](../physics-diagrams/SKILL.md) |
| Performance claim | claimed a speedup or performance regression, or wrote performance-critical numerical code | [`julia-perf`](../julia-perf/SKILL.md) (language-scoped; use an equivalent gate for other languages) |
| Julia package change | created or changed a computational package's public API, dependency, supported representation, tests or documentation | [`julia-package`](../julia-package/SKILL.md), with `julia-perf` for kernels; package checks do not replace numerical-result acceptance |
| Independent review | a result-bearing surface needs independent review: a headline result, manuscript, load-bearing derivation, public contract, or an irreversible change — internal scaffolding diffs (writers, fixtures, launchers, schema plumbing) close on local tests plus a single reviewer, not a cross-model panel; an implementation never closes on its author's own tests alone | [`review-swarm`](../review-swarm/SKILL.md) |
| Prose / notes | Markdown math, TOC, links, or note hygiene before a handoff or gate | [`markdown-hygiene`](../markdown-hygiene/SKILL.md) |

Do not invent compatibility commands or fallback entrypoints. Keep lifecycle work on `nullius` and route executor or provider work to the relevant skill/tool layer.

## Closeout

Once producers have stopped, complete [Run Storage](#run-storage) before a
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

## Long-Running Compute Jobs

Real research compute (fits, scans, integrations, derivations) often runs far longer than one agent turn in an environment where the job can be **killed at any time** — contending processes, OS limits, or a closed session. Treat every long job as kill-prone and make it *survive* kills rather than assuming it finishes. The compute runner (`hep-calc` or any executor) runs the computation itself; this harness owns the job's survival.

**Validate readiness in three layers before the first real launch.** "Did you test it?" is not a yes/no answer — name which layer you validated. Before trusting a compute environment, a rebuilt tool, or a documented invocation enough to carry real work, pass three tiers:

1. **Load/import succeeds.** Necessary, cheap, and catches almost nothing interesting.
2. **Seeded witness run.** A tiny, seeded execution that exercises the real computation path and prints a sentinel — output shape/size plus a non-emptiness check. This catches what an import cannot: the tool loads but the computation under test fails at runtime, writes to a read-only location, or silently produces empty output. Record the witness invocation alongside the environment so the identical probe reruns on every rebuild.
3. **Agent follows the doc verbatim.** Spawn a sub-agent that reads the tool's own documented invocation, runs it exactly as documented, and diffs what the doc claims against what actually happened. This is where the documented flag or path turns out to be wrong — it routinely finds blocking bugs on tools whose import-level checks have been green for weeks.

Run the witness on every build; reserve the expensive agent-follows-doc pass for the two moments doc and tool drift apart — after any rebuild/reconfiguration or doc edit, and before declaring the tool ready. Complementary to the [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md): that gate certifies the *numbers* a run produces; this ladder certifies the tool/environment actually runs and its documentation matches reality.

**Launch contract.**

- Write durable state only inside the managed run dir `artifacts/runs/<run_id>/` (human-meaningful tag, never a bare UUID). Never keep durable state in `/tmp`: a kill or a new session loses the results and, if the script also lives there, the code that produced them.
- Stamp the run's code origin at launch, before the job starts: `nullius trace stamp artifacts/runs/<run_id>` (where the project has a nullius launcher). The stamp records the exact commit — snapshotting uncommitted tracked edits so even a dirty tree gets an exact identity — and is the difference between "this result came from this code" being a recorded fact and being a later guess. Delegated compute contracts should require the stamp as part of the launch preflight, alongside the budget fields. Runs executed through `nullius run` (and team cycles) stamp automatically at launch; the manual verb is still the required step for hand-created run dirs, and is a harmless no-op on an already-stamped same-tree run. One stamp per run id, but a run id is an experiment slot, not a single execution: if the previous execution crashed with **no retained result**, `nullius trace retry <run_dir>` closes the failed attempt (archiving its residue under `attempts/`) and opens the next attempt under the same id with a fresh code capture — the front door does this automatically on relaunch after a machine-evidenced crash. Anything that DELIVERED — a completed execution, a result the registry consumed, a decided (superseded/void) run — never takes that cheap path: changed code there means a fresh run id (the stamp refuses to rebind), and "completed but wrong" always goes through the full supersede/void ceremony.
- Keep the compute script in the repo (committed), not in `/tmp`. Stream stdout to a log *inside the run dir* from a pipefail-enabled shell (`set -o pipefail; <cmd> 2>&1 | tee artifacts/runs/<run_id>/<job>.log`) for tailing; the log is for eyeballing, the checkpoint is the durable record. A bare logging pipeline reports the sink's status even when the producer fails, so record the producer/component status or a structured verdict and never treat the pipeline status alone as success.
- Pin a **project-local, lockfile-committed environment** (commit the lockfile — `Manifest.toml` / `uv.lock` / `requirements.lock` / `Cargo.lock` — and run the job explicitly against it). Never run a long job against a shared/global interpreter env: a runtime-version mismatch silently invalidates the compiled cache (every relaunch re-pays full startup) and makes results non-reproducible.

**Checkpoint so a kill costs at most one unit.** Split the work into independent units; have the job **append one line per completed unit** to an append-only checkpoint file in the run dir, keyed by a unique unit id in column 1. On (re)start, read the file into a `done` set and skip any unit already present — so a kill loses at most the one in-flight unit. A unit that legitimately fails is still recorded (a sentinel row) so resume does not retry it forever. Include the per-unit wall-clock seconds in a column — that is what later lets you detect a livelock. Language-neutral shape:

```text
done = { column-1 keys already in <checkpoint> }   # empty if the file is absent
for unit in units:
    if unit.key in done: continue
    result = compute(unit)                          # the expensive part
    append one line "<key>\t<fields>\t<seconds>" to <checkpoint>; flush
```

Resume readers must guard against a missing checkpoint file, and must not trust a partial/stale checkpoint as a final number.

**Survive dropped notifications with a self-re-arming heartbeat.** The host's "job done / killed" signal can be silently dropped, stranding the agent on a dead job. Arm a host-provided wall-clock self-wake (in Claude Code, `ScheduleWakeup`) at a cadence ≈ 2–3× the observed kill interval. Each wake must: (1) re-derive ground truth from the filesystem — checkpoint line count vs expected, and whether the process is still alive — never trusting the notification; (2) if the job was killed mid-run, relaunch it (the checkpoint resumes — a continuation of the *same* attempt, not a new one; when the workstream runs under a delegation budget contract, the relaunch chain stays within the contract's time box) **and re-arm the next wake**; (3) if it is done, report + commit + advance, and do **not** re-arm. The self-re-arming chain means one dropped notification can never strand the job. Stop the chain once completion is confirmed — do not leave heartbeats firing forever.

Use the bundled probe instead of brittle `until ! pgrep …; sleep` loops (which burn turn budget, can mis-match the agent's own session, and can SIGPIPE the job via a stray `| head`):

```bash
python3 scripts/compute_job_probe.py --pattern "<job-script-name>" \
    --checkpoint artifacts/runs/<run_id>/<job>.tsv --expected <N>
```

It captures `pgrep` (SIGPIPE-safe, never pipes) and prints JSON `{running, checkpoint_count, deadline_fired, verdict}` with `verdict ∈ running | stalled | completed | deadline_reached | killed_incomplete | stopped`: `killed_incomplete` → relaunch; `completed` → all expected units are recorded, so scan the checkpoint for any sentinel-failed rows before folding back; `stalled` → livelock (below); `deadline_reached` → the task's own time budget expired, not a crash (below).

**Detect and break livelock.** If a single unit takes longer than the kill window minus startup overhead, the per-unit checkpoint can never land — the job relaunches forever and the checkpoint count stays flat. The probe reports `stalled` when the count is unchanged across `--stall-window` consecutive checks. Then **stop relaunching** and re-decompose: shrink the unit, or replace it with a finer-grained, **independently cross-validated** cheaper surrogate — never a silently-substituted approximation (that is papering over a result, forbidden). Keep the expensive original in-repo as a record of why.

**Give each task its own deadline, and keep "deadline reached" distinct from "crashed".** A host kill is involuntary and strikes mid-unit; a per-task deadline is a time budget you set — below the host kill window — so the task stops deliberately, at a point the session can still act on. Arrange the launch so that when the budget expires, the job or its wrapper writes a deadline marker file next to the checkpoint (the probe's default is `<checkpoint>.deadline`; e.g. map a `timeout` wrapper's expiry exit status to writing the marker, or have the job's own elapsed-time check write it and exit at a unit boundary). The probe then reports `deadline_reached` instead of `killed_incomplete`: a time boundary, not a failure — so do not reflexively relaunch. Choose deliberately: resume from the checkpoint with a larger budget, resubmit where the time window is longer, or re-decompose into smaller units — with one restriction: when the task runs under a delegation budget contract, the deadline *is* the contract's time box, and its expiry **ends the contract**; every enlarge/resubmit/re-decompose choice is then the coordinator's to make through a new contract, never the executor's. Consume (delete) the marker as part of acting on it, so the next probe reads clean. Without the distinct signal, every time boundary is misread as a crash and blindly relaunched — burning the budget again to hit the same wall.

**Budget exhaustion settles on the flushed atomic results — it never voids the batch.** When a budget boundary is reached — the per-task deadline fires, the delegation's time box expires, or the attempt cap is exhausted — wrap up from the per-unit checkpoint rows already flushed to disk. (An involuntary host kill is *not* budget exhaustion: resume from the checkpoint within the remaining time box; only when no budget remains does the same wrap-up apply.) Report honestly what is in hand (N of M units, with the sentinel-failed rows named), fold those partial results back through their normal verification gates, and decide the remainder deliberately (resume, resubmit, re-decompose, or stop). Discarding completed units to "rerun clean", or treating a timeout as if the whole batch never ran, throws away paid-for evidence and is forbidden — the append-only checkpoint exists precisely so a budget boundary costs at most the in-flight unit. An approach abandoned at a budget boundary is recorded in the failed-approaches ledger below (signal `too_expensive` or `dead_end`) so no successor burns the same budget rediscovering it.

**A run still advancing at its deadline is a decision point, not an automatic wrap-up.** When the probe reports `deadline_reached` while the checkpoint count was still growing over the last checks, the work is progressing and the box was too small; killing it throws away the rate already measured. The coordinator either extends the box from the measured rate (projected need = the larger of elapsed time × total units ÷ completed units and elapsed time + remaining units × the time per unit over the latest interval, so a run that slowed down is not cut short again, recorded through the delegation contract's `retry_of` amendment with `kind: "advancing_extension"` and the measured `progress` — the last two probe observations — adjacent lines of the probe log, both after the row the previous extension used — showing the completed count grew, and the probe log they come from — so the gate recomputes the projection and the new box must strictly exceed it), or wraps up as above. A run whose checkpoint count had stopped growing is `stalled`, not slow: wrap it up and re-decompose. Every extension needs fresh observations taken since the previous one, and a box that was never measured is not extended — size it from a dry run instead.

**A delegated long job carries an explicit budget contract, and its resource estimate is measured, not guessed.** When a long job is dispatched as a delegated workstream, the coordinator writes a `research-team` delegation budget contract (`delegation_budget_contract_v1`, machine-checked fail-closed — see that skill) before dispatch; a delegated executor's default drift is to refine precision indefinitely and to expand scope, and a delegation without explicit budgets is drift by construction. The contract binds directly onto this harness with an explicit attempt semantics: an **attempt** is a deliberate (re-)entry into the delivered task at approach granularity — the first launch, or a re-run after the approach failed or the deadline fired. Diagnostic invocations, build fixes, targeted test runs, and diagnostic-scale parameter tuning *inside* the time box are ordinary development iteration within the current attempt, not new attempts (a full-scale production relaunch with revised parameters IS a new attempt) — contracting them to zero applies frozen-acceptance discipline to the implementation phase. A checkpoint-resume relaunch after an involuntary host kill likewise *continues the same attempt* (it loses at most the in-flight unit) and does not consume the attempt budget — but every relaunch still lives inside the **time box**, which is the per-task deadline above and bounds the whole workstream in wall-clock terms regardless of how many kills occurred. **max_attempts** caps the deliberate re-entries: exhausting the cap means wrap up from the flushed results and report — never one more try. Time-box expiry likewise ends the current contract even when attempts remain: the two budgets are independent ceilings, and hitting *either* one stops the workstream. Re-budgeting of any kind — more time, more attempts — is the coordinator's decision, never executor discretion; the normal artifact is a coordinator-recorded amendment to the same delegation id — appended as a new dated contract revision that supersedes the old one, never rewriting the original in place (the freeze-then-hash rule applies to contracts too) — with a wholly new contract reserved for scope changes. When the re-budget follows a budget exhaustion, the superseding contract carries the **measured shortfall** in a `retry_of` block (see the `research-team` contract): the new budget derives from what the exhausted run actually measured — elapsed need, peak memory, units scanned — and must **strictly exceed** a numeric measurement, because a boundary death measures a **censored lower bound** (the run was cut at the boundary with work remaining; the true need lies above the measured value, and equality is the exhausted number with a stamp on it). Re-dispatching the same work with an unchanged numeric budget is forbidden — with or without a recorded shortfall: each identical attempt dies on the same wall, contributes nothing admissible, and pays full dispatch cost to learn nothing — one measured re-budget decision, never a chain of identical exhaustions. The selected **stopping condition** is binding: reaching the positive numeric tolerance ceiling, or satisfying the one-line exact predicate for an exact-only task, means stop — do not keep refining. A marginal miss at a numeric ceiling is a coordinator adjudication item — record an accepted deviation with its reason, or re-budget deliberately — not an automatic new work lineage, and never a silent tolerance widening by the executor; exactness is represented by the predicate form, never by numeric zero. And for a long or production-scale job the **peak-memory estimate is mandatory and measured**: run a single unit as a dry run *before* the full launch, read its peak resident-set size (RSS), and launch the full job with an explicit heap cap at or above that measurement. Estimating wall-clock alone is not a resource estimate — memory kills (out-of-memory, swap death) strike long before a time budget does, and they take the whole process, not one unit. (A short, bounded delegation that launches no such computation uses the declared-cap form of the memory field instead — see the `research-team` delegation budget contract; measuring an unrelated command's RSS to fill the measured form is empty formality, not an estimate.)

**Commit each stage as cross-session memory.** A kill loses CPU work; a closed session loses the agent's context. Commit each completed stage immediately with a message recording the result *and the lesson*; the git log is a durable record that survives context loss.

**Log dead-ends structurally so a resumed or fresh agent never repeats one.** Append each failed approach to `artifacts/runs/<run_id>/failed_approaches_v1.json`, per the `@nullius/shared` `failed_approaches_v1` contract — `{ approach, why_failed, signal (error|stall|wrong_result|too_expensive|dead_end|superseded), at, evidence_ref?, do_not_retry }`. **`why_failed` is mandatory**: a dead-end recorded without why it failed is not a reusable lesson, and the contract rejects it. **Before starting any new approach, read this log and skip every `do_not_retry` entry** — that is the point, turning "what we already ruled out" from buried git archaeology into a record the next session (or a fresh agent) actually consults. A free-text note is the fallback only when structured logging is unavailable.

## Run Records: Freeze Identity Once, Append Results, Never Hash Lifecycle State

A run record keeps three artifact classes separate, and only the first two ever carry hashes:

1. **Frozen identity** — the inputs, code, and contract the run was launched from. Hash these once, before execution; they never change afterwards by definition.
2. **Execution results** — outputs the run produced. Append their identities after execution (an append-only result record); a completed output is frozen at completion and may be hashed then.
3. **Lifecycle state** — status fields, summaries-in-progress, project registries, adjudication indexes: anything the workflow itself rewrites as the run advances toward acceptance. These are **never** part of any hash closure. Hashing a status-bearing file binds the record to a value that must change, so every lifecycle advance cascades into re-hashing and re-verifying files whose changes verify nothing — the record ends up maintaining itself instead of the research.

When a hash-bound artifact genuinely needs to change, the model is supersession, not in-place re-hash: freeze a new version, register it, and point the current pointer at it (exactly the main-report registry discipline). If a mutable file must appear in a review packet, embed an immutable content snapshot of it, so review freshness tracks the reviewed claim rather than unrelated bookkeeping writes.

## Result Traceability: Which Runs Still Count, From Which Code

The acceptance question this surface answers, as prose from one command
(`nullius current`): what the current best result is, which exact code
revision produced it, where the current manuscript is, which notebook
sections are current versus stale, and which runs are still valid versus
superseded or voided — with honestly-unanswerable clauses where the record
cannot support an answer. The version object is the git commit; runs bind to
commits via origin stamps; validity lives in an append-only ledger; result
selection lives in the results registry in `project_index.md`.

Daily discipline (each covered in its own section or in `research-team`):
stamp runs at creation, supersede or void on the ledger when a result is
replaced or found wrong, register headline results at milestone convergence,
stamp rewritten memo sections.

**Adopting this in an existing project** (one that already has runs but no
stamps) is explicit — templates and launchers do not migrate anything by
themselves:

1. `nullius init --runtime-only` from the project root refreshes the
   launcher so the `trace`, `current`, and `result` commands are available.
2. `nullius trace backfill` writes retroactive origin stamps for legacy
   runs by aligning run-directory timestamps against the commit timeline —
   explicitly labeled as heuristic alignment (`aligned_heuristic`), never
   presented as exact, and honestly `unbound` with a reason where no
   alignment is defensible. Validity is never backfilled.
3. `nullius trace propose-chains` derives same-topic round chains
   (r1 → r2 → r3 within one milestone) as a supersession *proposal file*;
   a human reviews and edits it, then `nullius trace confirm-chains`
   records only what the reviewed file says. The machine never decides by
   itself that a run was superseded.
4. The results registry block is pasted into `project_index.md` by hand
   once, copying the Current results section from the scaffold template —
   existing generated projects do not gain it through refresh: scaffold
   refresh does not migrate the user-owned results registry, and the CLI
   does not insert missing managed blocks. `nullius result set-current`
   refuses with exactly this instruction until the block exists.

## Run Storage: Bulk Outputs Out of Git History

Every tracked byte exists once in the object store and once per checkout — the main checkout and every linked agent worktree — and the origin pins (`refs/nullius/runs/<sanitized id>`, `refs/nullius/attempts/<sanitized id>/<n>`) keep every blob of a stamped snapshot alive permanently. A project whose tracked run outputs are large numerical dumps and large text tables therefore pays for the same bytes several times over, and can never reclaim them without rewriting pinned evidence. The policy: source, frozen inputs, essential results and provenance are preserved according to their purpose; **bulk** outputs stay out of git history while remaining readable in place with their original bytes and a tracked hash.

Read [`references/run-storage.md`](references/run-storage.md) when editing `.nullius/storage_policy.json`, declaring `path_rules`, or checking what origin capture admits (the policy file, path-rule, inventory and origin-capture paragraphs, moved there verbatim).

**After a run has finished writing its outputs**, stow them:

```bash
python3 scripts/run_storage.py stow artifacts/runs/<run_id>        # --dry-run to preview; --json reports commit_needed
python3 scripts/run_storage.py verify artifacts/runs/<run_id>
git add artifacts/runs/<run_id>/bulk_manifest.json artifacts/runs/<run_id>/.gitignore
```

`stow` (which writes nothing for a run without bulk files) reports whether the run's manifest or `.gitignore` is left not committed as it is (`commit_needed` in `--json` output; `null` for a dry run, which writes nothing and predicts nothing). It places each bulk file once, by sha256, into a content store shared by every worktree of the repository (default `<git common dir>/nullius/store`: never checked out, untouched by `git clean` and `git worktree remove`), makes the run's file read-only, writes `bulk_manifest.json` (path, size, sha256 per file), and adds a managed block to the run directory's `.gitignore` listing exactly those paths. The manifest is tracked, so later stamps capture the hashes of bulk inputs while their bytes stay out of history. The stored object is always an independent file, never sharing an inode with a run's file, so editing a run's file can never alter the stored evidence or another run's copy: a copy-on-write clone where the file system supports it (APFS, btrfs, XFS — no extra blocks), otherwise a verified byte copy (a second copy on disk, still far fewer than one per checkout plus the object store). Any object already in the store is trusted only after its full hash is checked; a damaged one is set aside, never deleted or reused. Identical outputs of different runs share one stored object. `stow` never replaces a run's file; it only makes it read-only. A recorded output that changed or shrank, or that is gone from both the run directory and the store, is refused (a corrected result belongs in a new run, exactly as the stamp rules require); one that is only absent in place but intact in the store is accepted (`materialize` restores it); names that cannot be written into a manifest or ignore rule (a line break, invalid UTF-8) are refused before anything is changed; on macOS, names are recorded in git's composed Unicode form. On a case-insensitive file system (measured once, in the first run root) a file renamed only in letter case is still the recorded one; when git does not treat the two spellings as equal (`core.ignorecase` not true, or — since git folds only ASCII letters — spellings that differ in other letters), the ignore block does not cover the new spelling, so `stow` refuses until the file is renamed back (a dry run reports the same refusal). With `core.ignorecase` true on a case-sensitive file system (carried over from another checkout), names differing only in case are different files that git treats as one path: such a file is the recorded output renamed when the recorded spelling is gone and the file holds exactly the recorded bytes, and otherwise a new output, reported and stowed like any other. Where git does not fold case on a case-sensitive file system (`core.ignorecase` false, the default there), renaming a stowed file only in letter case is an ordinary rename, like any other: the new name is a new output to stow, and the old entry stays valid from the store (`in_store_only`). A run is recorded by one manifest: stowing a directory inside, or around, an already stowed run directory is refused, as is a run directory holding a nested repository. The managed block is rewritten where it stands (gitignore rule order decides which rule wins), and user rules are kept exactly; a run directory whose `.gitignore` is a symbolic link is refused (git does not read a symlinked `.gitignore`). Under a run root the file name `bulk_manifest.json` is reserved: any file with that name marks a stowed run directory, so rename a data file that happens to have it. `stow` refuses, before changing anything, when git's ignore rules exclude the run's `bulk_manifest.json` or `.gitignore` (for example a rule ignoring a whole run root): the record must be committable. Bulk files already committed are left alone (history is never rewritten here); bulk files that are staged or changed but not committed are refused, since the next commit would put them into history — unstage a new file with `git rm --cached <path>` (it stays on disk) and stow again. With `--json`, every refusal also prints a result object naming the kinds of refusal (`refused`) and the paths each concerns (`items`); a command stopped by an error (exit 2) prints `{"error": <message>}` (argument mistakes are reported by the parser on stderr only).

Read [`references/run-storage.md`](references/run-storage.md) when running `verify`, `materialize`, `check`, `worktree-check` or `report`, taking backups, working with pinned refs and linked worktrees, or applying the operating assumptions for `stow` (the verify, materialize, operating-assumptions, commit-time check, backup, pinned-ref, linked-worktree and measuring paragraphs, moved there verbatim).

**Existing projects** (nothing migrates by itself): run `check` to see where the bytes are, `worktree-check --all` to see which worktrees can go, and stow new runs from now on; bulk already tracked in history stays as it is. Project-template changes (the dispatch-table row, the `.gitignore` comment) reach existing projects only when copied by hand.

## Runaway Protection Is Not a Performance Gate

Two different controls, deliberately kept apart:

- **Runaway protection** — a generous time/memory ceiling on any execution, existing solely to terminate a hung or memory-exploding process. It never demands single-thread execution, never blocks work for being unoptimized, and its trip is an incident to diagnose, not evidence to review.
- **Performance evidence** — benchmarks, allocation profiles, scaling measurements. These are demanded only when a speedup or regression **claim** is made (route it through the language's benchmark gate, e.g. `julia-perf`), or when entering production-scale batch computation whose cost matters. Recording and re-reviewing wall-clock, RSS, and swap figures on small bounded test executions is measurement theater: the numbers gate nothing, yet they get copied into receipts, summaries, and adjudications and re-read every round.

Corollary: performance work never blocks correctness work. A correct, stable computational kernel is the precondition for meaningful optimization — a performance target contracted before the kernel exists inverts that order and stalls the science behind a gate that cannot yet be evaluated.

## Independent Reproduction Check (Opt-in)

A result that only reproduces inside the working directory that produced it — uncommitted edits, leftover artifacts, stale caches — is not reproducible yet; the 2026 reproduction evaluations (PaperBench, NatureBench, ReplicationBench) all made *fresh-state reruns* the hard criterion. This protocol is that rerun, run locally and **opt-in: it changes no default workflow and wires no mandatory gate**. Adopt it per project when a headline number is worth a clean-state rerun — before an approval gate, a handoff, or an export is a natural moment.

The project declares a reproduction manifest (JSON, domain-neutral), recommended at `artifacts/runs/<run_id>/reproduction_manifest.json` and committed like any other run evidence. Worktree mode enforces this: an untracked manifest, or one carrying uncommitted edits, fails the check — the claim under test (entry command, expected values, tolerances) must itself be part of the committed state.

```json
{
  "manifest_version": 1,
  "entry_command": "python3 scripts/reproduce_headline.py",
  "working_inputs": ["scripts", "data/inputs.csv"],
  "timeout_seconds": 900,
  "environment_note": "python3 + packages from the committed lockfile; no network",
  "expected": [
    {"id": "fit_quality", "artifact_path": "out/result.json", "json_path": "fit.quality",
     "value": 1.23, "tolerance": {"kind": "absolute", "value": 0.01}},
    {"id": "lowest_eigenvalue", "stdout_pattern": "lowest eigenvalue = ([-+0-9.eE]+)",
     "value": -2.502, "tolerance": {"kind": "relative", "value": 1e-4}, "unit_note": "model units"}
  ]
}
```

- `entry_command` runs via the shell from the isolated project root; everything it needs must be committed (or listed in `working_inputs` for the copy fallback).
- Each `expected` entry declares exactly one deterministic extraction mechanism — a produced JSON artifact (`artifact_path` plus dotted `json_path`; digit segments index lists) or a `stdout_pattern` regex with exactly one capture group (last match wins) — a declared value, and an **explicit** `tolerance` (`absolute` or `relative`; relative requires a nonzero declared value). There is no default tolerance and no order-of-magnitude pass.
- `working_inputs` is a whitelist of project-root-relative paths, used only by the copy fallback.

Run the bundled checker:

```bash
python3 scripts/independent_reproduction_check.py \
    --manifest artifacts/runs/<run_id>/reproduction_manifest.json
```

Read [`references/reproduction-check.md`](references/reproduction-check.md) when interpreting a reproduction verdict or the isolation, environment-scrub and limits behaviour (the fail-closed semantics bullets, moved there verbatim).

This is the execution arm of the [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md) reproduction discipline: its G8 demands that a claimed match to a reference number be *computed, not asserted* — the fresh-checkout rerun is that computation in its strongest form — and its G7 production-setting rule applies to the manifest itself: declare the entry and configuration that produce the recorded values at their production setting, not a cheaper stand-in.

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

Read [`references/launch-authorization.md`](references/launch-authorization.md) when a launch-authorization refusal or verdict needs explaining (the default-refuse semantics bullets, moved there verbatim).

This preflight is the machine arm of the A3 (`compute_runs`) gate — the shared gate registry's A3 policy names `launch_authorization_v1` as its result contract, so launchers know what to produce. The enforcement locus is the **project-side launcher**: chain the checker before the production command as shown above; the engine's bounded-computation runner does not invoke it. In projects using the engine's approval flow, `nullius approve <A3-...>` records the *human* go-ahead; this preflight checks the *technical* launch preconditions at the moment of launch. They are complementary: neither substitutes for the other.

## Literature Research Gate

For physics or adjacent scientific literature research routed through `hep-mcp`, citation graph checks are mandatory workflow steps, not optional keyword triggers.

Web search may be used first or in parallel to discover candidate papers, non-indexed materials, experimental pages, proceedings, code, or broader context. Before making literature-map claims, normalize core candidate papers to stable identifiers such as INSPIRE recid, arXiv id, DOI, or OpenAlex id and use `hep-mcp` provider tools for citation graph authority.

Minimum expectations:

- Treat `50` as a default page/initial-batch size, not a completion threshold. Literature work is complete only after a saturation artifact records provider coverage, candidate-pool rationale, and citation/reference graph checks.
- For each seed or core paper, check both directions when relevant: papers it references and papers citing it.
- For claims about paper relationships, source priority, review status, influence, or literature gaps, inspect the citation/reference graph with `hep-mcp` provider tools; do not rely only on search snippets or web pages.
- For writing-facing work, resolve citekeys and BibTeX through `hep-mcp` provider tools rather than hand-maintaining citekey authority from web search.

Useful `hep-mcp` routes include:

- Resolve identifiers first through the available provider route: INSPIRE recid, arXiv id, DOI, or OpenAlex id.
- INSPIRE citation/reference graph when covered: `inspire_literature(mode=get_references, recid=...)` and `inspire_literature(mode=get_citations, recid=..., sort=...)`.
- Cross-paper graph inside the provider layer: `inspire_find_connections` or `inspire_network_analysis`.
- arXiv/source checks: use arXiv/provider routes for preprints, versions, and source text when the task depends on the actual paper source.
- OpenAlex/cross-domain checks: use OpenAlex/provider routes when the paper is outside clean INSPIRE coverage or when broader cross-field citations may matter.
- Citekeys and BibTeX for cited recids: `inspire_resolve_citekey`; batch identifier-to-recid mapping written into the project: `hep_inspire_resolve_identifiers` with `project_root` and an `output_dir` under the current run directory (e.g. `artifacts/runs/<run_id>/literature`).

If `hep-mcp` or a needed provider is unavailable, state that limitation explicitly and do not present the citation graph as complete.

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

After a milestone or run produces a stable result, gate each result by its type before folding it (the Route The Work dispatch table above, applied at the fold boundary):

- A computed number passes the [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md) — converged under refinement (no coarse-grid mirage), agreed across `>=2` orthogonal methods, and regression-anchored. A coarse, intermediate, or non-converged value is labeled as such or discarded, never silently promoted. The full multi-method requirement binds **result-bearing** quantities — the numbers conclusions rest on; an auxiliary number folded for context may carry a single-method verdict with an explicit downgraded label instead of the full matrix. Result-bearing is read broadly here: any number that a conclusion, comparison, or interpretive statement rests on is result-bearing by definition — "folded for context" can never be argued over a number the reader is invited to lean on. A downgraded label travels with its number into every appearance (tables, figures, prose), and displayed quantities separately answer to the figure gate's display-acceptance rule, which refuses outward-facing use until every plotted quantity is bound to a verification verdict.
- A derived formula, identity, or sign/branch choice passes [`derivation-verify`](../derivation-verify/SKILL.md) (at least two independent blind re-derivations) before downstream work consumes it.
- A citation-backed claim passes [`claim-grounding`](../claim-grounding/SKILL.md); a bibliography being frozen passes [`citation-triangulation`](../citation-triangulation/SKILL.md).
- A data figure passes [`figure-hygiene`](../figure-hygiene/SKILL.md) (once per generating script); a schematic diagram passes [`physics-diagrams`](../physics-diagrams/SKILL.md).
- A speedup or performance claim passes its reproducible benchmark gate ([`julia-perf`](../julia-perf/SKILL.md) for Julia code; an equivalent gate for other languages).
- A Julia package change meets [`julia-package`](../julia-package/SKILL.md)'s affected interface and lifecycle checks; these establish package behavior, not independent scientific acceptance.
- Walk the [`research-integrity`](../research-integrity/SKILL.md) M1-M7 checklist immediately before the fold itself.

Then land the folded result (the same obligations apply in engine and file mode):

- Rewrite the affected `research_notebook.md` sections into a coherent scientific account: assumptions and conventions, starting relations, non-obvious derivation steps, results and interpretation, validity limits and unresolved questions. Keep already verified intermediate understanding current; do not wait for whole-project acceptance. Label unverified reasoning explicitly rather than silently treating it as established. Topic notes may carry extended detail, but links or result tables alone do not replace the notebook's load-bearing reasoning.
- Link each adopted result's registered artifact directly from the relevant human `##` section, outside the automatic block, comments and code examples. After rewriting, record the section's `written-against` commit. `notebook.result_links` recognizes direct inline and explicit reference links, not recursive documents, HTML, shortcut references or indented link lines. A `linked` result is a navigation witness only.
- Finish the whole notebook and refresh its automatic block before running `nullius notebook review --model claude/opus` with repeated `--dependency <project-relative-path>` for every required supporting file. This actually executes the existing review-swarm launcher in bounded calls; the default hard timeout is 1200 seconds (`--timeout-secs <N>` overrides it), with no automatic reviewer retry. Freeze the complete UTF-8 notebook, including its automatic block, and declared dependency SHA-256 from actual bytes, including uncommitted edits. A commit or section stamp alone is insufficient. Any changed input bytes make prior acceptance stale; preserve the original review and input identity as readable history.
- Require a reviewer report covering every notebook section, with source anchors and reasons addressing complete derivation steps, logical consistency, notation, definitions, assumptions and conventions. Do not give the reviewer an expected verdict or the writer's initial judgment. Links, automatic tables, formula counts, completed checklists and writing self-assessment cannot supply a content verdict. Semantic review does not prove scientific truth, and a single reviewer leaves limits on model, method and input independence; result-specific verification remains required.
- Run `nullius notebook check --json` without a result selector for final closeout and inspect `nullius current --json`. The read-only check reports `structure` and `content_review` separately; exit 0 requires structural success and an accepted current full-text review, exit 1 means incomplete acceptance (including invalid review evidence), and exit 2 means invalid command/setup input or unavailable execution/runtime. `--result` scopes only the link check; content coverage always remains full-text. `--structure-only` success establishes navigation alone. Missing, partial, failed, unavailable, invalid or stale review leaves closeout incomplete in both file and engine mode; retired historical records remain readable, while every current result participates in the final unscoped structural check.

Read [`references/notebook-review-budget.md`](references/notebook-review-budget.md) when `nullius notebook review` reports a storage, context or budget shortfall, or an unfinished review is resumed with `--resume` (the material-handling, frozen-storage and execution-budget paragraphs, moved there verbatim).

Converged folds invoke the same unscoped `nullius notebook check --json` required
for final file closeout. `none` declarations and a missing launcher grant no
exception. `--result` is a scoped structural diagnostic; it cannot substitute for
the full default check, whose structural scope includes every current result.

- Summarize the durable conclusion in `research_contract.md`.
- Update `research_plan.md#Current Status` with the current state, next step, blockers, and evidence pointers.
- Cite evidence under the parent `artifacts/runs/<run_id>/`, including its `research_team/` payload where relevant.
- Preserve unresolved questions as explicit blockers rather than burying them in chat or transient team logs. When a question needs the project owner's decision, also record it with `nullius decision pending "<question>"` — it stays counted in every status receipt (the oldest ten itemized; the rest via `nullius decision list`) until a later `nullius decision record "<what was decided>" --resolves <id>` closes it, instead of scrolling away in conversation. Use `--relates <id>` when a new decided or pending entry needs non-closing context from an earlier readable entry; do not overload `--resolves` for a standing directive that remains in force. A replayed malformed relation is diagnosed without voiding the containing record. Legacy string kinds remain readable under current `decided` semantics and retain their original spelling in diagnostics: only the exact persisted `pending` kind creates an open item, while an otherwise valid `resolves` on a normalized entry still closes its pending target. Branch-local records carry provisional six-character handles; after all contributing branch tails are merged into the authoritative trunk, run `nullius decision land` there before citing the resulting durable `D<n>` ids. Never land on an unmerged branch; `decisions_unlanded` in the status receipt names work that is not yet ready for durable citation.
- At a milestone handoff or stakeholder plan-summary, produce a **roadmap dependency-map** (summary table + milestone/lane dependency graph + binding-constraint + critical path) via `research-team` (`assets/roadmap_dependency_map_template.md`, rendered with `nullius graph --kind roadmap`). It is a planning view — distinct from the Claim DAG and from `research_plan.md#Current Status`, and it makes "what gates what / what caps feasibility / shortest route to the goal" legible to whoever picks up the work next.
