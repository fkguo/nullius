# research-team skill roadmap

This file is the repo SSOT for the `research-team` skill development roadmap.

Principles:
- Optimize for real research (derivation + numerics + literature/code toolkit extraction + innovation).
- Prefer staged enforcement: `exploration` warns + logs debt; `development/publication` enforce + clear debt.
- Keep policies auditable (trace logs + stable citation anchors), not “hard cutoff” by default.

## Status

### M1 (done): Self-evolution workspace + exploration debt dashboard

Delivered:
- Local self-evolution workspace: `skilldev/` (git-ignored; generated).
- One-shot maintainer entrypoint: `scripts/dev/run_skilldev_self_audit.sh` (defaults to `--preflight-only`).
- Deterministic workspace initializer: `scripts/dev/init_skilldev_workspace.sh`.
- Exploration debt tooling: `scripts/bin/exploration_debt_dashboard.py` + shared parser + gate.
- Local realism regression harness (snapshot-by-default): `scripts/dev/register_real_project_regression.sh` + `scripts/dev/run_real_project_regression.sh`.
- Docs/templates updated to allow general scholarly discovery *with trace logging* and stable final anchors.

### M1.1 (done): Minimal scaffold variant (reduce unused files)

Delivered:
- `scaffold_research_workflow.sh --minimal` for a smaller “core-only” project scaffold.
- Variant-aware scaffold contract checks: `scripts/dev/check_scaffold_output_contract.sh --variant full|minimal` (defaults to inferring from `research_team_config.json`).
- Smoke test for minimal scaffold: `scripts/dev/smoke/smoke_test_scaffold_minimal.sh`.

### M1.2 (done): Optional scaffold prune (archive, don’t delete)

Delivered:
- Deterministic prune tool (dry-run by default): `scripts/bin/prune_optional_scaffold.py`
- Smoke test: `scripts/dev/smoke/smoke_test_prune_optional_scaffold.sh`

### M1.3 (done): Member B runner-kind selection + gemini health fallback

Delivered:
- Config: `research_team_config.json -> member_b.runner_kind (gemini|claude|auto)` and optional `member_b.claude_system_prompt`.
- CLI: `run_team_cycle.sh --member-b-runner-kind gemini|claude|auto` and optional `--member-b-system-claude <path>`.
- Runtime behavior:
  - `--preflight-only` remains fully deterministic and does not probe any LLM CLIs.
  - When using the default Gemini runner (no `--member-b-runner` override), `run_team_cycle.sh` performs a quick gemini health check and falls back to Claude when gemini returns empty/invalid JSON `response`.
- Smoke coverage: `scripts/dev/smoke/smoke_test_member_b_runner_kind.sh`.
- Assets are now model-agnostic (no hard-coded vendor model names):
  - `assets/run_claude.sh` no longer defaults to a specific model; prefer setting models at runtime (e.g., `run_team_cycle.sh --member-a-model ... --member-b-model ...`).
  - `assets/research_team_config_template.json` no longer hard-codes a sidecar model; set `sidecar_review.model` per project if desired.
  - Smoke coverage: `scripts/dev/smoke/smoke_test_assets_model_agnostic.sh`.

## Next milestones

Detailed execution plan (work packages + acceptance tests): `PLAN_M2_M4.md`.

### M2: Audited discovery + references pipeline (no hard cutoffs in exploration)

Goal: make “general search → trace → stable anchor → verified metadata” a first-class, low-friction loop.

Deliverables:
- Stage-aware references enforcement:
  - `exploration`: warn (and record debt) for non-anchored / non-allowlisted links.
  - `development`: block unresolved anchors.
  - `publication`: block + verify metadata consistency.
- Reference resolver + cache (DOI/arXiv/title → normalized metadata + BibTeX):
  - Prefer Crossref (DOI) + arXiv API; optional DataCite for datasets/software.
- “Search trace” template + lightweight gate to ensure query→selection is logged when discovery is used.
- “Anchor upgrade” helper: convert exploration URLs to stable anchors (DOI/Zenodo/Software Heritage) or audited exceptions.
- Minimal regression harness:
  - A deterministic mini-project spec (paper + a few equations + a tiny script) to run as smoke/regression after each change.

Acceptance:
- New smoke tests covering stage severity + resolver behavior (with mocked HTTP responses / cached fixtures).
- One end-to-end “mini-project” run produces: verified `## References` entries + trace rows + zero unresolved items at `development`.

### M3: Theory ↔ numerics correspondence + toolkit extraction

Goal: reduce “hand-wavy mapping” between derivations and code; promote reusable methods into toolkits.

Deliverables:
- Correspondence manifest spec (equation-id → code function → test) + deterministic validator gate.
- Optional CAS bridge helper (e.g., SymPy export proposals) as *tooling* (human-approved), not authoritative truth.
- Toolkit extraction promotion script (from methodology traces + marked code blocks into reusable modules).

Acceptance:
- A demo milestone where at least N equations are covered by functions + tests; validator gate passes.

### M4: External review protocol + debt graduation + lineage audit

Goal: strengthen reliability and “why we believe this” traceability without blocking exploration.

Deliverables:
- Standardized external B-check prompt + machine-checkable output contract (issues list + severity + reproduction steps).
- Debt graduation workflow: turn exploration debt into formal artifacts (tests/notes/anchors) with a clear “done” definition.
- Lineage/audit tooling: trace `query → trace → claim → derivation → code → outputs` and flag orphan artifacts.

Acceptance:
- A demo cycle that runs B-check with Claude+Gemini and produces a validated issue report; lineage tool reports no orphans.

## Do we need a “real project”?

Not for M1 (self-audit runs on generated workspaces). For M2+, one real project (even sanitized) is strongly recommended as a “realism regression” to prevent overfitting to toy examples.

Minimal input spec:
- 1–2 papers (arXiv/DOI), plus one software/data citation that is *not* a stable paper link (to test anchor upgrading).
- 1 short derivation section with at least a few equations + one numeric script (<200 LOC) + a plot/output.
- A couple of “messy” exploration artifacts (temporary links, TODO notes) to ensure debt tooling is exercised.
