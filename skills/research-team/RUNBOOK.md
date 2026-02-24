# research-team — Failure-Mode Runbook (P1)

This runbook is for diagnosing deterministic gate failures and rerunning the workflow cleanly.
Agent-first note: paste a rerun command into your tool-using agent; run it manually only if you want local reproduction/debugging.

Where to start:
- Skill entry (trigger-loaded, lean): `SKILL.md`
- Full usage manual (English): `references/usage_guide.md`
- Chinese manual (human-oriented): `references/usage_guide.zh.md`
- This file: gate failures → fixes → rerun commands

## Quick rerun commands

- Preflight-only (no LLM calls):

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes Draft_Derivation.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --preflight-only
```

- Full cycle (preflight + Member A/B + convergence gate):

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes Draft_Derivation.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag
```

- Full cycle (force Member B to use Claude runner; Gemini optional):

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes Draft_Derivation.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --member-b-runner-kind claude \
  --auto-tag
```

Notes:
- Model selection is runtime-configured (templates avoid hard-coding model names). Use `run_team_cycle.sh --member-a-model ... --member-b-model ...` when needed.
- Sidecar reviewer model is controlled via `research_team_config.json -> sidecar_review.model` (empty uses the runner's default).

- Draft preflight-only (TeX-source-first; no LLM calls):

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_draft_cycle.sh \
  --tag D0-r1 \
  --tex main.tex \
  --bib references.bib \
  --out-dir team \
  --preflight-only
```

- Draft full cycle (preflight + A/B/Leader + draft convergence gate):

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_draft_cycle.sh \
  --tag D0-r1 \
  --tex main.tex \
  --bib references.bib \
  --out-dir team \
  --member-a-system prompts/_system_draft_member_a.txt \
  --member-b-system prompts/_system_draft_member_b.txt \
  --member-c-system prompts/_system_draft_member_c_leader.txt \
  --require-convergence
```

Notes:
- The draft packet includes a deterministic (heuristic) **Provenance / Uncertainty Risk Scan** section. Use it to quickly locate candidate statements about data provenance/sampling/uncertainties/weighting and enforce evidence-gating (do not infer missing details).

## Project stage (exploration vs development)

- Default stage is `development` (fail-fast gates).
- If `research_team_config.json` sets `project_stage=exploration`, `run_team_cycle.sh` keeps the Capsule gate (minimal variant) but downgrades selected preflight gates to warn-only and records debt at `team/runs/<tag>/<tag>_exploration_debt.md`.
- Switching back to `development` restores fail-fast behavior: clear the recorded debt first by marking checklist items `- [ ]` → `- [x]` in `team/runs/*/*_exploration_debt.md`.
- Debt helper (list/summary/close): `python3 ~/.codex/skills/research-team/scripts/bin/exploration_debt_dashboard.py summary --team-dir team`

## Review access mode (packet_only vs full_access)

- Configure in `research_team_config.json`:
  - `review_access_mode=packet_only`: reviewers use only the team packet (legacy/offline mode).
  - `review_access_mode=full_access`: reviewers request file reads / command runs / network fetches via a leader proxy; every access is logged and gated.
  - `isolation_strategy=separate_worktrees|sequential_with_acl`: best-effort isolation for `full_access` runs (audited via evidence + gates).
- Evidence files (full_access):
  - `team/runs/<tag>/member_a_evidence.json`
  - `team/runs/<tag>/member_b_evidence.json`
  - Validate: `python3 ~/.codex/skills/research-team/scripts/bin/validate_evidence.py team/runs/<tag>/member_a_evidence.json`

## Orientation (avoid “file swamp”)

In projects scaffolded by `research-team`, use the navigation front door instead of browsing directories:
- `PROJECT_MAP.md` (project root) is the single “start here” page (template: [project_map_template.md](assets/project_map_template.md)).
- Latest pointers are in `team/LATEST.md`, `team/LATEST_TEAM.md`, and `team/LATEST_DRAFT.md` (written by [update_project_map.py](scripts/bin/update_project_map.py)).
- Per-run outputs are grouped under `team/runs/<tag>/...` (packet, member reports, gate reports, adjudication).
- Draft-cycle convergence artifacts (when enabled) live under `team/runs/<tag>/...`:
  - `<tag>_draft_convergence_log.md`
  - `<tag>_draft_converged_summary.md`
- Run ledger: `team/trajectory_index.json` (machine-readable run history; also linked from `team/LATEST*.md`).
- Optional paper bundle export (project-local wrapper): `bash scripts/export_paper_bundle.sh --tag <TAG> --out export`.

## Common failures (what failed → how to fix → how to rerun)

### Draft convergence gate (TeX-source-first)

- Gate: [check_draft_convergence.py](scripts/gates/check_draft_convergence.py)
- Symptom: `draft cycle not converged` (exit 1) or `parse errors` (exit 2)
- Where to look:
  - `team/runs/<tag>/<tag>_draft_convergence_log.md`
  - `team/runs/<tag>/<tag>_draft_converged_summary.md`
- Fix:
  - If exit 1: apply all **Blocking** items from A/B/Leader reports (each must be actionable and locatable) and rerun with a new tag (e.g. `D0-r2`) until converged.
  - If exit 2: at least one report violated the output contract (missing `Verdict:` or `Blocking issues count:`). Update your prompt templates under `prompts/` to the latest scaffold defaults and rerun.
  - If you see unanchored statements about data provenance/sampling/uncertainties/weighting: treat as blocking evidence gaps. Add the minimal excerpt/citation anchor to the draft/packet (or remove/soften the claim) and rerun.
- Rerun:
  - Use the “Draft full cycle” command from the Quick rerun section above.

### TeX draft preflight gate (TeX-source-first)

- Gate: [check_tex_draft_preflight.py](scripts/gates/check_tex_draft_preflight.py)
- Symptom: `missing BibTeX entries for cited keys` (exit 1)
- Fix:
  - Add the missing keys to your `.bib`.
  - Helpers (project leader; network allowed; logs go to KB trace when you write notes):
    - INSPIRE BibTeX by citekey/texkey: `python3 ~/.codex/skills/research-team/scripts/bin/literature_fetch.py inspire-bibtex --texkey <CITEKEY>`
    - INSPIRE BibTeX by recid: `python3 ~/.codex/skills/research-team/scripts/bin/literature_fetch.py inspire-bibtex --recid <RECID>`
    - DOI BibTeX (content negotiation): `python3 ~/.codex/skills/research-team/scripts/bin/literature_fetch.py doi-bibtex --doi <DOI>`
  - RevTeX 4.2 BibTeX workaround (APS styles): ensure `@article{...}` entries include `journal=""`:
    - Fix existing file: `python3 ~/.codex/skills/research-team/scripts/bin/fix_bibtex_revtex4_2.py --bib references.bib --in-place`
    - Or fetch with fix applied: add `--revtex-fix-journal` to `inspire-bibtex` / `doi-bibtex`.
- Rerun:
  - Use the “Draft preflight-only” command from the Quick rerun section above.

### Reproducibility Capsule gate

- Gate: [check_reproducibility_capsule.py](scripts/gates/check_reproducibility_capsule.py)
- Symptom: `Reproducibility Capsule incomplete`
- Fix:
  - Fill the capsule block between `<!-- REPRO_CAPSULE_START -->` and `<!-- REPRO_CAPSULE_END -->`.
  - Keep derivations in the notebook body; the capsule is a reproducibility contract only.
  - Make sure `### G) Sweep semantics / parameter dependence` and `### H) Branch Semantics / Multi-root Contract` are present and filled (even if “none”).
- Rerun:
  - Use the preflight-only command above.

### Project map gate (navigation front door)

- Gate: [check_project_map.py](scripts/gates/check_project_map.py)
- Symptom: `missing PROJECT_MAP.md` / `PROJECT_MAP.md missing required link(s)`
- Fix:
  - If you never scaffolded: rerun `scaffold_research_workflow.sh` (without `--force`) to fill missing navigation files.
  - Or generate/update deterministically:
    - `python3 ~/.codex/skills/research-team/scripts/bin/update_project_map.py --notes Draft_Derivation.md --team-dir team`
  - Ensure `PROJECT_MAP.md` links to the canonical docs + `team/LATEST.md` + `artifacts/LATEST.md`.
- Rerun:
  - Preflight-only command.

### hep-research-mcp workspace gate (ecosystem bootstrap)

- Gate: [check_hep_workspace.py](scripts/gates/check_hep_workspace.py)
- Symptom: `missing hep workspace file: .../.hep/workspace.json` or `workspace schemaVersion must be 1.0`
- Fix:
  - Create the workspace + mappings files (from project root):
    - `mkdir -p .hep`
    - `cp ~/.codex/skills/research-team/assets/hep_workspace_template.json .hep/workspace.json`
    - `cp ~/.codex/skills/research-team/assets/hep_mappings_template.json .hep/mappings.json`
  - When using hep-research-mcp tools, recommended env var: `export HEP_DATA_DIR="$PWD/.hep-research-mcp"`
  - Optional (not recommended): disable via config `features.hep_workspace_gate=false`
- Rerun:
  - Preflight-only command.

### Research plan gate

- Gate: [check_research_plan.py](scripts/gates/check_research_plan.py)
- Symptom: `RESEARCH_PLAN.md appears to be a template`
- Fix:
  - Fill `RESEARCH_PLAN.md` Task Board and milestone DoD fields.
  - Optional deterministic autofill (if enabled by config): `python3 ~/.codex/skills/research-team/scripts/bin/auto_fill_research_plan.py --root . --deterministic`.
- Rerun:
  - Preflight-only command.

### Project charter gate (goal drift prevention)

- Gate: [check_project_charter.py](scripts/gates/check_project_charter.py)
- Symptom: `project charter gate failed` / `Status must be one of`
- Fix:
  - Edit `PROJECT_CHARTER.md`:
    - Set `Status: APPROVED` (after human review).
    - Ensure `Declared profile:` matches `research_team_config.json`.
    - Add at least 2 “Project-specific commitments”, including at least 1 clickable `knowledge_base/` link.
  - Do not hide links inside HTML comments; do not wrap links in backticks.
- Rerun:
  - Preflight-only command.

### Knowledge layers gate (KB minimums)

- Gate: [check_knowledge_layers.py](scripts/gates/check_knowledge_layers.py)
- Symptom: `knowledge layers check failed`
- Fix:
  - Ensure `knowledge_base/` contains at least:
    - `knowledge_base/literature/` (≥ configured minimum)
    - `knowledge_base/methodology_traces/` (≥ configured minimum)
    - `knowledge_base/priors/` (≥ configured minimum)
  - In the capsule, fill `### I) Knowledge base references` with clickable links to those notes.
  - Prefer human-readable link text for scanability, e.g. `RefKey — Authors — Title` for literature notes.
  - Deterministic helper to upgrade existing capsule links: `python3 ~/.codex/skills/research-team/scripts/bin/format_kb_reference_links.py --notes Draft_Derivation.md --in-place`
  - If a referenced KB note contains display math:
    - Do not use LaTeX `\(` `\)` `\[` `\]`; use `$...$` / `$$...$$`.
    - In `$$...$$` blocks, no line may start with `+`, `-`, or `=` (Markdown hazards). Prefix with `\quad` or rewrite.
    - Avoid splitting a single equation into back-to-back `$$` blocks; keep one `$$...$$` block and use TeX line breaks.
    - Deterministic autofix helper (safe for common cases): `python3 ~/.codex/skills/research-team/scripts/bin/fix_markdown_math_hygiene.py --root <path> --in-place`
- Rerun:
  - Preflight-only command.

### Problem Framing Snapshot gate (PREWORK.md)

- Gate: [check_problem_framing_snapshot.py](scripts/gates/check_problem_framing_snapshot.py)
- Symptom: `Problem Framing Snapshot check failed`
- Fix:
  - Fill `PREWORK.md` `## Problem Framing Snapshot` (Problem interpretation + P/D separation + sequential review).
  - Optional deterministic autofill: `python3 ~/.codex/skills/research-team/scripts/bin/auto_fill_prework.py --root . --deterministic`.
- Rerun:
  - Preflight-only command.

### References gate (clickable + provenance)

- Gate: [check_references_section.py](scripts/gates/check_references_section.py)
- Symptom: `references gate failed`
- Fix:
  - Add a `## References` section header to `Draft_Derivation.md` (a localized header is also accepted).
  - Each entry must include:
    - [@Key](#ref-Key) and an anchor `<a id="ref-Key"></a>` on the same line
    - a clickable `knowledge_base/` link
    - an allowed external link (INSPIRE/arXiv/DOI/GitHub + common software/docs/Zenodo; configurable via `references.allowed_external_hosts_extra`) or explicit `Link: none`
    - author attribution + year (or `Retrieved: YYYY-MM-DD`)
  - Do not wrap citations/links in backticks (they become non-clickable).
  - If you pasted unstable URL variants (e.g., `dx.doi.org`, `arxiv.org/pdf/...pdf`, `inspirehep.net/api/...`), normalize them deterministically:
    - `python3 ~/.codex/skills/research-team/scripts/bin/upgrade_reference_anchors.py --notes Draft_Derivation.md --in-place`
  - If your metadata fetch fails due to DNS/network issues but you need to keep moving:
    - Re-run the fetch with `--allow-stub` (creates an auditable stub KB note + reference entry; publication stage will block until metadata is filled).
- Rerun:
  - Preflight-only command.

### Notebook integrity gate (rendering safety)

- Gate: [check_notebook_integrity.py](scripts/gates/check_notebook_integrity.py)
- Symptom: `notebook integrity check failed`
- Fix:
  - Marker blocks: keep exactly one of each marker block (capsule / audit slices / review excerpt).
  - Review excerpt: must not be empty template text.
  - Math policy:
    - Do not use `\(` `\)` `\[ ` `\]`; use `$...$` / `$$...$$`.
    - In `$$...$$` blocks, no line may start with `+`, `-`, or `=` (Markdown hazards).
    - Deterministic autofix helper: `python3 ~/.codex/skills/research-team/scripts/bin/fix_markdown_math_hygiene.py --root Draft_Derivation.md --in-place`
  - Link policy:
    - Never put Markdown links (or `knowledge_base/*.md` paths) inside inline code spans.
- Rerun:
  - Preflight-only command.

### Markdown math hygiene gate (global scan)

- Gate: [check_markdown_math_hygiene.py](scripts/gates/check_markdown_math_hygiene.py)
- Symptom: `markdown math hygiene gate failed`
- Default scan targets (configurable in `research_team_config.json`):
  - `Draft_Derivation.md`
  - `PREWORK.md`
  - `RESEARCH_PLAN.md`
  - `PROJECT_CHARTER.md`
  - `PROJECT_MAP.md`
  - `knowledge_base/**/*.md`
- Fix:
  - Deterministic autofix helper (safe for common cases): `python3 ~/.codex/skills/research-team/scripts/bin/fix_markdown_math_hygiene.py --root <path> --in-place`
  - If the gate reports disallowed `\(` `\)` `\[` `\]`, rewrite to `$...$` / `$$...$$` manually.
  - If the gate reports `$$` not on its own line, rewrite into fenced display math with standalone `$$` lines.
- Rerun:
  - Preflight-only command.

### Markdown math portability gate (warn-only by default)

- Gate: [check_markdown_math_portability.py](scripts/gates/check_markdown_math_portability.py)
- Output:
  - Warnings like: `[warn] markdown math portability: slashed=..., table_math_pipes=...`
  - Fail-fast only if enforcement is enabled (see config below).
- Checks (v1; conservative):
  - `\slashed` usage in Markdown math (renderer compatibility varies).
  - Literal `|` inside inline math `$...$` on Markdown table lines (often breaks table parsing).
- Fix:
  - Prefer a portable fallback like `\not\!` instead of `\slashed{...}` in Markdown notes.
  - In Markdown tables, rewrite `$|x|$` as `$\lvert x \rvert$` (norm: `\lVert x \rVert`; conditional bar: `\mid`), or move math out of the table.
- Config:
  - Toggle: `features.markdown_math_portability_gate`
  - Enforcement (default false / warn-only): `markdown_math_portability.enforce_table_math_pipes`, `markdown_math_portability.enforce_slashed`
- Rerun:
  - Preflight-only command.

### Double-backslash math gate (global scan)

- Gate: [check_double_backslash_math.py](scripts/gates/check_double_backslash_math.py)
- Symptom: `double-backslash math gate failed`
- Scope: uses the same scan targets as the Markdown math hygiene gate (`markdown_math_hygiene.targets` / `exclude_globs`).
- Fix:
  - Deterministic fix (recommended; targets key docs only): `python3 ~/.codex/skills/research-team/scripts/bin/fix_markdown_double_backslash_math.py --notes Draft_Derivation.md --in-place`
  - Check-only helper (warn or fail): `bash ~/.codex/skills/research-team/scripts/bin/check_md_double_backslash.sh --notes Draft_Derivation.md [--fail]`
  - Notes:
    - The fixer only rewrites inside Markdown math regions (`$...$`, `$$...$$`) and never touches fenced code blocks.
    - It does NOT rewrite real LaTeX line breaks (`\\`) or spacing commands (`\\[2pt]`).
- Rerun:
  - Preflight-only command.

### LaTeX macro hygiene gate (global scan)

- Gate: [check_markdown_latex_macro_hygiene.py](scripts/gates/check_markdown_latex_macro_hygiene.py)
- Symptom: `latex macro hygiene gate failed`
- Default scan targets (configurable in `research_team_config.json`):
  - `Draft_Derivation.md`
  - `PREWORK.md`
  - `RESEARCH_PLAN.md`
  - `PROJECT_CHARTER.md`
  - `PROJECT_MAP.md`
  - `knowledge_base/**/*.md`
- Fix:
  - Expand custom macros (e.g. `\Rc`, `\Mc`, `\Cc`, `\cK`) into explicit forms (e.g. `\mathcal{R}`).
  - Deterministic autofix helper: `python3 ~/.codex/skills/research-team/scripts/bin/fix_markdown_latex_macros.py --root <path> --in-place`
  - If you have local LaTeX sources (e.g. `references/arxiv_src/`), you can deterministically discover safe 0-arg macro expansions and merge them into your JSON config (explicit opt-in): `python3 ~/.codex/skills/research-team/scripts/bin/discover_latex_zero_arg_macros.py --root . --update-config`
- Rerun:
  - Preflight-only command.

### Markdown link hygiene gate (global scan)

- Gate: [check_markdown_link_hygiene.py](scripts/gates/check_markdown_link_hygiene.py)
- Symptom: `markdown link hygiene gate failed`
- Default scan targets (configurable in `research_team_config.json`):
  - `Draft_Derivation.md`
  - `PREWORK.md`
  - `RESEARCH_PLAN.md`
  - `PROJECT_CHARTER.md`
  - `PROJECT_MAP.md`
  - `knowledge_base/**/*.md`
- Fix:
  - Do not wrap links/citations/path pointers in inline code spans (backticks); use Markdown links so paths are clickable.
  - Deterministic autofix helper: `python3 ~/.codex/skills/research-team/scripts/bin/fix_markdown_link_hygiene.py --root <path> --in-place`
- Rerun:
  - Preflight-only command.

### Pointer lint gate (code pointers)

- Gate: [check_pointer_lint.py](scripts/gates/check_pointer_lint.py)
- Symptom: `pointer lint failed` (and a generated report under `team/runs/<tag>/<tag>_pointer_lint.md`)
- Fix:
  - Ensure notebook code pointers are valid for the configured strategy:
    - `python_import`: dotted pointers like `pkg.module.symbol` must import-resolve.
    - `file_symbol_grep`: file pointers like `src/foo.jl:myfunc` must exist and contain the symbol.
  - If using conda/venv, set `RESEARCH_TEAM_IMPORT_CMD` or pass `--pointer-import-cmd`.
- Rerun:
  - Preflight-only command.

### Scan dependency gate (rules-file driven)

- Gate: [check_scan_dependency.py](scripts/gates/check_scan_dependency.py)
- Symptom: `scan dependency check failed`
- Fix:
  - Ensure the scan CSV + manifest are listed in capsule `### D) Expected outputs` and exist on disk.
  - Populate `scan_dependency_rules.json` with triggers + required columns/manifest keys.
  - If intentionally bypassing, record `AUDIT_OVERRIDE: warn-only` or `AUDIT_OVERRIDE: disable-scan-dep` in capsule G (use sparingly; leave a rationale).
- Rerun:
  - Preflight-only command.

### Branch semantics / multi-root gate

- Gate: [check_branch_completeness.py](scripts/gates/check_branch_completeness.py)
- Symptom: `branch completeness gate failed`
- Fix:
  - In capsule H, if `Multi-root quantities` is not `none`, you must:
    - list all branches
    - specify per-branch output files and required columns
    - add at least 1 non-mixing invariant (ordering / continuity / label-stability)
    - provide at least 1 diagnostic artifact path that exists
    - cite the per-branch outputs in the notebook body (outside the capsule)
- Rerun:
  - Preflight-only command.

### Member runner failure (Claude/Gemini CLI)

- Symptom: `[error] member runner failed (member-a=..., member-b=...)`
- Fix:
  - Check environment:
    - Default (A=Claude, B=Gemini): `bash ~/.codex/skills/research-team/scripts/bin/check_environment.sh --require-claude --require-gemini`
    - Claude-only (B via Claude): `bash ~/.codex/skills/research-team/scripts/bin/check_environment.sh --require-claude`
  - Ensure `prompts/_system_member_a.txt` and `prompts/_system_member_b.txt` exist.
  - If you have project-local runners, confirm `scripts/run_claude.sh` and `scripts/run_gemini.sh` are executable.
  - If Gemini CLI returns a blank response (common after CLI upgrades / auth drift), `run_team_cycle.sh` may fall back to Claude automatically when using the default Gemini runner (no `--member-b-runner` override). You can also force Claude for Member B:
    - CLI: `run_team_cycle.sh --member-b-runner-kind claude`
    - Config: set `member_b.runner_kind=claude` (optional `member_b.claude_system_prompt`) in `research_team_config.json`.
  - If you want Gemini and it returns a blank response:
    - Sanity test headless mode: `gemini --output-format json --prompt "Hello" | python3 -c 'import json,sys; print(json.load(sys.stdin).get(\"response\",\"\"))'`
    - If the printed response is empty, re-check Gemini CLI authentication/config (see `https://geminicli.com/docs/get-started/authentication/`).
    - Note: a line like `Hook registry initialized...` is a harmless stderr preamble; the runner ignores it.
  - Claude attempt-level diagnostics (new):
    - `run_team_cycle.sh` now writes per-attempt logs under:
      - `team/runs/<tag>/logs/`
      - Examples: `<tag>_member_a_attempt_01.stderr.log`, `<tag>_member_b_attempt_02.meta.json`
    - `cycle_state.json` now records attempt summaries when logs are available:
      - `runners.member_a.attempts_total`
      - `runners.member_a.failed_attempts`
      - `runners.member_a.last_error_excerpt`
      - `runners.member_a.last_error_log`
      - (same fields for `member_b`; `member_c` when sidecar logs are present)
- Rerun:
  - Full cycle command with a new tag (prefer `--auto-tag`).

### Not converged (Member A/B disagree)

- Gate: [check_team_convergence.py](scripts/gates/check_team_convergence.py)
- Symptom: `[gate] Not converged. Apply fixes and re-run...`
- Fix:
  - Read:
    - `team/runs/<tag>/<tag>_member_a.md`
    - `team/runs/<tag>/<tag>_member_b.md`
  - Write an adjudication note:
    - `mkdir -p team/runs/<next_tag>`
    - `python3 ~/.codex/skills/research-team/scripts/bin/build_adjudication_response.py --tag <next_tag> --member-a team/runs/<tag>/<tag>_member_a.md --member-b team/runs/<tag>/<tag>_member_b.md --out team/runs/<next_tag>/<next_tag>_adjudication.md`
  - Apply fixes to the notebook/code/artifacts and rerun with a fresh tag.
- Rerun:
  - Full cycle command with `--auto-tag` (do not reuse tags; trajectory is an upsert index).

## Deterministic developer regressions (skill repo)

- Smoke suite:

```bash
bash scripts/dev/run_all_smoke_tests.sh
```

- One-shot self-audit (creates/refreshes a local `skilldev/` workspace and runs preflight-only by default):

```bash
bash scripts/dev/run_skilldev_self_audit.sh
```

- Realism regression (preflight-only on registered real projects; snapshot-by-default):

```bash
bash scripts/dev/run_real_project_regression.sh
```

- Full contract deterministic harness:

```bash
bash scripts/validation/run_full_contract_validation.sh
```
