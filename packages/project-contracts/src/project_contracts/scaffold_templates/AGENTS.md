# AGENTS.md

This file anchors the workflow for this research project.
Use it as the restart checklist before any new milestone, context switch, or long pause.

## Read order

1) [project_index.md](project_index.md)
2) [AGENTS.md](AGENTS.md)
3) [project_charter.md](project_charter.md)
4) [research_plan.md](research_plan.md)
5) [research_contract.md](research_contract.md)
6) [research_notebook.md](research_notebook.md) (when it already contains substantive content)

## Quick rules

- Human notebook: `research_notebook.md`
- Main research report entry point: `project_index.md#Main research report`
- Machine contract: `research_contract.md`
- Evidence-first: every meaningful action writes auditable artifacts under `artifacts/runs/<run_id>/` (lifecycle and compute runs) or `team/runs/<run>/` (milestone-executor review cycles); both are first-class evidence roots — cite the one that actually holds the evidence. A run directory records a unit of work worth auditing — a milestone candidate, a computation, a review cycle; development iteration toward that unit (diagnostics, build fixes, retries) is logged inside the unit's run directory, not minted as a fresh run per attempt.
- `run_id` names the project-local research run. Prefer a safe, sortable, readable shape such as `<YYYYMMDDTHHMMSSZ>-<milestone>-<short-topic>-rN`; do not use bare UUIDs, `run_<uuid>`, path separators, `..`, or low-information generated names as human-facing run IDs.
- Approval checkpoints: final-conclusion approval (A5) is always enforced through the finalize flow. Heavy-compute approval (A3) is opt-in — off by default so interactive work is not paused; set `require_approval_for.compute_runs: true` in `.nullius/approval_policy.json` to gate unattended runs. A1/A2/A4 (broad search, code/logic changes, manuscript edits) are advisory reminders, not hard blocks.
- Keep `research_plan.md#Current Status` current enough that a researcher can see the final target, completion state, blocker, next step, and stop condition without reading the full log — and small enough to actually be read: the status field table stays within one screen: its progress cells (`Done`, `Evidence pointers`) describe the **current phase only**, while the target and closure fields (`Final target`, `Closure / stop condition`) remain project-global; each **completed** milestone collapses to one line in the plan's Milestone history table, linking its closeout record. Narrative detail, per-round histories, and long evidence inventories sink into the linked closeout documents and `artifacts/runs/<run_id>/`; a status section every coordination session must re-read is a standing tax on every session.
- Keep the task board in `research_plan.md` current enough that a new agent run can resume without relying on memory.
- Keep `research_notebook.md` organized by the problem's logic. Do not use it for status tracking. Do not append large dated run logs there; put run logs in `research_plan.md` progress entries or `artifacts/runs/<run_id>/`, then fold durable insights into the relevant notebook sections.
- Keep checkpoint/status/closeout summaries, immutable main research reports, and machine provenance distinct. Before promoting a report, create a new file under `reports/`, update the current pointer and supersession registry in `project_index.md`, and run `nullius report-validate`. Never overwrite a registered report or use JSON/JSONL/hash/receipt artifacts in place of explanatory narrative and clickable human-readable evidence.

## Verification triggers (event → workflow)

Verification runs on events, not on reminders: each moment below is the trigger, and each names the workflow that gates that kind of result. When the host agent exposes the named skill, run it at that moment without waiting to be asked; when it does not, record the result as unverified instead of skipping the check silently.

| The moment | Verification workflow |
|---|---|
| Derived a formula, closed form, identity, or a sign/branch/boundary choice that later work will rely on | `derivation-verify` — at least two independent blind re-derivations |
| A computed number that a conclusion or durable artifact will rest on is about to be trusted, compared, or folded in (a number whose only consumer is a test, a fixture, or internal tooling is covered by ordinary tests; a diagnostic that establishes a headline claim's convergence is result-bearing, not exempt) | `numerical-reliability-gate` — convergence, independent methods, regression anchor |
| Wrote citation-backed claims (introduction, related work, discussion) | `claim-grounding` — fetch each cited source and verify it supports the claim |
| Freezing a bibliography, or admitting papers into a core reading set | `citation-triangulation` — cross-index metadata agreement per entry |
| Finalized a data or results figure (once per generating script) | `figure-hygiene` — data fidelity and legibility checklist |
| Drew or revised a schematic, process, or geometry diagram | `physics-diagrams` — layout and publication-readiness audit |
| Claimed a speedup or performance regression, or wrote performance-critical numerical code | `julia-perf` — language-scoped benchmark gating; use an equivalent gate for other languages |
| A result-bearing surface needs independent review: a headline result, manuscript, load-bearing derivation, public contract, or an irreversible change (internal scaffolding diffs close on local tests plus a single reviewer — never on the author's own tests alone) | `review-swarm` — clean-room cross-model review |
| Before conclusions, a milestone closeout, or a handoff | `research-integrity` M1-M7 — record the outcome inline and land run evidence under `artifacts/runs/<run_id>/` or `team/runs/<run>/` |
| Before promoting or superseding the main research report | `nullius report-validate` — fail closed on structural incompleteness, stale current pointers, mutated history, machine-only evidence, or replay mislabeled as independent validation |
| Created a run directory under `artifacts/runs/` | `nullius trace stamp <run_id>` — bind the run to the exact code state producing it, at the moment the binding is exact |
| A result replaced an earlier run's, or a run's output was found wrong | `nullius trace supersede <old> --by <new> --reason "..."` (or `nullius trace void <run_id> --reason "..."`) — record it on the validity ledger while the reason is fresh |
| A headline result converged, or you need to know which results and runs currently count | `nullius result set-current` to register; `nullius current` to read the whole answer — current results, producing code revision, manuscript pointer, notebook staleness, run validity — as prose |
| `nullius status --json` reports the notebook's current-state block missing or OUT OF SYNC (it is machine-maintained; never edit between its markers) | `nullius notebook sync` — insert or refresh the block; ledger-writing commands normally refresh it themselves |

## Verification granularity and severity

The triggers above bind to result-bearing moments; how much verification a moment deserves follows five rules:

- **The reviewed unit is a stable candidate** — a milestone result or a stable interface version — never each patch on the way there. Iterate freely in bounded development (diagnostic runs and targeted tests inside the delegated time box are development work, not budgeted attempts), merge all known blocking fixes into one stabilized candidate, then run the review pair once on the frozen candidate. Full independent verification (cross-model review, independent executing reproduction, blind re-derivation) is reserved for result-bearing surfaces: headline claims, load-bearing derivations, public contracts. Internal plumbing stabilizes under local tests plus a single-reviewer pass.
- **Review findings are severity-graded.** Blocking: changes a recorded result, invalidates a verification claim, breaks input identity / target-value isolation / origin traceability, is a mismatch or failure inside the declared reproduction scope, or is a Major Gap inside the declared scope — fix and re-review. Non-blocking (hardening beyond declared scope, style): give each an explicit disposition — fix now, attach to a named acceptance point, or discard with a stated reason — never a silent drop. Non-blocking findings by themselves do not trigger a new round; any fix batch actually applied still gets its delta-scoped confirmation round. After a candidate passes a full review pair, later findings re-open it only if they meet the blocking bar (they still get their disposition).
- **Confirmation rounds review the delta.** After a fix batch, the mandatory re-review covers the exact diff from the reviewed baseline plus a findings-to-resolutions table; escalate to the full artifact when formulas/assumptions, the data model or a global invariant, or an origin-traceability root changed, or when a reviewer asks. Convergence is declared by the reviewers, never by the fixer.
- **Performance never blocks correctness.** Resource ceilings exist to terminate runaway processes, not to gate progress; benchmark evidence is owed when a speedup claim is made or production-scale computation begins, never before a correct kernel exists. Run records hash frozen inputs and completed outputs only — status summaries and registries that the lifecycle rewrites stay out of every hash closure (supersede, don't re-hash).
- **Process artifacts are not progress.** If three consecutive runs or rounds produced only contracts, reviews, adjudications, and re-hashes — no new number, derivation, figure, code capability, or decided narrowing — the work is stalled, and another round is not an allowed response: consolidate into one stabilized candidate, narrow the scope, re-plan, or put the blocking question to the project owner. State progress in `research_plan.md#Current Status` in terms of the scientific object that advanced, never as a review-round counter.

## Scientific writing discipline

- In project notes, notebooks, plans, and conclusions, use the field's native scientific language rather than engineering, product, or delivery metaphors.
- Do not describe scientific reasoning as `pinning down`, `closing the loop`, `bridging`, `building a pipeline`, `opening a surface`, `running a lane`, shipping, delivery, roadmap execution, or similar software-project metaphors.
- Do not call a derivation, comparison, fit, uncertainty estimate, bound, or scientific argument a `certificate`, `instantiation`, or `guardrail` unless that is genuinely the correct software, security, formal-mathematics, or toolchain term.
- Use those words only when they name a literal domain concept or when the subject is actual code, tooling, automation, environments, repository operations, control systems, or other software-maintenance work.
- When writing about the science itself, prefer the project's physical, mathematical, experimental, statistical, or numerical concepts.
- Prefer precise scientific verbs such as derive, estimate, bound, test, compare, constrain, check, identify assumptions, separate regimes, quantify uncertainty, and relate observables.

## Literature note quality and reading depth

- Treat abstracts as triage only. Do not use an abstract-only reading as decisive evidence for an important or directly related paper.
- For important or directly related papers, read the full text. If arXiv LaTeX source is available, prefer reading the source; otherwise use available full-text access such as PDF, Zotero, Crossref, library, or browser tools.
- If the host provides a `crossref` full-text skill or helper, for example a local `crossref` skill, it may be used to obtain a full-text PDF.
- Record the source form read for each core source: `latex_source`, `full_text_pdf`, `available_full_text`, `abstract_only`, or `unavailable`.
- If full text cannot be obtained, record the missing source and ask the project owner to provide it before relying on the paper for a central claim. Do not present `abstract_only` or `unavailable` as read evidence for central claims.
- Literature notes should record scientific content, not tool-use logs. Put search traces, metadata checks, download attempts, and API/tool call details in [research_plan.md](research_plan.md) progress entries or `artifacts/runs/<run_id>/`.
- Each important-paper literature note must include auditable reading coverage: sections/pages/equations/figures actually read, central equations and assumptions, what was not read and why, project relevance, limitations, and remaining reading gaps.
- Include stable reading provenance needed for later scientific use: source form read, relevant sections/pages/equations, claims used, limitations, and remaining reading gaps.
- Do not write only "PDF-body read for X"; include the concrete section/page/equation/figure coverage above.
- Format arXiv, DOI, PDF, source, library, and project-file references as clickable Markdown links. Do not leave bare URLs in literature notes.

## Nullius session start protocol

- If `.nullius/HARNESS` exists, this is a managed nullius project. Before any new session, reconnect, interruption recovery, context reset, handoff, milestone start, or closeout, run `.nullius/bin/nullius status --json`; if that project-local launcher is unavailable, run `nullius status --json`.
- If the host agent exposes a `research-harness` skill or equivalent project-harness entrypoint, use that entrypoint first for reconnect, recovery, routing, verification, and handoff. It restores this project's durable state and then routes lifecycle work to `nullius`, milestone execution to `research-team`, and provider/domain work to the relevant tool layer.
- On `new session`, `reconnect`, `interruption`, `context reset`, or `handoff`, if `.nullius/` exists but `.nullius/HARNESS` is missing, run `nullius status --json` before taking any new action, then repair the runtime handshake with `nullius init --runtime-only`.
- If `nullius` is unavailable on `PATH`, run `.nullius/bin/nullius status --json` instead.
- Treat `nullius` as the guaranteed root entrypoint for this scaffold.
- Treat that status output as the authoritative recovery briefing for the current run, recovery context, plan view, and bounded workflow outputs.
- After reading status, start with [research_plan.md#Current Status](research_plan.md#current-status), continue through the checked-in files in the order above, and read [research_notebook.md](research_notebook.md) only when it already contains substantive content.
- When the host exposes orchestration or MCP control-plane commands such as `orch_*`, those host-local surfaces may be used as optional control planes; do not assume a literal `orch_*` command exists in every scaffolded project.
- Provider/domain MCP tools are capability sources, not root authority; do not treat provider MCPs such as `hep-mcp` as the generic root authority.
- If any A1-A5 approval is pending, stop there. Silence is never approval.
- If evidence is incomplete, mark the state `uncertain`, `abstained`, `unavailable`, or as a reading gap instead of writing a stronger conclusion.

## Execution mode (engine vs file)

Two legitimate ways to run a project, declared with `nullius init --mode=<engine|file>` (re-runnable any time to change the declaration) and surfaced as `execution_mode` in the status receipt:

- `engine`: the nullius run/approve lifecycle drives the work; approvals flow through `nullius approve`.
- `file`: work is executed by hand or by external runners; durable truth lives in `research_plan.md`, `research_contract.md`, and the run-evidence roots, and `run_status` legitimately stays `idle`.
- In both modes, decisions made in conversation are recorded with `nullius decision record "<what was decided>"` (open questions with `nullius decision pending "<question>"`; close one with `nullius decision record "<answer>" --resolves <id>`; attach non-closing context with `--relates <id>` on either kind). `--resolves` closes only an earlier open pending entry, while `--relates` may point to an earlier readable decided or pending entry without changing open counts. Open items stay counted in every status receipt (the oldest ten itemized, the remainder via `nullius decision list`) until resolved. On replay, an unrecognized persisted relation is reported and ignored without voiding its record; a legacy or unknown non-empty string kind remains readable under current decided semantics, with its original kind noted. Only the exact persisted pending kind creates an open item, while an otherwise valid `resolves` on a normalized entry still closes its pending target. Newly recorded entries carry provisional six-character branch handles and locally avoid retained mappings. After branch entries have reached the authoritative trunk, run `nullius decision land` there to assign permanent `D<n>` ids and rewrite handle-valued relations; never land on an unmerged branch. Existing `D<n>` ledgers remain valid without migration. A repeated current id or non-one-to-one retained provisional mapping is a fail-closed ledger defect that must be repaired before adding relations or landing. In file mode this ledger is the engine-visible record of conversational approvals.
- An undeclared project whose engine state stays frozen while dated run evidence accumulates gets a status hint asking for the declaration; either declaration is honest and silences it.
- The verification triggers above apply identically in both modes.

## Markdown and links

- Prefer Markdown links over bare URLs in project docs and agent notes.
- Use relative Markdown links for files inside the project so the scaffold remains portable across machines.
- Keep link labels semantic and stable; avoid dumping raw paths inline when a short label is clearer.
- When citing artifacts or outputs in Markdown, point to the canonical project-relative path or artifact URI instead of prose-only references.
- Inline math must use `$...$`.
- Display math must use fenced `$$ ... $$`.
- Do not wrap scientific notation in backticks: physical quantities, formulas, variables, operators, state vectors, cross sections, S-matrix elements, transfer functions, equations, and assumptions are LaTeX math.
- Backticks are only for filenames, commands, literal field or key names, and code identifiers.
- Only inside multi-line display math blocks, do not start a continuation line with `+`, `-`, or `=`.
- Plain Markdown prose lines are not subject to the `+/-/=` rule above.
- External references must use clickable stable links when available.

## Optional host layers

Some projects add extra host-local team or automation layers on top of this root.
Treat those as opt-in support layers, not the default front door.
When a host-local layer generates or updates this file, it must preserve the `.nullius/HARNESS` and `research-harness` reconnect requirements above so continuation starts from project recovery before executor-specific work.
To pull newer versions of the managed scaffold document (this file) into an existing project without disturbing your own work, the project owner can run `nullius init --refresh`: it backs up any changed managed file under `.nullius/backups/` before overwriting, and never rewrites your `research_plan.md`, `research_notebook.md`, `research_contract.md`, `project_charter.md`, `project_index.md`, `reports/main_research_report_template.md`, or `.gitignore`. Preview first with `nullius init --refresh --dry-run`.
If this project predates the main-report registry, checkpoint it before migration. Render a current scaffold in a separate temporary external root with `nullius init --project-root <temporary-root>`, copy only a missing `reports/main_research_report_template.md`, then manually merge the temporary `project_index.md#Main research report` section and empty registry into this project's user-owned index. Never overwrite either user-owned file. Refresh does not perform these steps. `nullius report-validate` fails closed with `invalid_registry_markers` before the registry exists and with `no_current_report` until a complete current report is registered.
If this project already has host-local support surfaces, follow the host's local instructions before using them.
If it does not, keep using the read order above and update `research_plan.md` directly.

## Minimal checkpoints

- `project_charter.md` declares the goal hierarchy and profile.
- `research_plan.md` has a short Current Status section plus an actionable Task Board and Progress Log.
- `research_contract.md` stays in sync with `research_notebook.md`.
- `research_contract.md` also carries the artifact/provenance, falsification, and final-conclusion contract for outputs and checks.
- `project_index.md#Main research report` points to exactly one structurally valid current report, and every registered historical report still matches its recorded hash.
