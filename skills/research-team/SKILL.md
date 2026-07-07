---
name: research-team
description: "Milestone-based research-team workflow for theory+computation projects with reproducible artifacts, independent parallel workstreams (default: host-native subagents; configurable), and a strict convergence gate.\n"
---

# Research Team (Lean Entry)

This is the **trigger-loaded** entry for the `research-team` skill.
For the full manual (English), see `references/usage_guide.md`.
For the Chinese manual (human-oriented), see `references/usage_guide.zh.md`.
For the KB index exporter docs (English), see `references/kb_index.md`.

## When to use

Use `research-team` when you want a project workflow with:
- deterministic preflight gates (fail-fast),
- a human notebook (`research_notebook.md`) plus a machine contract (`research_contract.md`),
- reproducible artifacts (manifests/summaries/figures),
- and a strict 2-member convergence loop (Member A + Member B).

## Workflow authority boundary

- Generic literature workflow authority does **not** live inside `research-team`; it lives in the checked-in `literature-workflows` workflow-pack (`packages/literature-workflows/recipes/` + session protocol) and the checked-in public stateful `nullius workflow-plan` front door.
- `research-team` consumes that authority during prework / KB building and later evidence-oriented stages; it should not redefine provider-neutral literature workflow truth.
- `scripts/bin/literature_fetch.py` is a source-adapter helper for INSPIRE/arXiv/Crossref/DataCite/GitHub/DOI and local KB preparation; when it needs workflow truth, it must call the checked-in front door or lower-level consumer path rather than restating recipe semantics locally.
- When a literature pull is too shallow (KB notes left metadata-only, no cross-paper synthesis), the `deep-literature-review` skill is the right surface: it consumes the same recipes, deep-reads sources to fill this skill's KB note template (with locators), synthesizes consensus/tensions/gaps into a checkable `literature_survey_v1`, and hands the extracted claims to `claim-grounding`.

## Non-negotiable contracts (fail-fast)

- **Strict convergence**: if either member reports mismatch/fail/needs revision, you must fix and rerun until converged (or explicitly narrow/kill as `SCOPE`/`MATCHING`).
- **Notebook split**: `research_notebook.md` is the human entry; `research_contract.md` is the machine-stable gate surface.
- **Reproducibility Capsule (mandatory)**: `research_contract.md` must include a filled capsule block (between `<!-- REPRO_CAPSULE_START -->` and `<!-- REPRO_CAPSULE_END -->`).
- **Sweep semantics (mandatory)**: capsule must include `### G) Sweep semantics / parameter dependence (MANDATORY)` (even if “no sweep”: declare baseline + held-fixed constants).
- **Branch semantics (mandatory when applicable)**: capsule must include `### H) Branch Semantics / Multi-root Contract (MANDATORY)`; if multi-root quantities exist (multiple solutions/branches), you must declare branches/assignment/outputs/invariants/diagnostics.
- **Method-validity preconditions (capsule `### J`; mandatory whenever a recorded result depends on an implemented / discretized / projected / effective method precondition — *novel or textbook alike*; otherwise the section must state `not applicable: <reason>`)**: when a result's validity rests on an operator/structural identity — an operator commuting with a projector/symmetrizer, Hermiticity, self-adjointness, idempotency, unitarity, positivity, or a variational/Galerkin subspace being invariant under the operator — the capsule's `### J) Method-validity preconditions` section must (i) **name** the identity/property, (ii) give a **disconfirming residual** (non-zero iff the property fails), and (iii) report that residual **at the exact configuration that produced the headline number** (not only at the smallest/cheapest setting; if scale-invariance is itself claimed, add a residual scan across settings). For any eigenvalue/variational result from a projected or effective operator, report the **true-operator residual** `‖Oψ − λψ‖ / ‖Oψ‖` (with a documented norm; guard a near-zero denominator with a fixed scale) and the variance — not merely that ψ has the right symmetry. *A precondition verified only at a smaller/cheaper setting than the result is NOT verified* — discretization/finite-size artifacts (aliasing, grid parity, periodic wrapping) typically appear only above the minimal size. Backed by a fail-fast: `check_reproducibility_capsule.py` requires §J (filled or an explicit `not applicable: …`) when `require_method_precondition` is enabled — so "MANDATORY" is enforced, not advisory. The novelty of the *domain result* is irrelevant; what matters is that the *implemented operator* carries the precondition.
- **Cross-check resolution honesty (mandatory)**: a cross-check whose tolerance/resolution is coarser than the discrepancy it must detect is **non-diagnostic**, not a pass. For every cross-check, record explicitly *what it cannot resolve* (e.g. an order-unity / scheme-ambiguous agreement cannot certify a finer absolute value, and cannot detect a non-variational shift smaller than its bracket). Never mark such a check "passed" for a property finer than its resolution.
- **Scope-qualified confidence (mandatory)**: every confidence label on a *computed / implemented / discretized* result ("machine-precise", "converged", "verification-grade", "exact") must carry the scale/configuration at which it was established; an unqualified label next to a headline produced at a *different* configuration is a defect, not shorthand. For a purely *symbolic / continuum / analytic* claim the qualifier is the scope itself — label it "symbolic/continuum only" (no numerical scale needed), and never let that be read as covering a discretization/implementation.
- **Falsification gate, not agreement gate**: convergence requires, per precondition above, *the smallest test that could falsify it* plus evidence that test was actually run **at the production configuration**. Reviewer agreement on a derivation, or any check whose outcome was guaranteed before running it, does not substitute for executing the production-scale falsifiers.
- **Reference reproduction (mandatory whenever a recorded result claims to reproduce / match a published value)**: a claim that a result *reproduces / matches / agrees with* a published reference value is earned by **computing the claimed observable on a comparable state / regime / configuration and comparing to the published number numerically** — not by a qualitative "same scale / same sign" assertion and not by citing the source. Compare **term by term** where the claim is term-level (a net total can agree while individual contributions are suppressed or sign-flipped); an **order-of-magnitude same-direction discrepancy, or a sign reversal, is a finding, not convergence**. Independently: any established cross-validation must not **silently lapse** — a structurally *different-model* engine, or a check valid only in a degenerate / limit regime, is labeled as a different-model / limit-regime comparison, never presented as validation, and the absence of an apples-to-apples independent check is recorded as an explicit limitation. Routed to `numerical-reliability-gate` **G8** and the `review-swarm` reference-reproduction reviewer; the failure modes are catalogued in `research-integrity` (*Reference-reproduction fidelity*).
- **Reproduction independence (full_access review; enforced whenever the `independent_reproduction_gate` feature is enabled — on in the shipped config template)**: an "independent reproduction" must not import / include / `using` the kernel under test, and the two members' reproduction paths must not share the same project-local module — agreement between copies of one kernel is a shared-error artifact, not a confirmation. Declare the modules under test in `independent_reproduction.kernel_modules` (a declared kernel is never allowlistable); the `check_independent_reproduction.py` gate fails closed with verdict `not_independent` (label `SHARED_KERNEL_INHERITANCE`) and emits a machine-readable `convergence_gate_result_v1` verdict — the caller does not self-judge independence. When two reproductions disagree, locate the first diverging intermediate quantity by tracing both paths; never settle a disagreement by majority vote, and never by re-running until agreement.
- **Pointer lint (mandatory)**: code pointers in the notebook must be resolvable under the configured `pointer_lint.strategy`.
- **No silent retries**: when a gate fails, stop, apply the minimal fix, rerun with a new tag (`M2-r2`, `M2-r3`, ...).
- **Run artifact identity**: the canonical project artifact root is
  `artifacts/runs/<run_id>/`. Use a safe, sortable, readable `run_id`, preferably
  `<YYYYMMDDTHHMMSSZ>-<milestone>-<short-topic>-rN`. `team/runs/<tag>/` is the
  research-team reviewer packet/log surface; it is not the project artifact
  SSOT unless the project explicitly mirrors or summarizes it under
  `artifacts/runs/<run_id>/research_team/`.
- **Tag relation**: with `--auto-tag`, pass a meaningful base tag such as
  `20260502T023000Z-m3-branch-scan`; the resolved `<base>-rN` is the
  research-team cycle tag and may be used as the control-plane `run_id` for
  that reviewed cycle. Do not use bare UUIDs or `run_<uuid>` as human-facing
  research tags.

## Quick Start (3 commands)

> Commands below stay install-location-portable by resolving the skill via `SKILL_DIR`, with a host-neutral fallback that probes known agent skill homes (`~/.claude`, `~/.codex`, `~/.config/opencode`). These paths are portable skill-discovery locations across different agent hosts, not a menu of host options — the same skill installs and runs under any of them.

1) Environment check (optional flags shown). The CLI runner backends (Codex / Claude / Gemini) are interchangeable options — pick whichever you have; `--require-codex` below is only one example, not a default or preferred backend:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
# e.g. require an explicit Codex CLI runner:
bash "${SKILL_DIR}/scripts/bin/check_environment.sh" --require-codex
# or (if you explicitly want A=Claude, B=Gemini):
# bash "${SKILL_DIR}/scripts/bin/check_environment.sh" --require-claude --require-gemini
```

2) Scaffold the workflow into a project repo:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
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

SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
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
Durable research outputs and claims should point to the canonical project root
`artifacts/runs/<run_id>/`; when the team cycle is evidence for that run, record
or summarize it under `artifacts/runs/<run_id>/research_team/` and keep the
`team/runs/<tag>/` paths as reviewer provenance.

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
  - Use `python3 "${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}/scripts/bin/literature_fetch.py" workflow-plan ...` when you need the lower-level literature workflow plan consumer during skill-side prework.
  - Literature/reference/knowledge-evidence work must maintain both `knowledge_base/methodology_traces/literature_queries.md` and `knowledge_base/methodology_traces/literature_saturation.json`; a single result page or fixed paper count is not a completion criterion.
  - Subcommands (arXiv): `arxiv-search`, `arxiv-get --write-note`, `arxiv-source` (syntax: `python3 "${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}/scripts/bin/literature_fetch.py" <subcommand> ...`; downloads LaTeX source to `references/arxiv_src/<arxiv_id>/` by default).
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
- **Secondary utilities (advanced; see `references/usage_guide.md`)**:
  - Autofill: `scripts/bin/auto_fill_prework.py`, `scripts/bin/auto_fill_research_plan.py`
  - Tag helpers: `scripts/bin/next_team_tag.py`, `scripts/bin/next_draft_tag.py`
  - Claim gates: `scripts/bin/auto_enable_claim_gates.py`
  - Post-run helpers: `scripts/bin/summarize_team_reports.py`, `scripts/bin/validate_evidence.py`
  - Diagnostics/hygiene: `scripts/bin/check_md_double_backslash.sh`, `scripts/bin/check_low_order_quadrature_usage.py`, `scripts/bin/discover_latex_zero_arg_macros.py`, `scripts/bin/format_kb_reference_links.py`
  - Adjudication: `scripts/bin/build_adjudication_response.py`
  - Member review (debug): `scripts/bin/run_member_review.py`
  - Internal helpers: `scripts/bin/team_cycle_*.py` (used by `run_team_cycle.sh`; usually not called directly)

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

## Deep dive (read only when needed)

- Full manual (English): `references/usage_guide.md`
- Chinese manual (human-oriented): `references/usage_guide.zh.md`
- KB index exporter (English): `references/kb_index.md`
- Troubleshooting / rerun recipes: `RUNBOOK.md`
- Gate contract notes: `FULL_VALIDATION_CONTRACT.md`
- Artifact contract: `references/artifact_contract.md`
