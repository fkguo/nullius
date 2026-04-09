---
name: research-team
description: >
  Milestone-based research-team workflow for theory+computation projects with reproducible artifacts,
  independent parallel workstreams (default: Claude + Gemini; configurable), and a strict convergence gate.
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

- Generic literature workflow authority does **not** live inside `research-team`; it lives in the checked-in `literature-workflows` workflow-pack (`packages/literature-workflows/recipes/` + session protocol) and the checked-in `packages/literature-workflows` launcher.
- `research-team` consumes that authority during prework / KB building and later evidence-oriented stages; it should not redefine provider-neutral literature workflow truth.
- `scripts/bin/literature_fetch.py` is a source-adapter helper for INSPIRE/arXiv/Crossref/DataCite/GitHub/DOI and local KB preparation; when it needs workflow truth, it must call the checked-in launcher rather than restating recipe semantics locally.

## Non-negotiable contracts (fail-fast)

- **Strict convergence**: if either member reports mismatch/fail/needs revision, you must fix and rerun until converged (or explicitly narrow/kill as `SCOPE`/`MATCHING`).
- **Notebook split**: `research_notebook.md` is the human entry; `research_contract.md` is the machine-stable gate surface.
- **Reproducibility Capsule (mandatory)**: `research_contract.md` must include a filled capsule block (between `<!-- REPRO_CAPSULE_START -->` and `<!-- REPRO_CAPSULE_END -->`).
- **Sweep semantics (mandatory)**: capsule must include `### G) Sweep semantics / parameter dependence (MANDATORY)` (even if “no sweep”: declare baseline + held-fixed constants).
- **Branch semantics (mandatory when applicable)**: capsule must include `### H) Branch Semantics / Multi-root Contract (MANDATORY)`; if multi-root quantities exist (multiple solutions/branches), you must declare branches/assignment/outputs/invariants/diagnostics.
- **Pointer lint (mandatory)**: code pointers in the notebook must be resolvable under the configured `pointer_lint.strategy`.
- **No silent retries**: when a gate fails, stop, apply the minimal fix, rerun with a new tag (`M2-r2`, `M2-r3`, ...).

## Quick Start (3 commands)

> Commands below stay install-location-portable by resolving the skill via `SKILL_DIR` (with `${CODEX_HOME}` fallback when available).

1) Environment check (optional flags shown):

```bash
SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"
bash "${SKILL_DIR}/scripts/bin/check_environment.sh" --require-claude
# or (if you want A=Claude, B=Gemini):
# bash "${SKILL_DIR}/scripts/bin/check_environment.sh" --require-claude --require-gemini
```

2) Scaffold the workflow into a project repo:

```bash
SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"
bash "${SKILL_DIR}/scripts/bin/scaffold_research_workflow.sh" \
  --root /path/to/project \
  --project "My Project" \
  --profile mixed \
  --full
```

Scaffold creates `prompts/_system_member_a.txt` and `prompts/_system_member_b.txt` (note the leading underscore; they are copied from the skill assets `system_member_a.txt` / `system_member_b.txt`).
Use `--full` when you want those research-team host-local assets immediately; the default scaffold stays minimal.
The public scaffold and contract-refresh entrypoints now run in `real_project` mode: use an external project root, and keep real-project run/intermediate outputs outside the autoresearch-lab development repo. Internal maintainer fixtures remain a lower-level contract mode only, not part of the public workflow.

3) Run a team cycle from the project root:

```bash
cd /path/to/project

SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"
bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag M0 --auto-tag \
  --notes research_contract.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt
```

Tip: add `--preflight-only` to run deterministic gates without calling external LLMs.
Keep `--out-dir` on a real-project path as well; do not point real-project team outputs back into the development repo.

## Capabilities index (discoverability)

- **Team cycle (core)**: `scripts/bin/run_team_cycle.sh` (preflight → A/B → convergence).
- **Draft (TeX) review cycle**: `scripts/bin/run_draft_cycle.sh` (TeX-source-first; optional 3-party convergence).
- **Autopilot**: `scripts/bin/run_autopilot.sh` (plan autofill + loop coordinator; uses `scripts/bin/autopilot_loop.py`).
- **Packet build only**: `scripts/bin/build_team_packet.py`, `scripts/bin/build_draft_packet.py`.
- **Literature fetch (INSPIRE/arXiv/Crossref/DataCite/DOI/GitHub)**: `scripts/bin/literature_fetch.py` (project-leader source-adapter helper for prework/KB building; reviewers must not use network).
  - Generic literature workflow sequencing authority lives in `literature-workflows` recipes / session protocol plus the checked-in launcher, not in this script.
  - Use `python3 "${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}/scripts/bin/literature_fetch.py" workflow-plan ...` when you need the launcher-resolved literature workflow plan during skill-side prework.
  - Subcommands (arXiv): `arxiv-search`, `arxiv-get --write-note`, `arxiv-source` (syntax: `python3 "${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}/scripts/bin/literature_fetch.py" <subcommand> ...`; downloads LaTeX source to `references/arxiv_src/<arxiv_id>/` by default).
- **Export a portable bundle**: `scripts/bin/export_paper_bundle.sh` (wrapper) / `scripts/bin/export_paper_bundle.py`.
- **KB index export (deterministic/L1)**: `scripts/bin/kb_export.py` + `scripts/bin/validate_kb_index.py` + `scripts/schemas/kb_index.schema.json`.
- **Demo generation**: `scripts/bin/generate_demo_milestone.sh`.
- **Project kickstart prompt**: `scripts/bin/generate_project_start_prompt.py`.
- **Deterministic hygiene tools** (as needed): `scripts/bin/fix_markdown_*`, `scripts/bin/fix_bibtex_revtex4_2.py`, `scripts/bin/upgrade_reference_anchors.py`.
- **Claim DAG & evidence** (optional): `scripts/bin/render_claim_graph.py` + gates under `scripts/gates/`.
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

## Deep dive (read only when needed)

- Full manual (English): `references/usage_guide.md`
- Chinese manual (human-oriented): `references/usage_guide.zh.md`
- KB index exporter (English): `references/kb_index.md`
- Troubleshooting / rerun recipes: `RUNBOOK.md`
- Gate contract notes: `FULL_VALIDATION_CONTRACT.md`
- Artifact contract: `references/artifact_contract.md`
