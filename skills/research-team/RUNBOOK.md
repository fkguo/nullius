# research-team — Failure-Mode Runbook (P1)

This runbook is for diagnosing deterministic gate failures and rerunning the workflow cleanly.
Agent-first note: paste a rerun command into your tool-using agent; run it manually only if you want local reproduction/debugging.
All public real-project commands below assume the project root is outside the nullius development repo, and real-project outputs such as `team/` stay outside the dev repo as well.

Where to start:
- Skill entry (trigger-loaded, lean): `SKILL.md`
- Full usage manual (English): `references/usage_guide.md`
- Chinese manual (human-oriented): `references/usage_guide.zh.md`
- This file: gate failures → fixes → rerun commands

Portable installed-skill path for the commands below:

```bash
export SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
```

## Quick rerun commands

- Preflight-only (no LLM calls):

```bash
bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag 20260502T023000Z-m0-topic \
  --notes research_contract.md \
  --out-dir artifacts \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --preflight-only
```

- Full cycle (preflight + Member A/B + convergence gate):

```bash
bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag 20260502T023000Z-m0-topic \
  --notes research_contract.md \
  --out-dir artifacts \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag
```

- Full cycle (provider override: force Member B to use Claude runner; Gemini remains optional):

```bash
bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag 20260502T023000Z-m0-topic \
  --notes research_contract.md \
  --out-dir artifacts \
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
bash "${SKILL_DIR}/scripts/bin/run_draft_cycle.sh" \
  --tag D0-r1 \
  --tex main.tex \
  --bib references.bib \
  --out-dir artifacts \
  --preflight-only
```

- Draft full cycle (preflight + A/B/Leader + draft convergence gate):

```bash
bash "${SKILL_DIR}/scripts/bin/run_draft_cycle.sh" \
  --tag D0-r1 \
  --tex main.tex \
  --bib references.bib \
  --out-dir artifacts \
  --member-a-system prompts/_system_draft_member_a.txt \
  --member-b-system prompts/_system_draft_member_b.txt \
  --member-c-system prompts/_system_draft_member_c_leader.txt \
  --require-convergence
```

Notes:
- The draft packet includes a deterministic (heuristic) **Provenance / Uncertainty Risk Scan** section. Use it to quickly locate candidate statements about data provenance/sampling/uncertainties/weighting and enforce evidence-gating (do not infer missing details).

## Project stage (exploration vs development)

- Default stage is `development` (fail-fast gates).
- If `research_team_config.json` sets `project_stage=exploration`, `run_team_cycle.sh` keeps the Capsule gate (minimal variant) but downgrades selected preflight gates to warn-only and records debt at `artifacts/runs/<tag>/research_team/<tag>_exploration_debt.md`.
- Switching back to `development` restores fail-fast behavior: clear the recorded debt first by marking checklist items `- [ ]` → `- [x]` in `artifacts/runs/*/research_team/*_exploration_debt.md`.
- Debt helper (list/summary/close): `python3 "${SKILL_DIR}/scripts/bin/exploration_debt_dashboard.py" summary --team-dir team`

## Review access mode (packet_only vs full_access)

- Configure in `research_team_config.json`:
  - `review_access_mode=packet_only`: reviewers use only the team packet (legacy/offline mode).
  - `review_access_mode=full_access`: reviewers request file reads / command runs / network fetches via a leader proxy; every access is logged and gated.
  - `isolation_strategy=separate_worktrees|sequential_with_acl`: best-effort isolation for `full_access` runs (audited via evidence + gates).
- Evidence files (full_access):
  - `artifacts/runs/<tag>/research_team/member_a_evidence.json`
  - `artifacts/runs/<tag>/research_team/member_b_evidence.json`
  - Validate: `python3 "${SKILL_DIR}/scripts/bin/validate_evidence.py" artifacts/runs/<tag>/research_team/member_a_evidence.json`

## Orientation (avoid “file swamp”)

In projects scaffolded by `research-team`, use the navigation front door instead of browsing directories:
- `project_index.md` (project root) is the single “start here” page (template: [project_map_template.md](assets/project_map_template.md)).
- `team/LATEST.md` is the stable pointer index written by [update_project_map.py](scripts/bin/update_project_map.py).
- `team/LATEST_TEAM.md`, `team/LATEST_DRAFT.md`, and `artifacts/LATEST.md` appear only after the corresponding live cycle/run has been materialized; older/stale placeholders should not be treated as guaranteed navigation surfaces.
- Per-run outputs are grouped under `artifacts/runs/<tag>/research_team/...` (packet, member reports, gate reports, adjudication).
- On convergence, when an `nullius` CLI is reachable (project-local `.nullius/bin/nullius` or on `PATH`), two dependency graphs are rendered best-effort via `nullius graph` (consuming the `@nullius/shared/graph-viz` engine): the **Claim DAG** to `knowledge_graph/claims.dot` (the epistemic view — only when `knowledge_graph/claims.jsonl` + `edges.jsonl` exist) and the **milestone/task progress map** to `artifacts/runs/<tag>/research_team/progress.dot` (the planning view — only when `research_plan.md` exists). Each is skipped silently when its inputs or the CLI are absent, is bounded so it can never hang, and never affects convergence.
- Draft-cycle convergence artifacts (when enabled) live under `artifacts/runs/<tag>/research_team/...`:
  - `<tag>_draft_convergence_log.md`
  - `<tag>_draft_converged_summary.md`
- Run ledger: `team/trajectory_index.json` (machine-readable run history; linked from `team/LATEST.md` and any live cycle pointers).
- Optional paper bundle export (project-local wrapper): `bash scripts/export_paper_bundle.sh --tag <run_id> --out export`.

## Common failures (what failed → how to fix → how to rerun)

### Draft convergence gate (TeX-source-first)

- Gate: [check_draft_convergence.py](scripts/gates/check_draft_convergence.py)
- Symptom: `draft cycle not converged` (exit 1) or `parse errors` (exit 2)
- Where to look:
  - `artifacts/runs/<tag>/research_team/<tag>_draft_convergence_log.md`
  - `artifacts/runs/<tag>/research_team/<tag>_draft_converged_summary.md`
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
    - INSPIRE BibTeX by citekey/texkey: `python3 "${SKILL_DIR}/scripts/bin/literature_fetch.py" inspire-bibtex --texkey <CITEKEY>`
    - INSPIRE BibTeX by recid: `python3 "${SKILL_DIR}/scripts/bin/literature_fetch.py" inspire-bibtex --recid <RECID>`
    - DOI BibTeX (content negotiation): `python3 "${SKILL_DIR}/scripts/bin/literature_fetch.py" doi-bibtex --doi <DOI>`
  - RevTeX 4.2 BibTeX workaround (APS styles): ensure `@article{...}` entries include `journal=""`:
    - Fix existing file: `python3 "${SKILL_DIR}/scripts/bin/fix_bibtex_revtex4_2.py" --bib references.bib --in-place`
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
- Symptom: `missing project_index.md` / `project_index.md missing required link(s)`
- Fix:
  - If the root index is missing, run `nullius init --project-root "$PWD"` from the external project root to create the missing scaffold.
  - If an existing index lacks required links, edit its navigation explicitly, preserving human content and curated result/report selections. Ensure it links to the canonical docs + `team/LATEST.md`; `artifacts/LATEST.md` should appear only after a live artifact run materializes it.
  - To refresh only executor-local latest pointers after the root index exists:
    - `python3 "${SKILL_DIR}/scripts/bin/update_project_map.py" --notes research_contract.md --team-dir team`
    - This helper neither creates nor edits `project_index.md`; it refuses a missing root index with `nullius init` guidance.
- Rerun:
  - Preflight-only command.

### HEP provider bundle gate (optional)

- Gate: [check_hep_workspace.py](scripts/gates/check_hep_workspace.py)
- Symptom: `missing hep workspace file: .../.hep/workspace.json` or `workspace schemaVersion must be 1.0`
- Fix:
  - This gate is opt-in. Enable it only when the project explicitly uses the HEP provider bundle:
    - scaffold with `--with-hep-provider`, or
    - set `features.hep_workspace_gate=true` in `research_team_config.json`
  - Create the workspace + mappings files (from project root):
    - `mkdir -p .hep`
    - `cp "${SKILL_DIR}/assets/hep_workspace_template.json" .hep/workspace.json`
    - `cp "${SKILL_DIR}/assets/hep_mappings_template.json" .hep/mappings.json`
  - When using hep-mcp tools, recommended env var: `export HEP_DATA_DIR="$PWD/.hep-mcp"`
- Rerun:
  - Preflight-only command.

### Research plan gate

- Gate: [check_research_plan.py](scripts/gates/check_research_plan.py)
- Symptom: `research_plan.md appears to be a template`
- Fix:
  - Fill `research_plan.md` Task Board and milestone DoD fields.
  - Optional deterministic autofill (if enabled by config): `python3 "${SKILL_DIR}/scripts/bin/auto_fill_research_plan.py" --root . --deterministic`.
- Rerun:
  - Preflight-only command.
- Plan-summary / milestone-handoff tip: when communicating the plan to a stakeholder, closing out a milestone, or handing off, produce a **roadmap dependency-map** (summary table + milestone/lane dependency graph + binding-constraint + critical path) from [roadmap_dependency_map_template.md](assets/roadmap_dependency_map_template.md); render the graph with `nullius graph --kind roadmap --spec <roadmap.json>`. This is a planning view, distinct from the Claim DAG (`knowledge_graph/`).

### Project charter gate (goal drift prevention)

- Gate: [check_project_charter.py](scripts/gates/check_project_charter.py)
- Symptom: `project charter gate failed` / `Status must be one of`
- Fix:
  - Edit `project_charter.md`:
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
  - Deterministic helper to upgrade existing capsule links: `python3 "${SKILL_DIR}/scripts/bin/format_kb_reference_links.py" --notes research_contract.md --in-place`
  - If a referenced KB note contains display math:
    - Do not use LaTeX `\(` `\)` `\[` `\]`; use `$...$` / `$$...$$`.
    - In `$$...$$` blocks, no line may start with `+`, `-`, or `=` (Markdown hazards). Prefix with `\quad` or rewrite.
    - Avoid splitting a single equation into back-to-back `$$` blocks; keep one `$$...$$` block and use TeX line breaks.
    - Deterministic autofix helper (safe for common cases): `python3 "${SKILL_DIR}/scripts/bin/fix_markdown_math_hygiene.py" --root <path> --in-place`
- Rerun:
  - Preflight-only command.

### Problem Framing Snapshot gate (research_preflight.md)

- Gate: [check_problem_framing_snapshot.py](scripts/gates/check_problem_framing_snapshot.py)
- Symptom: `Problem Framing Snapshot check failed`
- Fix:
  - Fill `research_preflight.md` `## Problem Framing Snapshot` (Problem interpretation + P/D separation + sequential review).
  - Optional deterministic autofill: `python3 "${SKILL_DIR}/scripts/bin/auto_fill_prework.py" --root . --deterministic`.
- Rerun:
  - Preflight-only command.

### References gate (clickable + provenance)

- Gate: [check_references_section.py](scripts/gates/check_references_section.py)
- Symptom: `references gate failed`
- Fix:
  - Add a `## References` section header to `research_contract.md` (a localized header is also accepted).
  - Each entry must include:
    - [@Key](#ref-Key) and an anchor `<a id="ref-Key"></a>` on the same line
    - a clickable `knowledge_base/` link
    - an allowed external link (INSPIRE/arXiv/DOI/GitHub + common software/docs/Zenodo; configurable via `references.allowed_external_hosts_extra`) or explicit `Link: none`
    - author attribution + year (or `Retrieved: YYYY-MM-DD`)
  - Do not wrap citations/links in backticks (they become non-clickable).
  - If you pasted unstable URL variants (e.g., `dx.doi.org`, `arxiv.org/pdf/...pdf`, `inspirehep.net/api/...`), normalize them deterministically:
    - `python3 "${SKILL_DIR}/scripts/bin/upgrade_reference_anchors.py" --notes research_contract.md --in-place`
  - If your metadata fetch fails due to DNS/network issues but you need to keep moving:
    - Re-run the fetch with `--allow-stub` (creates an auditable stub KB note + reference entry; publication stage will block until metadata is filled).
- Rerun:
  - Preflight-only command.

### Scientific notebook closeout (current full-text review)

- Structural navigation and content acceptance are separate. Deterministic
  rendering checks, result links, automatic tables, formula counts, completed
  checklists, and the writer's assessment cannot supply a content verdict.
- After rewriting the affected sections into a coherent whole, finish the
  notebook and refresh its automatic block. From the external project root:

  ```bash
  nullius notebook sync
  nullius notebook review --model claude/opus --dependency <project-relative-path>
  nullius notebook check --json
  ```

- Repeat `--dependency` for every required supporting file; omit it only when
  no such dependency is needed. One semantic review executes via review-swarm
  in bounded calls, with a default hard 1200-second timeout and no automatic retry.
  `--timeout-secs <N>` sets a different hard limit.
- Review identity binds SHA-256 of the complete UTF-8 notebook, including the
  automatic block, and required dependency bytes, including uncommitted edits.
  Commit and section version stamps do not replace those hashes. Changed bytes
  make earlier acceptance stale; preserve historical reports and their input
  identities rather than rewriting them.


  Valid UTF-8 text remains text regardless of size; Markdown links are discovered
  recursively. Binary or invalid UTF-8 linked files are immutable `opaque_links`
  snapshots and hash locators, not read evidence. Every opaque path/hash needs a
  specific `opaque_sources` assessment; a required unread source prevents acceptance.
  Notebook and explicit dependencies require strict UTF-8 and LF or CRLF endings.

  The complete material is frozen before review. Storage (`--snapshot-bytes`,
  default 512 MiB; `--max-files`, default 256) is separate from each request's
  `--context-bytes` and configured backend `--context-tokens` window (default
  200,000 tokens, with instruction/output reserves). Default request bytes use a
  conservative token upper bound. A larger explicit byte packet requires captured
  backend token usage when that bound exceeds the window; missing capacity evidence,
  observed backend compaction or delivery failure supplies no acceptance.

  Larger materials use original UTF-8 intervals with adjacent original context,
  followed by a joint audit receiving the COMPLETE original notebook and text
  dependencies. All intervals and the joint audit must be complete and fresh;
  selected quotations or summaries cannot replace this original input. The default
  execution budget is 1200 seconds and 64 calls (`--timeout-secs`, `--max-batches`),
  with one attempt per call and no automatic retry. Shortfalls expose total frozen
  material, pending intervals and joint scope, the reason and a resumable command.
  An unfinished intake reports discovered material and incomplete dependency
  enumeration. `--resume <run-id>` creates a new run, revalidates original receipts
  and material identity, retains explicit dependencies and storage budgets, and
  never rewrites old evidence. If the full joint input does not fit the backend,
  raise an available backend's request budget or leave the review incomplete.
  Only tool mode `none` is accepted. Multiple batches are one semantic review;
  they do not establish independent confirmations or a cross-family quorum.
- The report needs full-text coverage of every section and readable dependency, plus assessment of opaque sources,
  with source-anchored reasons on derivation completeness, logic, symbols,
  definitions, assumptions and conventions. An excerpt-only or delta-only review
  cannot satisfy it. Give the reviewer the materials and question without an
  expected verdict or the writer's initial judgment.
- Default `notebook check` reports `structure` and `content_review` separately.
  Closeout requires structural success and an accepted current full-text review,
  identically in file and engine mode. `--result` narrows links alone;
  `--structure-only` establishes navigation alone. Missing, partial, failed,
  unavailable, invalid or stale review does not pass. If the reviewer cannot
  complete the reading, record the missing coverage and leave closeout incomplete.
- `status` and `current` read reports without launching a reviewer or preventing
  ordinary state or historical reads. Review evidence is a supporting semantic
  check using the existing verification contracts, not decisive computation
  validation or proof of scientific truth. Retain claim-specific checks and
  state single-reviewer limits on model, method and input independence.

Converged folds invoke the same unscoped `nullius notebook check --json` required
for final file closeout. `none` declarations and a missing launcher grant no
exception. `--result` is a scoped structural diagnostic; it cannot substitute for
the full default check, whose structural scope includes every current result.

### Notebook integrity gate (rendering safety)

- Gate: [check_notebook_integrity.py](scripts/gates/check_notebook_integrity.py)
- Symptom: `notebook integrity check failed`
- Scope: rendering and marker safety only; passing this preflight check does not establish scientific notebook content acceptance. Use the full-text closeout check above.
- Fix:
  - Marker blocks: keep exactly one of each marker block (capsule / audit slices / review excerpt).
  - Review excerpt: must not be empty template text.
  - Math policy:
    - Do not use `\(` `\)` `\[ ` `\]`; use `$...$` / `$$...$$`.
    - In `$$...$$` blocks, no line may start with `+`, `-`, or `=` (Markdown hazards).
    - Deterministic autofix helper: `python3 "${SKILL_DIR}/scripts/bin/fix_markdown_math_hygiene.py" --root research_contract.md --in-place`
  - Link policy:
    - Never put Markdown links (or `knowledge_base/*.md` paths) inside inline code spans.
- Rerun:
  - Preflight-only command.

### Markdown math hygiene gate (global scan)

- Gate: [check_markdown_math_hygiene.py](scripts/gates/check_markdown_math_hygiene.py)
- Symptom: `markdown math hygiene gate failed`
- Standalone/manual cleanup: use the `markdown-hygiene` skill when the task is only Markdown math/TOC hygiene and a full team cycle is unnecessary.
- Default scan targets (configurable in `research_team_config.json`):
  - `research_contract.md`
  - `research_preflight.md`
  - `research_plan.md`
  - `project_charter.md`
  - `project_index.md`
  - `knowledge_base/**/*.md`
- Fix:
  - Deterministic autofix helper (safe for common cases): `python3 "${SKILL_DIR}/scripts/bin/fix_markdown_math_hygiene.py" --root <path> --in-place`
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
  - Deterministic fix (recommended; targets key docs only): `python3 "${SKILL_DIR}/scripts/bin/fix_markdown_double_backslash_math.py" --notes research_contract.md --in-place`
  - Check-only helper (warn or fail): `bash "${SKILL_DIR}/scripts/bin/check_md_double_backslash.sh" --notes research_contract.md [--fail]`
  - Notes:
    - The fixer only rewrites inside Markdown math regions (`$...$`, `$$...$$`) and never touches fenced code blocks.
    - It does NOT rewrite real LaTeX line breaks (`\\`) or spacing commands (`\\[2pt]`).
- For generated TOC math escapes such as `$\\gamma\\_{\\rm lin}$`, use `markdown-hygiene` (`fix-toc`) before rerunning preflight.
- Rerun:
  - Preflight-only command.

### LaTeX macro hygiene gate (global scan)

- Gate: [check_markdown_latex_macro_hygiene.py](scripts/gates/check_markdown_latex_macro_hygiene.py)
- Symptom: `latex macro hygiene gate failed`
- Default scan targets (configurable in `research_team_config.json`):
  - `research_contract.md`
  - `research_preflight.md`
  - `research_plan.md`
  - `project_charter.md`
  - `project_index.md`
  - `knowledge_base/**/*.md`
- Fix:
  - Expand custom macros (e.g. `\Rc`, `\Mc`, `\Cc`, `\cK`) into explicit forms (e.g. `\mathcal{R}`).
  - Deterministic autofix helper: `python3 "${SKILL_DIR}/scripts/bin/fix_markdown_latex_macros.py" --root <path> --in-place`
  - If you have local LaTeX sources (e.g. `references/arxiv_src/`), you can deterministically discover safe 0-arg macro expansions and merge them into your JSON config (explicit opt-in): `python3 "${SKILL_DIR}/scripts/bin/discover_latex_zero_arg_macros.py" --root . --update-config`
- Rerun:
  - Preflight-only command.

### Markdown link hygiene gate (global scan)

- Gate: [check_markdown_link_hygiene.py](scripts/gates/check_markdown_link_hygiene.py)
- Symptom: `markdown link hygiene gate failed`
- Default scan targets (configurable in `research_team_config.json`):
  - `research_contract.md`
  - `research_preflight.md`
  - `research_plan.md`
  - `project_charter.md`
  - `project_index.md`
  - `knowledge_base/**/*.md`
- Fix:
  - Do not wrap links/citations/path pointers in inline code spans (backticks); use Markdown links so paths are clickable.
  - Deterministic autofix helper: `python3 "${SKILL_DIR}/scripts/bin/fix_markdown_link_hygiene.py" --root <path> --in-place`
- Rerun:
  - Preflight-only command.

### Pointer lint gate (code pointers)

- Gate: [check_pointer_lint.py](scripts/gates/check_pointer_lint.py)
- Symptom: `pointer lint failed` (and a generated report under `artifacts/runs/<tag>/research_team/<tag>_pointer_lint.md`)
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

### Member runner failure (Codex/Claude/Gemini CLI)

- Symptom: `[error] member runner failed (member-a=..., member-b=...)`
- Fix:
  - Check environment (the explicit CLI runners below — Codex, Claude, Gemini — are interchangeable options; none is a default or preferred backend, so choose whichever you have):
    - Host-native default: use the current agent's official subagent mechanism when available.
    - Explicit Codex CLI runner (one option): `bash "${SKILL_DIR}/scripts/bin/check_environment.sh" --require-codex`
    - Explicit Claude/Gemini split (another option): `bash "${SKILL_DIR}/scripts/bin/check_environment.sh" --require-claude --require-gemini`
  - Ensure `prompts/_system_member_a.txt` and `prompts/_system_member_b.txt` exist.
  - If you have project-local runners, confirm `scripts/run_codex.sh`, `scripts/run_claude.sh`, and `scripts/run_gemini.sh` are executable as needed.
  - **Refreshing the Claude runner copy.** `scripts/run_claude.sh` in a project is a copy of `assets/run_claude.sh` and runs the reviewer with `--safe-mode` (login kept; your user/project `CLAUDE.md`, `AGENTS.md` and auto memory are not loaded, measured with marker files; the skills and agents of user-installed plugins are absent from the stream's init event; hooks and the git status snapshot are excluded according to the CLI documentation, and managed-policy settings and hooks still apply; see `claude-cli-runner` SKILL.md, **Context sources**) and `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`. Projects scaffolded earlier hold an older copy without the `research-team-claude-runner: context-excluded` marker line (or without `--safe-mode` on every `claude --print` line); `run_team_cycle.sh` does not use such a copy but substitutes `claude-cli-runner` for the run and prints a `[warn]` line. Migration, once per existing project: `cp "${SKILL_DIR}/assets/run_claude.sh" scripts/run_claude.sh && chmod +x scripts/run_claude.sh`. For a customized copy instead: put `--safe-mode` on every `claude --print` line (the asset has two: with and without `--model`; the resolver requires the flag as an option on each, not in a trailing comment), export `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`, and add the comment line `research-team-claude-runner: context-excluded`; without the marker the copy is still replaced. `prune_optional_scaffold.py` treats a copy identical to the asset as default, so a refreshed copy can still be pruned.
  - If Gemini CLI returns a blank response (common after CLI upgrades / auth drift), `run_team_cycle.sh` fails closed. Choose a provider explicitly before rerunning:
    - CLI: `run_team_cycle.sh --member-b-runner-kind claude`
    - Config: set `member_b.runner_kind=claude` (optional `member_b.claude_system_prompt`) in `research_team_config.json`.
  - If you want Gemini and it returns a blank response:
    - Sanity test headless mode: `gemini --output-format json --prompt "Hello" | python3 -c 'import json,sys; print(json.load(sys.stdin).get(\"response\",\"\"))'`
    - If the printed response is empty, re-check Gemini CLI authentication/config (see `https://geminicli.com/docs/get-started/authentication/`).
    - Note: a line like `Hook registry initialized...` is a harmless stderr preamble; the runner ignores it.
  - Claude attempt-level diagnostics (new):
    - `run_team_cycle.sh` now writes per-attempt logs under:
      - `artifacts/runs/<tag>/research_team/logs/`
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
    - `artifacts/runs/<tag>/research_team/<tag>_member_a.md`
    - `artifacts/runs/<tag>/research_team/<tag>_member_b.md`
  - Write an adjudication note:
    - `mkdir -p artifacts/runs/<next_tag>/research_team`
    - `python3 "${SKILL_DIR}/scripts/bin/build_adjudication_response.py" --tag <next_tag> --member-a artifacts/runs/<tag>/research_team/<tag>_member_a.md --member-b artifacts/runs/<tag>/research_team/<tag>_member_b.md --out artifacts/runs/<next_tag>/research_team/<next_tag>_adjudication.md`
  - Grade the findings per the severity contract in SKILL.md (blocking vs
    non-blocking); give every non-blocking finding an explicit disposition in
    the adjudication (fix now / attach to a named acceptance point / discard
    with reason).
  - Batch ALL blocking fixes into one stabilized candidate; apply them to the
    notebook/code/artifacts, run the full local test surface once, and only
    then re-enter the reviewed cycle with a fresh tag.
- Rerun (choose the narrowest sufficient form):
  - **Delta confirmation round (default after a fix batch)**: when the prior
    round's blocking findings are enumerable and the fixes are localized,
    rebuild the packet as the reviewed baseline's identity plus the exact
    diff plus a findings-to-resolutions table, and run it as a normal cycle
    under the next tag with that delta packet as input — **both members
    receive it**: the member(s) who raised the findings verify the
    resolutions, and the other member re-confirms on the delta, so the
    convergence gate evaluates two fresh verdicts bound to the current
    candidate. A verdict issued against the baseline hashes never carries
    over to a changed candidate. Escalate to a full-packet round
    when formulas/assumptions, the data model or a global invariant, or an
    origin-traceability root changed — or when a reviewer asks for the full
    artifact.
  - **Full cycle** with `--auto-tag` (do not reuse tags; trajectory is an
    upsert index): first round of a milestone candidate, changed baseline, or
    any escalation trigger above.
  - The delta confirmation above applies to the selected member-cycle candidate;
    it cannot satisfy `notebook.content_review`. Any edit to the notebook or a
    required dependency requires a new review of the entire current notebook,
    including its automatic block, before scientific notebook closeout.
  - Either way the confirmation round is mandatory after every fix batch —
    convergence is declared by the reviewers on the current artifact, never
    by the leader after applying fixes.

## Deterministic validation

```bash
bash scripts/validation/run_full_contract_validation.sh
```

## Migrating an existing project to the current member prompts

Scaffolding skips files that already exist, so a project scaffolded before the
severity-graded verdict rules keeps its old copies of
`prompts/_system_member_a.txt` / `prompts/_system_member_b.txt` — its reviewers
will keep treating hardening suggestions as blocking until the prompts are
refreshed. Migration is a backup-then-recopy of the two managed prompt files
(they are verbatim copies of the skill assets; project-authored edits, if any,
must be re-applied on top):

```bash
cd /path/to/project
BACKUP_DIR=".nullius/backups/prompts-$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"
cp prompts/_system_member_a.txt prompts/_system_member_b.txt "$BACKUP_DIR/"
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
cp "${SKILL_DIR}/assets/system_member_a.txt" prompts/_system_member_a.txt
cp "${SKILL_DIR}/assets/system_member_b.txt" prompts/_system_member_b.txt
diff -u "$BACKUP_DIR/_system_member_a.txt" prompts/_system_member_a.txt | head -40
```

Review the diff for project-authored customizations before the next cycle;
re-apply any on top of the refreshed prompts. The same recopy-with-backup
applies to any other copied asset the project wants to bring forward —
scaffolding never rewrites existing project files on its own. Updated scientific
notebook closeout guidance also requires an explicit merge: render the current
scaffold in an anonymous temporary external root, then manually merge the
relevant instructions into the existing user-owned project files. Do not assume
refreshing an installed skill has rewritten those project files.
