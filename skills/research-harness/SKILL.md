---
name: research-harness
description: Use when working inside an external research project that has or may need nullius state, research_plan.md, research_contract.md, artifacts/runs, team/runs, Codex/Claude Code continuation, recovery, verification, approval, export, handoff, compute environment/tool readiness validation (import + seeded witness + agent-follows-doc), surviving long-running / kill-prone compute jobs (checkpoint + heartbeat + deadline + resume), an opt-in independent reproduction check (fresh-checkout rerun compared against declared expected values), or a production launch authorization preflight (frozen plan hash + hash-bound review verdicts + exact environment fingerprint before a large production run may start).
---

# Research Harness

Use this skill as the thin project-harness entrypoint for Codex, Claude Code, OpenCode, or other agents inside a real external research project.

It does not replace the research executors. It restores the project state, routes work to the right surface, and makes sure durable conclusions land back in the project contract and run artifacts.

## Authority Map

- `nullius`: generic TS CLI and project lifecycle control plane.
- `research-team`: milestone execution and multi-agent research progress.
- `markdown-hygiene`: standalone Markdown math, TOC, and formatting cleanup before research handoff.
- `hep-mcp`: HEP literature, evidence, INSPIRE/arXiv, bibliography, and export tooling.
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
you do not need to invoke a separate "anchor" command.

The check is also skipped for:

- pure read-only provider queries (`arxiv_search`, `openalex_get`,
  `pdg_find_particle`, `inspire_resolve_citekey`, `hep_health`, etc.;
  full classification per dispatcher in each `*-mcp` package's
  `state-touch-classification.ts`);
- standalone use where `process.cwd()` has no `.nullius/`
  directory (no lifecycle context to drift from);
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
   - `research_notebook.md` when it contains substantive project notes
   - the relevant `artifacts/runs/<run_id>/` and `team/runs/` directories
   - the current main research report linked from
     `project_index.md#Main research report`, when one is promoted

**Anchor on the final adopted version — never build on a superseded one.** A long project accumulates earlier fits, methods, grids, and exploratory scripts; a *newer* adopted result (a better minimum, a more robust method, a finer grid) can silently coexist in the repo with the deprecated ones it replaced. Before extending or varying anything, resolve from the durable record (`research_plan.md#Current Status`, `research_contract.md`, the latest dated `artifacts/runs/<run_id>/`, and any explicit `superseded` / `voided` markers) **which** parameters, method, and configuration are the *current adopted* version — not the first script you happen to open or the most-cited earlier draft. Then **regression-anchor**: run that adopted reference configuration and assert it reproduces its known result (the published χ²/value/pole) *before* trusting any variation built on it. This is the project-state half of the [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md) G4 anchor; skipping it is how work silently gets rebuilt on a stale fit or a retired method.

To pull newer managed scaffold doc (`AGENTS.md`) into an existing project without disturbing user notes, run `nullius init --refresh` (preview with `nullius init --refresh --dry-run`). It backs up any changed managed file under `.nullius/backups/` and never rewrites `research_plan.md`, `research_notebook.md`, `research_contract.md`, `project_charter.md`, `project_index.md`, or `reports/main_research_report_template.md`.

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
- If the task is physics or adjacent scientific literature research, evidence, INSPIRE/arXiv/OpenAlex provider lookup, source reading, bibliography, or export support, use `hep-mcp`. Web search may supplement broad discovery, but it does not replace the provider citation graph gate below.
- If the task is lifecycle, verification, approval, pause/resume, final conclusions, or export, keep it on `nullius`.

**Verification dispatch by result type.** This uses the same event → workflow vocabulary as the trigger table the scaffolded `AGENTS.md` carries (extended here with two harness-local rows, literature survey and prose; the integrity boundary lives in Closeout below); run the matching workflow at the moment the result appears, not on user reminder, and record the result as unverified when the named skill is unavailable:

| Result type | The moment | Verification workflow |
|---|---|---|
| Symbolic derivation | derived a formula, closed form, identity, or a sign/branch/boundary choice that later work will rely on | [`derivation-verify`](../derivation-verify/SKILL.md) |
| Numerical result | a computed number is about to be trusted, compared, or folded into durable artifacts | [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md) |
| Citation-backed claim | wrote citation-backed claims (introduction, related work, discussion) | [`claim-grounding`](../claim-grounding/SKILL.md) |
| Bibliography | freezing a bibliography, or admitting papers into a core reading set | [`citation-triangulation`](../citation-triangulation/SKILL.md) |
| Literature survey | a survey feels thin, or before writing an introduction / related-work section | [`deep-literature-review`](../deep-literature-review/SKILL.md) |
| Data figure | finalized a data or results figure (once per generating script) | [`figure-hygiene`](../figure-hygiene/SKILL.md) |
| Schematic diagram | drew or revised a schematic, process, or geometry diagram | [`physics-diagrams`](../physics-diagrams/SKILL.md) |
| Performance claim | claimed a speedup or performance regression, or wrote performance-critical numerical code | [`julia-perf`](../julia-perf/SKILL.md) (language-scoped; use an equivalent gate for other languages) |
| Independent review | a result, manuscript, derivation, or diff needs independent review | [`review-swarm`](../review-swarm/SKILL.md) |
| Prose / notes | Markdown math, TOC, links, or note hygiene before a handoff or gate | [`markdown-hygiene`](../markdown-hygiene/SKILL.md) |

Do not invent compatibility commands or fallback entrypoints. Keep lifecycle work on `nullius` and route executor or provider work to the relevant skill/tool layer.

## Long-Running Compute Jobs

Real research compute (fits, scans, integrations, derivations) often runs far longer than one agent turn in an environment where the job can be **killed at any time** — contending processes, OS limits, or a closed session. Treat every long job as kill-prone and make it *survive* kills rather than assuming it finishes. The compute runner (`hep-calc` or any executor) runs the computation itself; this harness owns the job's survival.

**Validate readiness in three layers before the first real launch.** "Did you test it?" is not a yes/no answer — name which layer you validated. Before trusting a compute environment, a rebuilt tool, or a documented invocation enough to carry real work, pass three tiers:

1. **Load/import succeeds.** Necessary, cheap, and catches almost nothing interesting.
2. **Seeded witness run.** A tiny, seeded execution that exercises the real computation path and prints a sentinel — output shape/size plus a non-emptiness check. This catches what an import cannot: the tool loads but the computation under test fails at runtime, writes to a read-only location, or silently produces empty output. Record the witness invocation alongside the environment so the identical probe reruns on every rebuild.
3. **Agent follows the doc verbatim.** Spawn a sub-agent that reads the tool's own documented invocation, runs it exactly as documented, and diffs what the doc claims against what actually happened. This is where the documented flag or path turns out to be wrong — it routinely finds blocking bugs on tools whose import-level checks have been green for weeks.

Run the witness on every build; reserve the expensive agent-follows-doc pass for the two moments doc and tool drift apart — after any rebuild/reconfiguration or doc edit, and before declaring the tool ready. Complementary to the [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md): that gate certifies the *numbers* a run produces; this ladder certifies the tool/environment actually runs and its documentation matches reality.

**Launch contract.**

- Write durable state only inside the managed run dir `artifacts/runs/<run_id>/` (human-meaningful tag, never a bare UUID). Never keep durable state in `/tmp`: a kill or a new session loses the results and, if the script also lives there, the code that produced them.
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

**A delegated long job carries an explicit budget contract, and its resource estimate is measured, not guessed.** When a long job is dispatched as a delegated workstream, the coordinator writes a `research-team` delegation budget contract (`delegation_budget_contract_v1`, machine-checked fail-closed — see that skill) before dispatch; a delegated executor's default drift is to refine precision indefinitely and to expand scope, and a delegation without explicit budgets is drift by construction. The contract binds directly onto this harness with an explicit attempt semantics: an **attempt** is a deliberate (re-)entry into the task — the first launch, or a re-run after the approach failed, the deadline fired, or parameters were revised. A checkpoint-resume relaunch after an involuntary host kill *continues the same attempt* (it loses at most the in-flight unit) and does not consume the attempt budget — but every relaunch still lives inside the **time box**, which is the per-task deadline above and bounds the whole workstream in wall-clock terms regardless of how many kills occurred. **max_attempts** caps the deliberate re-entries: exhausting the cap means wrap up from the flushed results and report — never one more try. Time-box expiry likewise ends the current contract even when attempts remain: the two budgets are independent ceilings, and hitting *either* one stops the workstream. Re-budgeting of any kind — more time, more attempts — requires a new coordinator-issued contract, not executor discretion. The **tolerance ceiling** is the stop criterion (reaching it means stop — do not keep refining). And the **peak-memory estimate is mandatory and measured**: run a single unit as a dry run *before* the full launch, read its peak resident-set size (RSS), and launch the full job with an explicit heap cap at or above that measurement. Estimating wall-clock alone is not a resource estimate — memory kills (out-of-memory, swap death) strike long before a time budget does, and they take the whole process, not one unit.

**Commit each stage as cross-session memory.** A kill loses CPU work; a closed session loses the agent's context. Commit each completed stage immediately with a message recording the result *and the lesson*; the git log is a durable record that survives context loss.

**Log dead-ends structurally so a resumed or fresh agent never repeats one.** Append each failed approach to `artifacts/runs/<run_id>/failed_approaches_v1.json`, per the `@nullius/shared` `failed_approaches_v1` contract — `{ approach, why_failed, signal (error|stall|wrong_result|too_expensive|dead_end|superseded), at, evidence_ref?, do_not_retry }`. **`why_failed` is mandatory**: a dead-end recorded without why it failed is not a reusable lesson, and the contract rejects it. **Before starting any new approach, read this log and skip every `do_not_retry` entry** — that is the point, turning "what we already ruled out" from buried git archaeology into a record the next session (or a fresh agent) actually consults. A free-text note is the fallback only when structured logging is unavailable.

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

Semantics, fail-closed by design:

- **Fresh isolation.** The preferred mode checks out committed `HEAD` into a new git worktree and reruns the entry there — whatever is not committed does not exist for the rerun, *by design*: not committed means not reproducible. The fallback (non-git projects, `--isolation copy`) copies the declared `working_inputs` whitelist into a fresh directory; copy mode is strictly weaker — it copies filesystem state as-is, uncommitted edits included, and refuses symlinked inputs. The original working tree is never modified; worktree mode records only removable git bookkeeping metadata (the report carries the exact removal command).
- **No vacuous pass.** Declared artifact paths already present in the fresh checkout (e.g. committed stale outputs) are deleted before the entry runs, so only what the rerun actually regenerates can satisfy the comparison; artifact paths must not be symlinks and must resolve inside the isolated run root. Committed symlinks that resolve outside the fresh checkout are refused outright (checkout-internal relative links are fine). Keep output artifacts gitignored as usual.
- **Default-deny verdict** in `reproduced | mismatch | incomplete | environment_failed`: any expected value outside its tolerance → `mismatch`; entry non-zero exit, timeout, or any value that cannot be extracted → `incomplete`; manifest invalid, manifest not committed clean (worktree mode), or isolation not preparable → `environment_failed`; precedence `environment_failed` over `incomplete` over `mismatch`. The exit code is `0` only for `reproduced`.
- **Tolerance honesty.** The report records, per value, the signed deviation and the deviation-to-tolerance ratio — an agreement is exactly as strong as its declared tolerance, never "same ballpark".
- **Inspection over disposal.** The isolated checkout, entry stdout/stderr logs, and the JSON + Markdown reports are kept under the check's work directory (paths in the report); pass `--cleanup` to remove the checkout once inspected. Copy the two reports into `artifacts/runs/<run_id>/` when folding the outcome back.
- **Environment scrub, then honest limits.** Environment entries that reference the original project tree — textually, through a symlink alias, or through a relative traversal from the run root (a `PYTHONPATH`, `PATH`, or `TMPDIR` component, a venv, and similar) — are dropped from the entry's environment and recorded in the report, so the rerun cannot import uncommitted state through the environment; the check's own work directory (including a `TMPDIR` default) must lie outside the project; on macOS the path comparison is case-folded to match its default case-insensitive filesystem. Beyond that, isolation is checkout-level, not container-level: the entry inherits the rest of the invoking environment and is not sandboxed against absolute-path writes. POSIX (macOS/Linux) only. Declare interpreter/library/data expectations in `environment_note`; the report restates this limitation.
- **What it verifies — and what it does not.** The check catches *accidental* contamination — a result that inadvertently depends on uncommitted edits, stale artifacts, or original-tree code leaking in through the environment. It does not verify that the entry command computes the right thing: the manifest's entry command and extraction rules are trusted input, so an entry that reads the original tree by absolute path or emits numbers without computing them is not caught here. Correctness of the computation itself rests with the numerical-reliability-gate checks and with human review of the entry command recorded in every report; container-level sandboxing is out of scope by design.

This is the execution arm of the [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md) reproduction discipline: its G8 demands that a claimed match to a reference number be *computed, not asserted* — the fresh-checkout rerun is that computation in its strongest form — and its G7 production-setting rule applies to the manifest itself: declare the entry and configuration that produce the recorded values at their production setting, not a cheaper stand-in.

## Production Launch Authorization (A3 Preflight)

Adopt this preflight when a project is about to start a **large production run** — a computation whose output will be trusted downstream and whose cost makes "rerun it under the corrected conditions" expensive. It machine-decides whether the launch preconditions actually hold, instead of trusting the agent's recollection that they do. It targets three observed AI failure modes:

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

Semantics, default refuse:

- **Unambiguous JSON only.** Duplicate JSON object keys are rejected at every nesting level in the authorization record, review verdicts, and observed fingerprint. A duplicate in the record is `invalid_record`; a duplicate in a verdict makes that review invalid and unable to count; a duplicate in the observed fingerprint produces `fingerprint_mismatch`.
- The result is a `launch_authorization_v1` artifact (the shared contract in `@nullius/shared` and `meta/schemas/`). Verdict is one of `authorized | invalid_record | missing_plan_hash | stale_review | missing_review | review_rejected | reviewer_unavailable | fingerprint_mismatch` — every refusal names what was falsified. Exit code is `0` only for `authorized`, `2` for an unusable record, `3` for every other refusal.
- Checks run in a fixed order — `plan_frozen`, `review_binding`, `fingerprint_match` — and the verdict is the first failing check's label. Each check is still evaluated independently for the audit record where possible; a check that cannot be evaluated is recorded `not_evaluated`, which is never a pass.
- Within `review_binding`, when the quorum is unmet the refusal priority is `stale_review` over `review_rejected` over `reviewer_unavailable` over `missing_review`: the sharpest falsification wins, an active rejection outranks unavailability, and unavailability outranks absence. Any verdict bound to a superseded hash — approving or rejecting that older plan version — is stale; `review_rejected` is reserved for a `changes_needed` bound to exactly the live plan hash.
- One reviewer never counts twice (duplicate reviewer ids make the record invalid), and a quorum larger than the listed reviews is invalid by construction. A void verdict — unavailable, bound to a superseded hash, missing, or malformed — never counts as approval, and it also never vetoes a quorum already met by approvals bound to the live plan hash: the quorum the record declares is the requirement, so list only reviewers whose approval you require (or raise `required_approvals`) if every listed verdict must be live.
- The result JSON is always printed on stdout; `--output` additionally persists it atomically. If the authorization record is unreadable or cannot be parsed unambiguously, no `--output` file is written at all because its declared input paths cannot be recovered safely; the labeled refusal artifact remains available on stdout. Otherwise the `--output` write is guarded on every exit path: an `--output` that aliases the record, the observed fingerprint, or any path the record declares (however malformed the declaration) — including hard links, symlinks, and case-colliding names, even for files that do not exist yet — is never written and the run exits `2`; a failed `--output` write likewise makes the checker exit `2` even for an authorized verdict, because an authorization whose requested audit artifact cannot be persisted is refused.
- **Honest limits.** The plan file is read once and that content hashed for every comparison, so the check itself has no read-then-reuse window; but it cannot prevent the plan or environment changing *after* it exits — run it immediately before launch in the same command chain, as above. The record and verdict files are trusted filesystem inputs: the gate proves *consistency* (hashes bound, fingerprints equal), not *authenticity* — protecting those files is commit discipline. Independence of the reviewers is governed by the review process itself (see `review-swarm`), not by this checker.

This preflight is the machine arm of the A3 (`compute_runs`) gate — the shared gate registry's A3 policy names `launch_authorization_v1` as its result contract, so launchers know what to produce. The enforcement locus is the **project-side launcher**: chain the checker before the production command as shown above; the engine's bounded-computation runner does not invoke it. In projects using the engine's approval flow, `nullius approve <A3-...>` records the *human* go-ahead; this preflight checks the *technical* launch preconditions at the moment of launch. They are complementary: neither substitutes for the other.

## Literature Research Gate

For physics or adjacent scientific literature research routed through `hep-mcp`, citation graph checks are mandatory workflow steps, not optional keyword triggers.

Web search may be used first or in parallel to discover candidate papers, non-indexed materials, experimental pages, proceedings, code, or broader context. Before making literature-map claims, normalize core candidate papers to stable identifiers such as INSPIRE recid, arXiv id, DOI, or OpenAlex id and use `hep-mcp` provider tools for citation graph authority.

Minimum expectations:

- Treat `50` as a default page/initial-batch size, not a completion threshold. Literature work is complete only after a saturation artifact records provider coverage, candidate-pool rationale, and citation/reference graph checks.
- For each seed or core paper, check both directions when relevant: papers it references and papers citing it.
- For claims about paper relationships, source priority, review status, influence, or literature gaps, inspect the citation/reference graph with `hep-mcp` provider tools; do not rely only on search snippets or web pages.
- For writing-facing work, build or validate bibliography/citation artifacts through `hep-mcp` rather than hand-maintaining citekey authority from web search.

Useful `hep-mcp` routes include:

- Resolve identifiers first through the available provider route: INSPIRE recid, arXiv id, DOI, or OpenAlex id.
- INSPIRE citation/reference graph when covered: `inspire_literature(mode=get_references, recid=...)` and `inspire_literature(mode=get_citations, recid=..., sort=...)`.
- Cross-paper graph inside the provider layer: `inspire_find_connections` or `inspire_network_analysis`.
- arXiv/source checks: use arXiv/provider routes for preprints, versions, and source text when the task depends on the actual paper source.
- OpenAlex/cross-domain checks: use OpenAlex/provider routes when the paper is outside clean INSPIRE coverage or when broader cross-field citations may matter.
- Writing allowlist / citekey mapping: `hep_run_build_citation_mapping`.

If `hep-mcp` or a needed provider is unavailable, state that limitation explicitly and do not present the citation graph as complete.

## Fold Results Back

`research-team` output is not complete while it only lives in `team/runs` as an unreferenced log: the durable conclusion must land in the project contract and plan, with evidence pointers. `team/runs/<run>/` itself is a first-class evidence root alongside `artifacts/runs/<run_id>/` — cite the path that actually holds the evidence; do not copy files between roots just to satisfy a pointer convention.

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

- A computed number passes the [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md) — converged under refinement (no coarse-grid mirage), agreed across `>=2` orthogonal methods, and regression-anchored. A coarse, intermediate, or non-converged value is labeled as such or discarded, never silently promoted.
- A derived formula, identity, or sign/branch choice passes [`derivation-verify`](../derivation-verify/SKILL.md) (at least two independent blind re-derivations) before downstream work consumes it.
- A citation-backed claim passes [`claim-grounding`](../claim-grounding/SKILL.md); a bibliography being frozen passes [`citation-triangulation`](../citation-triangulation/SKILL.md).
- A data figure passes [`figure-hygiene`](../figure-hygiene/SKILL.md) (once per generating script); a schematic diagram passes [`physics-diagrams`](../physics-diagrams/SKILL.md).
- A speedup or performance claim passes its reproducible benchmark gate ([`julia-perf`](../julia-perf/SKILL.md) for Julia code; an equivalent gate for other languages).
- Walk the [`research-integrity`](../research-integrity/SKILL.md) M1-M7 checklist immediately before the fold itself.

Then land the folded result:

- Summarize the durable conclusion in `research_contract.md`.
- Update `research_plan.md#Current Status` with the current state, next step, blockers, and evidence pointers.
- Cite the relevant run evidence where it lives — under `artifacts/runs/<run_id>/` or `team/runs/<run>/`. Mirroring into `artifacts/runs/<run_id>/` is optional: do it when the source location is transient, or when a milestone's headline evidence should live with the run record.
- Preserve unresolved questions as explicit blockers rather than burying them in chat or transient team logs. When a question needs the project owner's decision, also record it with `nullius decision pending "<question>"` — it stays counted in every status receipt (the oldest ten itemized; the rest via `nullius decision list`) until a later `nullius decision record "<what was decided>" --resolves <id>` closes it, instead of scrolling away in conversation.
- At a milestone handoff or stakeholder plan-summary, produce a **roadmap dependency-map** (summary table + milestone/lane dependency graph + binding-constraint + critical path) via `research-team` (`assets/roadmap_dependency_map_template.md`, rendered with `nullius graph --kind roadmap`). It is a planning view — distinct from the Claim DAG and from `research_plan.md#Current Status`, and it makes "what gates what / what caps feasibility / shortest route to the goal" legible to whoever picks up the work next.

## Closeout

Before handing off or claiming completion, run the narrowest applicable closeout command:

```bash
nullius verify
nullius final-conclusions
nullius approve <approval_id>
nullius decision record "<what was decided>" --by <who>
nullius export --run-id <run_id>
nullius report-validate
```

Use the command that matches the project state. If approval is pending, stop at the approval boundary and report the exact approval id and evidence path. In projects that do not use the engine's approval flow (declared `execution_mode: file`, or any project where the go-ahead was given in conversation), record that go-ahead with `nullius decision record` at the closeout boundary — it is the engine-visible counterpart of the approval receipt, and open questions recorded with `nullius decision pending` stay counted in every status receipt (the oldest ten itemized; the rest via `nullius decision list`) until resolved.

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
  build on,
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
