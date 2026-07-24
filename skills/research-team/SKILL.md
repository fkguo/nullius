---
name: research-team
description: "Use when a research milestone (theory or computation) needs executed, reproducible work whose results are independently reviewed before being trusted. Milestone-based research-team workflow for theory+computation projects with reproducible artifacts, independent parallel workstreams (default: host-native subagents; configurable), and a strict convergence gate.\n"
---

# Research Team (Lean Entry)

This is the **trigger-loaded** entry for the `research-team` skill.
For the full manual (English), see `references/usage_guide.md`.
For the Chinese manual (human-oriented), see `references/usage_guide.zh.md`.
For the KB index exporter docs (English), see `references/kb_index.md`.

## When to use

Use `research-team` when you want a project workflow with:
- deterministic preflight gates (fail-fast),
- a human research memo (`research_notebook.md`) plus a machine contract (`research_contract.md`),
- reproducible artifacts (manifests/summaries/figures),
- and a strict 2-member convergence loop (Member A + Member B).

## Workflow authority boundary

- Generic literature workflow authority does **not** live inside `research-team`; it lives in the checked-in `literature-workflows` workflow-pack (`packages/literature-workflows/recipes/` + session protocol) and the checked-in public stateful `nullius workflow-plan` front door.
- `research-team` consumes that authority during prework / KB building and later evidence-oriented stages; it should not redefine provider-neutral literature workflow truth.
- `scripts/bin/literature_fetch.py` is a source-adapter helper for INSPIRE/arXiv/Crossref/DataCite/GitHub/DOI and local KB preparation; when it needs workflow truth, it must call the checked-in front door or lower-level consumer path rather than restating recipe semantics locally.
- When a literature pull is too shallow (KB notes left metadata-only, no cross-paper synthesis), the `deep-literature-review` skill is the right surface: it consumes the same recipes, deep-reads sources to fill this skill's KB note template (with locators), synthesizes consensus/tensions/gaps into a checkable `literature_survey_v1`, and hands the extracted claims to `claim-grounding`.

## Non-negotiable contracts (fail-fast)

- **Strict convergence**: if either member reports mismatch/fail/needs revision, you must fix and rerun until converged (or explicitly narrow/kill as `SCOPE`/`MATCHING`).
- **Symbolic claims route through `derivation-verify`**: when a converging milestone rests on a symbolic / derivation claim (a closed form, an identity, a sign/branch choice), the independent confirmation for that claim is at least two independent blind re-derivations via [`derivation-verify`](../derivation-verify/SKILL.md) — reviewer agreement that a written derivation "looks right" is not independent confirmation. Computed numbers route through `numerical-reliability-gate`, the sibling gate.
- **Notebook split**: `research_notebook.md` is the human entry; `research_contract.md` is the machine-stable gate surface.
- **Memo discipline (mandatory)**: `research_notebook.md` is a self-contained research memo organized like a paper — connected prose with complete derivations, computations, and analysis — not a change log. Its quality bar: a colleague in the field could read it alone (no runs, no plan) and come away with the project's full current understanding, able to re-derive every load-bearing result. It updates by **rewriting the affected sections into a self-consistent whole**, never by appending stage fragments ("this milestone changed X"); dated progress belongs to `research_plan.md` and `artifacts/runs/<run_id>/`, revision history to git. A milestone does not converge while the memo still describes the pre-milestone understanding: rewriting the affected memo sections is part of the milestone's deliverable, checked in the convergence review like any other artifact.
- **Reproducibility Capsule (mandatory)**: `research_contract.md` must include a filled capsule block (between `<!-- REPRO_CAPSULE_START -->` and `<!-- REPRO_CAPSULE_END -->`).
- **Sweep semantics (mandatory)**: capsule must include `### G) Sweep semantics / parameter dependence (MANDATORY)` (even if “no sweep”: declare baseline + held-fixed constants).
- **Branch semantics (mandatory when applicable)**: capsule must include `### H) Branch Semantics / Multi-root Contract (MANDATORY)`; if multi-root quantities exist (multiple solutions/branches), you must declare branches/assignment/outputs/invariants/diagnostics.
- **Method-validity preconditions (capsule `### J`; mandatory whenever a recorded result depends on an implemented / discretized / projected / effective method precondition — *novel or textbook alike*; otherwise the section must state `not applicable: <reason>`)**: when a result's validity rests on an operator/structural identity — an operator commuting with a projector/symmetrizer, Hermiticity, self-adjointness, idempotency, unitarity, positivity, or a variational/Galerkin subspace being invariant under the operator — the capsule's `### J) Method-validity preconditions` section must (i) **name** the identity/property, (ii) give a **disconfirming residual** (non-zero iff the property fails), and (iii) report that residual **at the exact configuration that produced the headline number** (not only at the smallest/cheapest setting; if scale-invariance is itself claimed, add a residual scan across settings). For any eigenvalue/variational result from a projected or effective operator, report the **true-operator residual** `‖Oψ − λψ‖ / ‖Oψ‖` (with a documented norm; guard a near-zero denominator with a fixed scale) and the variance — not merely that ψ has the right symmetry. *A precondition verified only at a smaller/cheaper setting than the result is NOT verified* — discretization/finite-size artifacts (aliasing, grid parity, periodic wrapping) typically appear only above the minimal size. Backed by a fail-fast: `check_reproducibility_capsule.py` requires §J (filled or an explicit `not applicable: …`) when `require_method_precondition` is enabled — so "MANDATORY" is enforced, not advisory. The novelty of the *domain result* is irrelevant; what matters is that the *implemented operator* carries the precondition.
- **Cross-check resolution honesty (mandatory)**: a cross-check whose tolerance/resolution is coarser than the discrepancy it must detect is **non-diagnostic**, not a pass. For every cross-check, record explicitly *what it cannot resolve* (e.g. an order-unity / scheme-ambiguous agreement cannot certify a finer absolute value, and cannot detect a non-variational shift smaller than its bracket). Never mark such a check "passed" for a property finer than its resolution. The same honesty applies **before** a proposed discriminator/test is executed: the proposer first computes its **discriminating power** — the expected signal against the degenerate background / confounders (a broad feature probed through a window narrower than the feature, or a smooth monotone factor compared against any smooth background, is background-degenerate). A test whose expected signal is not cleanly separable from its confounders is non-diagnostic before it runs: neither its positive nor its negative outcome may be cited as evidence, and executing it wastes budget. Reviewers check that every cited test carried this power estimate.
- **Scope-qualified confidence (mandatory)**: every confidence label on a *computed / implemented / discretized* result ("machine-precise", "converged", "verification-grade", "exact") must carry the scale/configuration at which it was established; an unqualified label next to a headline produced at a *different* configuration is a defect, not shorthand. For a purely *symbolic / continuum / analytic* claim the qualifier is the scope itself — label it "symbolic/continuum only" (no numerical scale needed), and never let that be read as covering a discretization/implementation.
- **Falsification gate, not agreement gate**: convergence requires, per precondition above, *the smallest test that could falsify it* plus evidence that test was actually run **at the production configuration**. Reviewer agreement on a derivation, or any check whose outcome was guaranteed before running it, does not substitute for executing the production-scale falsifiers.
- **Reference reproduction (mandatory whenever a recorded result claims to reproduce / match a published value)**: a claim that a result *reproduces / matches / agrees with* a published reference value is earned by **computing the claimed observable on a comparable state / regime / configuration and comparing to the published number numerically** — not by a qualitative "same scale / same sign" assertion and not by citing the source. Compare **term by term** where the claim is term-level (a net total can agree while individual contributions are suppressed or sign-flipped); an **order-of-magnitude same-direction discrepancy, or a sign reversal, is a finding, not convergence**. Independently: any established cross-validation must not **silently lapse** — a structurally *different-model* engine, or a check valid only in a degenerate / limit regime, is labeled as a different-model / limit-regime comparison, never presented as validation, and the absence of an apples-to-apples independent check is recorded as an explicit limitation. Routed to `numerical-reliability-gate` **G8** and the `review-swarm` reference-reproduction reviewer; the failure modes are catalogued in `research-integrity` (*Reference-reproduction fidelity*).
- **Reproduction independence (full_access review; enforced whenever the `independent_reproduction_gate` feature is enabled — on in the shipped config template)**: an "independent reproduction" must not import / include / `using` the kernel under test, and the two members' reproduction paths must not share the same project-local module — agreement between copies of one kernel is a shared-error artifact, not a confirmation. Declare the modules under test in `independent_reproduction.kernel_modules` (a declared kernel is never allowlistable); the `check_independent_reproduction.py` gate fails closed with verdict `not_independent` (label `SHARED_KERNEL_INHERITANCE`) and emits a machine-readable `convergence_gate_result_v1` verdict — the caller does not self-judge independence. When two reproductions disagree, locate the first diverging intermediate quantity by tracing both paths; never settle a disagreement by majority vote, and never by re-running until agreement.
- **Translation is not independence (mandatory)**: rewriting the same algorithm in another language — same mathematical representation, same discretization, same algorithmic route, line-for-line structure — reproduces the original kernel together with its conceptual errors, even though it imports nothing the import scanner could catch. Such a port is an *implementation check* (it can catch coding slips), never an *independent verification*. Independence must come from a genuinely different route — a different mathematical representation or formulation, a different algorithm or discretization, a different basis — or from an independent anchor outside both implementations, such as a published reference value. Every reproduction record therefore **declares its methodological difference** — one or two sentences naming what differs (representation / algorithm / discretization / basis) from the path under test — and the convergence reviewer checks that declaration against both implementations; a reproduction whose honest declaration is "same method, different language" is recorded as an implementation check and does not count toward the independent-verification requirement.
- **Re-reading is not recomputation (mandatory for load-bearing structural claims)**: a review — cross-family or not — that only re-reads evidence supplied by the claimant is an argument audit, not a verification; its "confirm" can sit entirely inside the claimant's blind spot, because the supplied evidence may probe the wrong axis altogether. For any load-bearing structural claim, at least one reviewer independently recomputes the quantity through a different route (a different discretization, implementation, or representation), receiving only the problem statement and raw inputs — never the claimant's answer, evidence selection, or initial judgment — and the review record states which axis the recomputation actually probed (what it could have falsified). Routed to the `review-swarm` independent-recomputation reviewer.
- **Prior-art binding (mandatory when a delegation brief names prior art)**: when the dispatch brief for the work under review named prior art — an upstream toolkit routine, a sibling project's implementation of the same end-to-end problem, a published method — the reviewer verifies that the implementation's call sites of each named asset, or the approved pre-implementation deviation record, exist **before** assessing results (see *Reuse-or-deviate gate* below); an implementation carrying neither does not converge.
- **Pointer lint (mandatory)**: code pointers in the notebook must be resolvable under the configured `pointer_lint.strategy`.
- **No silent retries**: when a gate fails, stop, apply the minimal fix, rerun with a new tag (`M2-r2`, `M2-r3`, ...).
- **Run artifact identity**: the canonical project artifact root for
  lifecycle and compute runs is `artifacts/runs/<run_id>/`. Use a safe,
  sortable, readable `run_id`, preferably
  `<YYYYMMDDTHHMMSSZ>-<milestone>-<short-topic>-rN`. `team/runs/<tag>/` is the
  research-team reviewer packet/log surface and a first-class evidence root in
  its own right: contract claims may cite `team/runs/<tag>/...` paths directly.
  Mirror or summarize under `artifacts/runs/<run_id>/research_team/` when a
  milestone's headline evidence should live with the run record, not as a
  precondition for citing it.
- **Tag relation**: with `--auto-tag`, pass a meaningful base tag such as
  `20260502T023000Z-m3-branch-scan`; the resolved `<base>-rN` is the
  research-team cycle tag and may be used as the control-plane `run_id` for
  that reviewed cycle. Do not use bare UUIDs or `run_<uuid>` as human-facing
  research tags.

## Quick Start (3 commands)

> Commands below stay install-location-portable by resolving the skill via `SKILL_DIR`, with a host-neutral fallback that probes known agent skill homes (`~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.kimi-code`). These paths are portable skill-discovery locations across different agent hosts, not a menu of host options — the same skill installs and runs under any of them.

1) Environment check (optional flags shown). The CLI runner backends (Codex / Claude / Gemini) are interchangeable options — pick whichever you have; `--require-codex` below is only one example, not a default or preferred backend:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
# e.g. require an explicit Codex CLI runner:
bash "${SKILL_DIR}/scripts/bin/check_environment.sh" --require-codex
# or (if you explicitly want A=Claude, B=Gemini):
# bash "${SKILL_DIR}/scripts/bin/check_environment.sh" --require-claude --require-gemini
```

2) Scaffold the workflow into a project repo:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/scaffold_research_workflow.sh" \
  --root /path/to/project \
  --project "My Project" \
  --profile mixed \
  --full
```

Scaffold creates `prompts/_system_member_a.txt` and `prompts/_system_member_b.txt` (note the leading underscore; they are copied from the skill assets `system_member_a.txt` / `system_member_b.txt`).
Use `--full` when you want those research-team host-local assets immediately; the default scaffold stays minimal.
The public scaffold and contract-refresh entrypoints now run in `real_project` mode: use an external project root, and keep real-project run/intermediate outputs outside the nullius development repo. Internal maintainer fixtures remain a lower-level contract mode only, not part of the public workflow.

3) Run a team cycle from the project root:

```bash
cd /path/to/project

SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag 20260502T023000Z-m0-topic --auto-tag \
  --notes research_contract.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt
```

Tip: add `--preflight-only` to run deterministic gates without calling external LLMs.
By default, Member A and Member B should be assigned through the current host agent's official subagent mechanism with config-derived reasoning depth. `run_team_cycle.sh` keeps CLI compatibility runners for shell-only environments; use `--member-a-runner-kind` / `--member-b-runner-kind` or `research_team_config.json` only when you explicitly want a provider-specific CLI runner.
Keep `--out-dir` on a real-project path as well; do not point real-project team outputs back into the development repo.
The command above writes reviewer-cycle packets and logs under `team/runs/<tag>/`.
`team/runs/<tag>/` is a first-class evidence root: durable claims may cite its
paths directly, alongside the canonical lifecycle root `artifacts/runs/<run_id>/`.
When a milestone's headline evidence should live with the run record, record or
summarize it under `artifacts/runs/<run_id>/research_team/`; otherwise keep the
`team/runs/<tag>/` paths as the cited reviewer provenance.

**Workspace disk policy**: `team/runs/<tag>/workspaces/` contains per-member
project snapshots that the reviewer subprocess runs against. They can grow
large (full project tree × 2 members × N runs). They are **ephemeral scratch
space**, not durable artifacts — every piece of forensic data needed to audit
a run lives at the run_dir top level (`cycle_state.json`, `<tag>_member_*.md`,
`member_*_evidence.json`, `member_*_audit.jsonl`, `logs/member_*/`).

- `run_team_cycle.sh` deletes `workspaces/` automatically when the cycle
  completes successfully. Set `RESEARCH_TEAM_KEEP_WORKSPACES=1` to disable.
- On failure the workspaces are preserved by default for debugging. Set
  `RESEARCH_TEAM_KEEP_WORKSPACES_ON_FAILURE=0` to also clean up on failure.
- At the start of every new cycle, `run_team_cycle.sh` also sweeps orphaned
  workspaces from any earlier cycle whose `on_exit` trap could not fire
  (SIGKILL / OOM kill / power loss). The startup sweep only deletes workspaces
  of clean successful exits (status `completed|converged|early_stop|preflight_only`)
  and only when the workspace mtime is at least 30 minutes old. Set
  `RESEARCH_TEAM_KEEP_WORKSPACES_AT_STARTUP=1` to disable the sweep.
- To reclaim disk on existing projects whose old runs still carry workspaces,
  use the prune utility. Defaults are `--keep-last 0`, `--keep-failed` unset,
  and dry-run; pass `--apply` to actually delete and any combination of the
  flags below to widen what survives:
  ```bash
  # Dry-run preview of all eligible workspaces (deletes nothing).
  python3 "${SKILL_DIR}/scripts/bin/prune_team_workspaces.py" --root /path/to/project
  # Apply, preserving the 3 most-recent runs and any failed runs:
  python3 "${SKILL_DIR}/scripts/bin/prune_team_workspaces.py" --root /path/to/project \
    --keep-last 3 --keep-failed --apply
  ```
  The tool only touches `team/runs/<tag>/workspaces/` subdirectories; all
  forensic data at the run_dir top level is preserved. Pass `--json` to emit
  a machine-readable plan plus, after `--apply`, a `result` envelope.
- For projects that run cycles in an unattended loop, either keep the
  `RESEARCH_TEAM_KEEP_WORKSPACES_ON_FAILURE=1` default and schedule a periodic
  `prune_team_workspaces.py --root <project> --keep-last N --keep-failed --apply`
  sweep (cron / launchd / scheduled task), or set
  `RESEARCH_TEAM_KEEP_WORKSPACES_ON_FAILURE=0` to clean up failures inline
  once the loop is known healthy.

## Capabilities index (discoverability)

- **Team cycle (core)**: `scripts/bin/run_team_cycle.sh` (preflight → A/B → convergence).
- **Draft (TeX) review cycle**: `scripts/bin/run_draft_cycle.sh` (TeX-source-first; optional 3-party convergence).
- **Autopilot**: `scripts/bin/run_autopilot.sh` (plan autofill + loop coordinator; uses `scripts/bin/autopilot_loop.py`).
- **Packet build only**: `scripts/bin/build_team_packet.py`, `scripts/bin/build_draft_packet.py`.
- **Literature fetch (INSPIRE/arXiv/Crossref/DataCite/DOI/GitHub)**: `scripts/bin/literature_fetch.py` (project-leader source-adapter helper for prework/KB building; reviewers must not use network).
  - Generic literature workflow sequencing authority lives in `literature-workflows` recipes / session protocol plus the checked-in public front door, not in this script.
  - Use `python3 "${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}/scripts/bin/literature_fetch.py" workflow-plan ...` when you need the lower-level literature workflow plan consumer during skill-side prework.
  - Literature/reference/knowledge-evidence work must maintain both `knowledge_base/methodology_traces/literature_queries.md` and `knowledge_base/methodology_traces/literature_saturation.json`; a single result page or fixed paper count is not a completion criterion.
  - `literature_saturation.json` is also the candidate-disposition, core-bibliography-reconciliation, and method-family-audit authority. Each queried provider records finite `execution_bounds` and a per-request query/page-or-cursor/continuation log whose counts reconcile to `returned_count`; every declared query must appear, and `saturated` requires an exhausted terminal request plus full coverage of any known total. A resolved candidate carries canonical DOI/URL/provider identity metadata bound to citation-triangulation-compatible provider blocks through a project-root-bounded exact-SHA reference; unknown identities remain explicit debt. The separate `url` display field is not a join key unless it is also an archived canonical id or explicit alias. Every selected core source similarly binds its JSON raw-reference manifest, and each raw entry joins back to the same canonical candidate identity. Method coverage records one `method_bearing`, `not_method_bearing`, or `coverage_debt` screening disposition for every reconciled bibliography candidate; both positive and negative dispositions require source-text evidence, while method-bearing records additionally require descriptions/features and taxonomy classification. The gate rejects `saturated` until all surfaces close.
  - Subcommands (arXiv): `arxiv-search`, `arxiv-get --write-note`, `arxiv-source` (syntax: `python3 "${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}/scripts/bin/literature_fetch.py" <subcommand> ...`; downloads LaTeX source to `references/arxiv_src/<arxiv_id>/` by default).
- **Export a portable bundle**: `scripts/bin/export_paper_bundle.sh` (wrapper) / `scripts/bin/export_paper_bundle.py`.
- **KB index export (deterministic/L1)**: `scripts/bin/kb_export.py` + `scripts/bin/validate_kb_index.py` + `scripts/schemas/kb_index.schema.json`.
- **Demo generation**: `scripts/bin/generate_demo_milestone.sh`.
- **Project kickstart prompt**: `scripts/bin/generate_project_start_prompt.py`.
- **Deterministic hygiene tools** (as needed): `scripts/bin/fix_markdown_*`, `scripts/bin/fix_bibtex_revtex4_2.py`, `scripts/bin/upgrade_reference_anchors.py`; use the standalone `markdown-hygiene` skill for manual Markdown math/TOC cleanup outside a team-cycle preflight.
- **Claim DAG & evidence** (optional): render via `nullius graph --kind claims` (the domain-neutral `@nullius/shared/graph-viz` front door; auto-rendered best-effort to `knowledge_graph/` at convergence when an `nullius` CLI is reachable) + gates under `scripts/gates/`.
- **Roadmap dependency-map (plan-summary / milestone-handoff)**: `assets/roadmap_dependency_map_template.md` + `nullius graph --kind roadmap` (a *planning* view of milestones/lanes; complements — does not replace — the Claim DAG, see below).
- **Exploration stage debt helper**: `scripts/bin/exploration_debt_dashboard.py`.
- **Scaffold pruning (move/archive optional files)**: `scripts/bin/prune_optional_scaffold.py`.
- **Environment snapshot**: `scripts/bin/capture_env_snapshot.sh`.
- **Lifecycle updates**: `scripts/bin/update_project_map.py`, `scripts/bin/update_research_plan_progress.py`, `scripts/bin/update_trajectory_index.py`.
- **Main research report promotion**: the canonical domain-neutral template
  and registry live in the `project-contracts` scaffold under
  `reports/main_research_report_template.md` and
  `project_index.md#Main research report`; validate promotion with
  `nullius report-validate`. This skill consumes that authority and does not
  carry a second template.
- **Secondary utilities (advanced; see `references/usage_guide.md`)**:
  - Autofill: `scripts/bin/auto_fill_prework.py`, `scripts/bin/auto_fill_research_plan.py`
  - Tag helpers: `scripts/bin/next_team_tag.py`, `scripts/bin/next_draft_tag.py`
  - Claim gates: `scripts/bin/auto_enable_claim_gates.py`
  - Post-run helpers: `scripts/bin/summarize_team_reports.py`, `scripts/bin/validate_evidence.py`
  - Diagnostics/hygiene: `scripts/bin/check_md_double_backslash.sh`, `scripts/bin/check_low_order_quadrature_usage.py`, `scripts/bin/discover_latex_zero_arg_macros.py`, `scripts/bin/format_kb_reference_links.py`
  - Adjudication: `scripts/bin/build_adjudication_response.py`
  - Member review (debug): `scripts/bin/run_member_review.py`
  - Internal helpers: `scripts/bin/team_cycle_*.py` (used by `run_team_cycle.sh`; usually not called directly)

## Parallel worktree lanes: judgment-point stops and merge authority

When independent workstreams run as separate git worktrees/branches driven by
separate agents (any host), three conventions keep the fan-out auditable and
mergeable; a real multi-lane run had to invent all three ad hoc, so they are
recorded here as the standing contract:

- **Stop only at judgment points.** A lane runs autonomously until it reaches a
  decision only the coordinator (or the human) can make, then stops and reports
  a machine-readable status — e.g. `merge_decision_needed`,
  `blocker_decision_needed`, `done` — with what it is waiting on and where its
  artifacts live. Lanes do not pause for routine progress confirmation, and
  they do not push past a blocker by guessing.
- **The coordinator is the only merge authority.** Worker lanes never merge to
  the main branch and never merge each other; they leave their branch at the
  judgment point. The coordinator reviews, decides, merges, and resolves
  cross-lane conflicts with the whole portfolio in view. This also keeps the
  independent-review boundary intact: a reviewer lane stays read-only.
- **Track liveness through the harness, not bare background jobs.** Long-running
  computations inside a lane use the `research-harness` checkpoint + heartbeat +
  deadline + resume machinery (see that skill), so a killed or hung lane is
  detectable and resumable. A small per-lane status file (lane id, status,
  waiting-on, artifact paths, last-heartbeat) in a gitignored scratch area is
  enough for the coordinator to poll; keep it out of the durable artifact tree.

## Delegation budget contract: every delegated workstream gets explicit budgets

A delegated executing agent's default drift is to refine precision
indefinitely and to expand scope on its own initiative; a delegation without
explicit budgets is drift by construction. So every delegated computation or
verification workstream (a lane, a compute job, a verification pass handed to
another agent) gets a **budget contract** written by the coordinator **before
dispatch** — one JSON file per delegation under `team/delegations/`, from
`assets/delegation_budget_contract_template.json`
(`delegation_budget_contract_v1`). Required field groups, all machine-checked:

- **`tolerance_ceiling`** — the numeric tolerance the result must reach and
  must **not** be refined beyond, plus a one-line `anchor_note` stating which
  requirement of the task derives the ceiling (what the result is *for* —
  e.g. the precision at which the downstream decision changes — never what
  the method can achieve). Reaching the ceiling means **stop**.
- **`time_box`** — a hard wall-clock budget for the workstream.
- **`max_attempts`** — a cap on "one last attempt" retries; exhausting it
  means wrap up, not retry.
- **`scope_negative_list`** — expansions the executor must **not** undertake
  on its own initiative (e.g. infrastructure rewrites, building a full test
  suite beyond the delegated checks, third-party benchmarking).
- **`peak_memory_estimate`** — peak resident-set size measured on a
  **single-unit dry run before the full launch**, plus the explicit heap cap
  the full run is launched with (estimating wall-clock alone is not a
  resource estimate).

The check is fail-closed and machine-judged
(`scripts/gates/check_delegation_budget.py`, machine verdict
`delegation_budget_gate_result_v1`): a contract
missing any required field, still carrying an unfilled template placeholder,
or using an unknown contract version does **not** pass. `run_team_cycle.sh`
validates every contract present at preflight in every project stage (no
exploration downgrade); set `delegation_budget.required=true` in the team
config when a milestone dispatches delegated workstreams, so a run with no
contract at all also fails (`NO_CONTRACTS_FOUND`).

When a budget is exhausted, the workstream **wraps up from the atomic
results already flushed to disk — it never voids the batch** — and abandoned
approaches go into the failed-approaches ledger (`failed_approaches_v1`);
both semantics are specified in the `research-harness` skill's long-running
compute jobs contract, which is where a delegated long job's checkpointing,
deadline, and resume behavior live.

## Reuse-or-deviate gate: a brief that names prior art binds the implementation

Reuse instructions that live only in prose do not survive delegation: an
executor satisfies the acceptance gates, not the prose around them, and
rewriting from scratch is cheaper for an agent than understanding foreign
code — so the default failure mode is a silent pivot to bespoke code, with
an inapplicability justification written only afterwards by the same
invested party. When a delegation brief names prior art (an upstream
toolkit routine, a sibling project's implementation of the same
end-to-end problem, a published method), the named assets bind the
implementation. Before any implementation commit, the executor commits,
for each named asset, exactly one of:

- **call-site evidence** — file and line showing the named asset consumed
  by the implementation; or
- **a deviation record** — measured, code-level reasons the named asset's
  mathematical model does not apply here, plus the proposed replacement —
  then a **stop for coordinator approval before the replacement is
  written**.

An implementation commit carrying neither is rejected at review (the
*Prior-art binding* contract above). A deviation record first written
after the replacement already exists is post-hoc self-justification by an
invested party: it does not satisfy this gate, and none of the
replacement's results are folded in until an independent clean-room
review has examined the deviation claim.

**Architecture-first reuse scan.** The first deliverable of any reuse
scan is the architecture-level answer: for each named prior source, how
it solved the same end-to-end problem — named files, functions, methods —
and an adopt-or-reject verdict with measured reasons per source. A grep
for a routine name is not a reuse scan. `research-integrity` M8 carries
the matching pre-computation trigger.

## Plan-summary / milestone-handoff: roadmap dependency-map

At a **plan-summary or milestone-handoff moment** (communicating a multi-phase
plan to a stakeholder, closing out a milestone, or handing off), produce a
**roadmap dependency-map** from `assets/roadmap_dependency_map_template.md`. It is
a one-page planning view with five parts: (1) a roadmap summary table (per
milestone/lane: status · effort estimate with uncertainty · resource/compute
cost · upstream deps · unlocks); (2) a milestone/lane dependency graph where node
fill encodes status and edge type encodes dependency kind (solid = hard "unlocks";
dashed = soft "feeds into"), with the critical path marked; (3) a binding-constraint
callout (the single hardest resource/feasibility limit, with its scaling); (4) a
critical-path recommendation (minimal ordered chain + what is parallelizable +
"later upgrade ≠ prerequisite"); (5) honest estimate discipline (numbers are
estimates with stated uncertainty, distinct from measurements).

Render the graph through the `nullius graph --kind roadmap --spec <roadmap.json>`
front door (consumes the `@nullius/shared/graph-viz` engine: always writes DOT;
optional PNG/SVG only if Graphviz is installed). This is a **planning** view and is
intentionally **distinct from the Claim DAG** (`knowledge_graph/`, which encodes
*what we believe* — claims + evidence): it reuses the Claim DAG's rendering
conventions but shares no input files and must not be conflated with it.

## Main research report promotion

The roadmap map, member reports, convergence summaries, checkpoint notes, and
closeout briefs are coordination or review artifacts. None is the main
research report. Machine manifests and receipts bind execution but likewise do
not replace the human-readable scientific account.

When a converged milestone is promoted into the project's main report, copy
the canonical project template to a new stable path under `reports/` and fill
the complete narrative contract. Register its SHA-256 and any supersession in
`project_index.md#Main research report`; update the old and new registry rows
in both directions and switch the single current pointer. Registered report
bytes are immutable. Run `nullius report-validate` before calling the
promotion complete. Structural validation checks the contract shape,
human-readable links, replay classification, hashes, and supersession chain;
it does not decide whether the scientific narrative is sufficient.

## Deep dive (read only when needed)

- Full manual (English): `references/usage_guide.md`
- Chinese manual (human-oriented): `references/usage_guide.zh.md`
- KB index exporter (English): `references/kb_index.md`
- Troubleshooting / rerun recipes: `RUNBOOK.md`
- Gate contract notes: `FULL_VALIDATION_CONTRACT.md`
- Artifact contract: `references/artifact_contract.md`
