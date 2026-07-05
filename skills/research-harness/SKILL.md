---
name: research-harness
description: Use when working inside an external research project that has or may need autoresearch state, research_plan.md, research_contract.md, artifacts/runs, team/runs, Codex/Claude Code continuation, recovery, verification, approval, export, handoff, compute environment/tool readiness validation (import + seeded witness + agent-follows-doc), surviving long-running / kill-prone compute jobs (checkpoint + heartbeat + deadline + resume), or an opt-in independent reproduction check (fresh-checkout rerun compared against declared expected values).
---

# Research Harness

Use this skill as the thin project-harness entrypoint for Codex, Claude Code, OpenCode, or other agents inside a real external research project.

It does not replace the research executors. It restores the project state, routes work to the right surface, and makes sure durable conclusions land back in the project contract and run artifacts.

## Authority Map

- `autoresearch`: generic TS CLI and project lifecycle control plane.
- `research-team`: milestone execution and multi-agent research progress.
- `markdown-hygiene`: standalone Markdown math, TOC, and formatting cleanup before research handoff.
- `hep-mcp`: HEP literature, evidence, INSPIRE/arXiv, bibliography, and export tooling.

## Recovery First

Work from the external project root, not from the `autoresearch-lab` development repo.

1. If `.autoresearch/HARNESS` exists, treat it as the machine-readable runtime handshake: a status receipt is required before new work, milestone execution, closeout, or handoff.
2. Prefer the project-local CLI when it exists:
   ```bash
   ./.autoresearch/bin/autoresearch status --json
   ```
3. Otherwise use the installed CLI:
   ```bash
   autoresearch status --json
   ```

A successful `status --json` call also refreshes the session-level anchor
marker at `.autoresearch/HARNESS_INVOCATION`. Every `*-mcp` dispatcher
(`arxiv-mcp`, `hep-mcp`, `hepdata-mcp`, `idea-mcp`, `openalex-mcp`,
`pdg-mcp`, `zotero-mcp`) verifies this marker for state-touching tool
calls and fails closed with `HARNESS_INVOCATION_REQUIRED` when the marker
is missing, malformed, or older than the most recent change to
`.autoresearch/state.json` or `.autoresearch/ledger.jsonl`. The check is
**event-driven, not clock-based**: once you anchor against current
project state, the anchor stays valid until project state actually
changes — long thinking / reading between tool calls does not invalidate
the anchor. Re-run `status --json` after any lifecycle event (own or
other-process `autoresearch run`/`approve`/`verify`/...) to re-anchor;
you do not need to invoke a separate "anchor" command.

The check is also skipped for:

- pure read-only provider queries (`arxiv_search`, `openalex_get`,
  `pdg_find_particle`, `inspire_resolve_citekey`, `hep_health`, etc.;
  full classification per dispatcher in each `*-mcp` package's
  `state-touch-classification.ts`);
- standalone use where `process.cwd()` has no `.autoresearch/`
  directory (no lifecycle context to drift from);
- `AUTORESEARCH_HARNESS_VERIFY=skip` env override (escape hatch) and
  `NODE_ENV=test` default.
4. If `.autoresearch/` exists but `.autoresearch/HARNESS` is missing, or if both entrypoints are unavailable, repair only the runtime handshake and launcher, then retry the project-local CLI:
   ```bash
   autoresearch init --runtime-only
   ./.autoresearch/bin/autoresearch status --json
   ```
   If `autoresearch` is not on `PATH`, run the same one-time repair through your autoresearch checkout (substitute its absolute path):
   ```bash
   node /absolute/path/to/autoresearch-lab/packages/orchestrator/dist/cli.js init --runtime-only
   ```
5. Read and align the durable project surfaces:
   - `research_plan.md`, especially `# Current Status`
   - `research_contract.md`
   - `research_notebook.md` when it contains substantive project notes
   - the relevant `artifacts/runs/<run_id>/` and `team/runs/` directories

**Anchor on the final adopted version — never build on a superseded one.** A long project accumulates earlier fits, methods, grids, and exploratory scripts; a *newer* adopted result (a better minimum, a more robust method, a finer grid) can silently coexist in the repo with the deprecated ones it replaced. Before extending or varying anything, resolve from the durable record (`research_plan.md#Current Status`, `research_contract.md`, the latest dated `artifacts/runs/<run_id>/`, and any explicit `superseded` / `voided` markers) **which** parameters, method, and configuration are the *current adopted* version — not the first script you happen to open or the most-cited earlier draft. Then **regression-anchor**: run that adopted reference configuration and assert it reproduces its known result (the published χ²/value/pole) *before* trusting any variation built on it. This is the project-state half of the [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md) G4 anchor; skipping it is how work silently gets rebuilt on a stale fit or a retired method.

To pull newer managed scaffold doc (`AGENTS.md`) into an existing project without disturbing user notes, run `autoresearch init --refresh` (preview with `autoresearch init --refresh --dry-run`). It backs up any changed managed file under `.autoresearch/backups/` and never rewrites `research_plan.md`, `research_notebook.md`, `research_contract.md`, `project_charter.md`, or `project_index.md`.

If no project state exists and the user is in a real external research root, initialize with:

```bash
autoresearch init
```

If `autoresearch` is unavailable on `PATH`, run the same one-time setup through your
autoresearch checkout (substitute its absolute path) to create the project-local fallback:

```bash
node /absolute/path/to/autoresearch-lab/packages/orchestrator/dist/cli.js init --runtime-only
```

## Route The Work

- If the research question is still not scoped, create a plan with:
  ```bash
  autoresearch workflow-plan --recipe research_brainstorm
  ```
- If the user needs milestone execution, invoke `research-team` and keep the milestone boundary explicit.
- If a compute environment, tool build, or documented invocation is new, rebuilt, or reconfigured, pass the three-layer readiness validation (under Long-Running Compute Jobs below) before routing real work onto it.
- If the task is Markdown formatting, Markdown math escaping, generated TOC LaTeX cleanup, link/citation clickability, or pre-handoff note hygiene, invoke `markdown-hygiene` first, then rerun the relevant project gate.
- If the task is physics or adjacent scientific literature research, evidence, INSPIRE/arXiv/OpenAlex provider lookup, source reading, bibliography, or export support, use `hep-mcp`. Web search may supplement broad discovery, but it does not replace the provider citation graph gate below.
- If the task is lifecycle, verification, approval, pause/resume, final conclusions, or export, keep it on `autoresearch`.

Do not invent compatibility commands or fallback entrypoints. Keep lifecycle work on `autoresearch` and route executor or provider work to the relevant skill/tool layer.

## Long-Running Compute Jobs

Real research compute (fits, scans, integrations, derivations) often runs far longer than one agent turn in an environment where the job can be **killed at any time** — contending processes, OS limits, or a closed session. Treat every long job as kill-prone and make it *survive* kills rather than assuming it finishes. The compute runner (`hep-calc` or any executor) runs the computation itself; this harness owns the job's survival.

**Validate readiness in three layers before the first real launch.** "Did you test it?" is not a yes/no answer — name which layer you validated. Before trusting a compute environment, a rebuilt tool, or a documented invocation enough to carry real work, pass three tiers:

1. **Load/import succeeds.** Necessary, cheap, and catches almost nothing interesting.
2. **Seeded witness run.** A tiny, seeded execution that exercises the real computation path and prints a sentinel — output shape/size plus a non-emptiness check. This catches what an import cannot: the tool loads but the computation under test fails at runtime, writes to a read-only location, or silently produces empty output. Record the witness invocation alongside the environment so the identical probe reruns on every rebuild.
3. **Agent follows the doc verbatim.** Spawn a sub-agent that reads the tool's own documented invocation, runs it exactly as documented, and diffs what the doc claims against what actually happened. This is where the documented flag or path turns out to be wrong — it routinely finds blocking bugs on tools whose import-level checks have been green for weeks.

Run the witness on every build; reserve the expensive agent-follows-doc pass for the two moments doc and tool drift apart — after any rebuild/reconfiguration or doc edit, and before declaring the tool ready. Complementary to the [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md): that gate certifies the *numbers* a run produces; this ladder certifies the tool/environment actually runs and its documentation matches reality.

**Launch contract.**

- Write durable state only inside the managed run dir `artifacts/runs/<run_id>/` (human-meaningful tag, never a bare UUID). Never keep durable state in `/tmp`: a kill or a new session loses the results and, if the script also lives there, the code that produced them.
- Keep the compute script in the repo (committed), not in `/tmp`. Stream stdout to a log *inside the run dir* (`<cmd> 2>&1 | tee artifacts/runs/<run_id>/<job>.log`) for tailing; the log is for eyeballing, the checkpoint is the durable record.
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

**Survive dropped notifications with a self-re-arming heartbeat.** The host's "job done / killed" signal can be silently dropped, stranding the agent on a dead job. Arm a host-provided wall-clock self-wake (in Claude Code, `ScheduleWakeup`) at a cadence ≈ 2–3× the observed kill interval. Each wake must: (1) re-derive ground truth from the filesystem — checkpoint line count vs expected, and whether the process is still alive — never trusting the notification; (2) if the job was killed mid-run, relaunch it (the checkpoint resumes) **and re-arm the next wake**; (3) if it is done, report + commit + advance, and do **not** re-arm. The self-re-arming chain means one dropped notification can never strand the job. Stop the chain once completion is confirmed — do not leave heartbeats firing forever.

Use the bundled probe instead of brittle `until ! pgrep …; sleep` loops (which burn turn budget, can mis-match the agent's own session, and can SIGPIPE the job via a stray `| head`):

```bash
python3 scripts/compute_job_probe.py --pattern "<job-script-name>" \
    --checkpoint artifacts/runs/<run_id>/<job>.tsv --expected <N>
```

It captures `pgrep` (SIGPIPE-safe, never pipes) and prints JSON `{running, checkpoint_count, deadline_fired, verdict}` with `verdict ∈ running | stalled | completed | deadline_reached | killed_incomplete | stopped`: `killed_incomplete` → relaunch; `completed` → all expected units are recorded, so scan the checkpoint for any sentinel-failed rows before folding back; `stalled` → livelock (below); `deadline_reached` → the task's own time budget expired, not a crash (below).

**Detect and break livelock.** If a single unit takes longer than the kill window minus startup overhead, the per-unit checkpoint can never land — the job relaunches forever and the checkpoint count stays flat. The probe reports `stalled` when the count is unchanged across `--stall-window` consecutive checks. Then **stop relaunching** and re-decompose: shrink the unit, or replace it with a finer-grained, **independently cross-validated** cheaper surrogate — never a silently-substituted approximation (that is papering over a result, forbidden). Keep the expensive original in-repo as a record of why.

**Give each task its own deadline, and keep "deadline reached" distinct from "crashed".** A host kill is involuntary and strikes mid-unit; a per-task deadline is a time budget you set — below the host kill window — so the task stops deliberately, at a point the session can still act on. Arrange the launch so that when the budget expires, the job or its wrapper writes a deadline marker file next to the checkpoint (the probe's default is `<checkpoint>.deadline`; e.g. map a `timeout` wrapper's expiry exit status to writing the marker, or have the job's own elapsed-time check write it and exit at a unit boundary). The probe then reports `deadline_reached` instead of `killed_incomplete`: a time boundary, not a failure — so do not reflexively relaunch. Choose deliberately: resume from the checkpoint with a larger budget, resubmit where the time window is longer, or re-decompose into smaller units. Consume (delete) the marker as part of acting on it, so the next probe reads clean. Without the distinct signal, every time boundary is misread as a crash and blindly relaunched — burning the budget again to hit the same wall.

**Commit each stage as cross-session memory.** A kill loses CPU work; a closed session loses the agent's context. Commit each completed stage immediately with a message recording the result *and the lesson*; the git log is a durable record that survives context loss.

**Log dead-ends structurally so a resumed or fresh agent never repeats one.** Append each failed approach to `artifacts/runs/<run_id>/failed_approaches_v1.json`, per the `@autoresearch/shared` `failed_approaches_v1` contract — `{ approach, why_failed, signal (error|stall|wrong_result|too_expensive|dead_end|superseded), at, evidence_ref?, do_not_retry }`. **`why_failed` is mandatory**: a dead-end recorded without why it failed is not a reusable lesson, and the contract rejects it. **Before starting any new approach, read this log and skip every `do_not_retry` entry** — that is the point, turning "what we already ruled out" from buried git archaeology into a record the next session (or a fresh agent) actually consults. A free-text note is the fallback only when structured logging is unavailable.

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

`research-team` output is not complete while it only lives in `team/runs`.

After a milestone or run produces a stable result:

- Fold in only numbers that pass the [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md) — converged under refinement (no coarse-grid mirage), agreed across `>=2` orthogonal methods, and regression-anchored. A coarse, intermediate, or non-converged value is labeled as such or discarded, never silently promoted.
- Summarize the durable conclusion in `research_contract.md`.
- Update `research_plan.md#Current Status` with the current state, next step, blockers, and evidence pointers.
- Link or copy the relevant run evidence under `artifacts/runs/<run_id>/`.
- Preserve unresolved questions as explicit blockers rather than burying them in chat or transient team logs.
- At a milestone handoff or stakeholder plan-summary, produce a **roadmap dependency-map** (summary table + milestone/lane dependency graph + binding-constraint + critical path) via `research-team` (`assets/roadmap_dependency_map_template.md`, rendered with `autoresearch graph --kind roadmap`). It is a planning view — distinct from the Claim DAG and from `research_plan.md#Current Status`, and it makes "what gates what / what caps feasibility / shortest route to the goal" legible to whoever picks up the work next.

## Closeout

Before handing off or claiming completion, run the narrowest applicable closeout command:

```bash
autoresearch verify
autoresearch final-conclusions
autoresearch approve <approval_id>
autoresearch export --run-id <run_id>
```

Use the command that matches the project state. If approval is pending, stop at the approval boundary and report the exact approval id and evidence path.

Before invoking `autoresearch approve` for any A1-A5 gate (and before
folding a result into `research_contract.md` or
`research_plan.md#Current Status`), run the `research-integrity` skill's
M1-M7 pre-approval ritual. M1-M7 is the agent-side discipline that
catches hallucinated citations, hallucinated measurements, shortcut
graph claims, bugs-as-insights, methodology fabrication, and frame-lock
before they reach the durable record. The machine gates and the
`HARNESS_INVOCATION_REQUIRED` anchor remain authoritative; the
integrity check is owed to the next agent who reads your work.
