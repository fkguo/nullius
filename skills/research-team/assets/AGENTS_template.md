# AGENTS.md (Template)

This file anchors the research-team workflow for this project. Keep it updated.
Default usage is agent-first: a tool-using LLM agent runs the scripts and writes project files; humans provide goals and review outputs. Commands are kept explicit for auditability and can be run manually as a fallback.

Execution hygiene (recommended):
- At the start of each agent run, publish a short execution plan (3–7 steps) and keep it updated as steps complete. If your agent environment supports a plan tool, use it; otherwise keep a plain Markdown plan section.

## Resume / restart checklist (anti-amnesia)

Whenever you resume work (new milestone, context switch, or after a manual interruption), do this first:

1) Read `project_index.md` + `project_charter.md` + this `AGENTS.md` (do not rely on memory).
2) Run preflight-only (agent executes) to catch missing gates before any LLM calls:

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes research_contract.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag \
  --preflight-only
```

3) If preflight fails, fix docs/artifacts first; do not start the next milestone.

## Required workflow

- Keep `research_contract.md` Capsule current for each milestone/tag.
- Keep `project_charter.md` current (goal hierarchy + anti-goals + declared profile).
- Capsule boundary rule: do NOT put step-by-step derivations in the Capsule. Put derivations in the stable body sections and keep the Capsule as a reproducibility contract with pointers.
- Populate `knowledge_base/` (literature, methodology_traces, priors) before any team cycle.
- Store reproducible artifacts under `artifacts/`.
- Maintain a References section in `research_contract.md` and keep it updated; include links when available.
- Link hygiene (hard requirement): any reference meant to be followed MUST be clickable Markdown (no backticks).
  - Knowledge-base docs: use Markdown links with human-readable link text (prefer `RefKey — Authors — Title` for literature notes), e.g. [notation and normalization](knowledge_base/priors/notation_and_normalization.md) (not inline code).
  - In-text citations: use links, e.g. [@recid-1234567](#ref-recid-1234567) (not inline code).
- Maintain a literature coverage matrix in `research_preflight.md` and update it as the project evolves (no blind spots across theory/method/numerics/baselines/data/closest prior work).
- Fill and maintain `research_preflight.md` `## Problem Framing Snapshot` (Problem Interpretation + P/D separation + sequential review checklist). This is a hard gate in theory_numerics/mixed/methodology_dev/toolkit_extraction profiles.
- If coverage is thin in any dimension, the team leader expands literature and records it in `knowledge_base/` and `research_preflight.md`. If skipped, add a one-line rationale in `research_preflight.md`.
- Before complex numerics or theory derivations, list candidate methods/algorithms and record the chosen approach (with rationale) in `research_preflight.md`.
- For complex computations, prepare audit slices (proxy headline numbers + key algorithm checks) in the team packet.
- Headline numbers must be nontrivial (sensitive to core logic, not trivial algebra). Use audit proxies when full reproduction is impractical.
- For each milestone/tag, the executing agent chooses `Min headline numbers: N` (default 3; use 0 only if no meaningful numeric headline exists for that round).
- Each `- Hn:` headline line MUST include an explicit tier tag: `[T1]`, `[T2]`, or `[T3]` (Tier-T2/T3 should be diagnostics/proxies, not just final outputs).
- Default: require at least one Tier-T2/T3 headline per milestone. Set `Min nontrivial headlines: 0` only if truly N/A (and compensate via audit slices / logic checks).
- Precedence: the capsule line `Min nontrivial headlines: N` is authoritative for that milestone; `research_team_config.json` `capsule.min_nontrivial_headlines` provides the project-level default.
- If lowering `capsule.min_headline_numbers` or using a per-capsule `Min headline numbers` override, record the rationale and compensating evidence in `research_preflight.md`.
- Allowed network scope (for project leader only): prefer stable anchors (INSPIRE-HEP, arXiv, DOI, GitHub). Official software/docs/registries (e.g. docs.scipy.org, docs.julialang.org, numpy.org, pypi.org, zenodo.org) are allowed for implementation details. Discovery via general scholarly search is OK, but you must log query→selection in `knowledge_base/methodology_traces/` and convert final citations to stable links; if a needed domain is blocked by the References gate, add it to `research_team_config.json: references.allowed_external_hosts_extra`.
- For complex numerical problems, do not brute force; first check `knowledge_base/` for robust implementations.
- Numerical integration policy (not enforced, but expected for serious results): do not default to low-order trapezoid/trapz on a coarse grid. Require either (i) a convergence study (grid refinement) or (ii) a cross-check against a higher-order / error-controlled method (e.g., Gauss–Legendre fixed quad, adaptive Gauss–Kronrod), and record the choice in a methodology trace.
- Numerics language preference (not enforced): if Julia is available, prefer Julia for new/heavy numerics (loops/sweeps/stability audits). Python is acceptable for small-scale calculations or when leveraging SciPy, but record the rationale in research_preflight/methodology trace and avoid pure-Python slow loops.
- If reviewers flag numerical instability or unclear algorithms, the team leader performs an algorithm/code search within the allowed sources and logs results in `knowledge_base/methodology_traces/` before coding.
- For arXiv papers, LaTeX source download is allowed (store under `references/arxiv_src/`), but avoid writing brittle LaTeX parsers; do LLM-assisted extraction into KB notes with explicit source file pointers and normalization notes.
- Definition of Done (DoD) must be evidence-backed: acceptance criteria should reference files/commands/thresholds, not “looks good”.
- If `research_team_config.json` sets `profile: toolkit_extraction`, each milestone in `research_plan.md` MUST include a filled `Toolkit delta:` block (API spec + code snippet index + KB evidence links).

## Prework (must complete before team cycle)

- Literature: add at least 1 note under `knowledge_base/literature/`.
- Literature coverage matrix: fill dimensions/status/gaps in `research_preflight.md` and update during the project.
- Methodology traces: add at least 1 trace under `knowledge_base/methodology_traces/`.
- Priors: update `knowledge_base/priors/` (and cite any new conventions).
- Update Capsule I) in `research_contract.md` with all paths.
- Method selection checkpoint: record candidate methods and the chosen approach in `research_preflight.md`.
- Template: `knowledge_base/methodology_traces/_template.md`.

## Team cycle trigger (preflight + full)

Preflight only (no external LLM calls):

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes research_contract.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag \
  --preflight-only
```

Full team cycle (Claude + Gemini):

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes research_contract.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag
```

## Optional helper

- If present, you can use `scripts/run_full_cycle.sh` to run preflight + team cycle.
- Autopilot: `scripts/run_autopilot.sh` will auto-fill the plan (if needed) and iterate tasks.
- Stop autopilot by creating `.stop` in the project root.
- If autopilot stops with "max retries or no progress reached", rerun with `--reset-state` (or delete `team/autopilot_state.json`).
- Kickoff prompt (recommended): `PROJECT_START_PROMPT.md` is a user-reviewable start contract. If autopilot kickoff_prompt.require_approval=true, you must set `Status: APPROVED` before auto-run proceeds.
- Auto-fill reads `project_brief.md` and `research_preflight.md`.
- Autopilot expects `research_plan.md` to include a Task Board with `- [ ] Tn:` tasks.
- If `scripts/execute_task.sh` exists, autopilot will call it with `<task_id> <task_text>` before each team cycle.
- After each team cycle, update `research_plan.md` (Task Board + Progress Log). This is automatic when plan_tracking is enabled.
- Runner scripts can be vendored to `scripts/run_claude.sh` and `scripts/run_gemini.sh` for self-contained sharing.
- Task Board tasks should include `(auto)` or `(manual)`; autopilot pauses on manual tasks by default (`automation.pause_on_manual=true`).
- Packet completeness gate (if enabled) fails when Definition-hardened quantities or Evidence bundle contain `(fill...)` / `(missing...)` placeholders.
- Notebook integrity gate (if enabled) fails when research_contract.md has duplicate marker blocks (REVIEW_EXCERPT/AUDIT_SLICES/Capsule) or violates math formatting rules.
- Evidence bundle auto-fills from Capsule outputs; still verify code pointers and artifacts in the packet.
- Sidecar reviews (optional): enable `sidecar_review.enabled=true` (single) or populate `sidecar_reviews` (list) to run additional reviewers in parallel (non-blocking).
- Claim DAG auto-enable: after the first converged cycle, if `knowledge_graph/` has at least 1 claim + 1 evidence, gates auto-enable.
- If you want a dry run, set `claim_gate_auto_enable.dry_run=true` in `research_team_config.json`.
- If `team/runs/<tag>/<tag>_adjudication.md` exists, it is auto-included in the next team packet (fallback: `team/<tag>_adjudication.md`).
- Claim DAG visualization: after convergence, render `knowledge_graph/claim_graph.dot` and `claim_graph.png` if Graphviz is installed.
- Toggle via `claim_graph_render.enabled` and set `claim_graph_render.format` to `png/svg/both/dot`.
- Autopilot is a coordinator + reviewer; without `execute_task.sh` it cannot implement code changes.
- Final integration audit (required before declaring “done”): run one dedicated cycle (e.g. tag `FINAL-r1`) focused on global self-consistency.
  - Ensure all key derivations live in the notebook body (no skipped steps), not hidden in Capsule/appendices.
  - Audit normalization/notation against the cited literature; explicitly record any fixes for typos/mismatches.
  - Verify References/KB/claim graph are complete and internally consistent (no missing citations/links).

## Markdown math formatting (required)

- Use `$...$` and `$$...$$` for math. Do not use `\\( \\)` or `\\[ \\]`.
- Do not start a new line inside math with `+`, `-`, or `=`; keep them on the previous line.
- In Markdown tables, do NOT use literal `|` inside `$...$` (it often breaks table parsing). Use `\\lvert ... \\rvert` (or `\\lVert ... \\rVert`, or `\\mid` for conditional bars) instead.
- Avoid `\\slashed{...}` in Markdown math (renderer compatibility varies). Prefer a portable fallback like `\\not\\!` (warn-only by default).
- Avoid accidental double-backslash LaTeX escapes (common TOC/LLM artifact), e.g. `\\Delta`, `\\gamma\\_{\\rm lin}`. If they appear:
  - Find (deterministic targets): `bash ~/.codex/skills/research-team/scripts/bin/check_md_double_backslash.sh --notes research_contract.md [--fail]`
  - Fix (math regions only): `python3 ~/.codex/skills/research-team/scripts/bin/fix_markdown_double_backslash_math.py --notes research_contract.md --in-place`

## References (required)

- `research_contract.md` must include a `## References` section near the end.
- Each entry must include a link if one exists (prefer DOI or arXiv).
- Update references whenever you add external sources or equations.
- In the main text, cite as [@Key](#ref-Key) so it jumps to the matching reference entry (do not wrap in backticks).
- Each reference entry must include a link to the local knowledge-base note.
- In each knowledge-base note, include `RefKey: Key` near the top to keep keys consistent.
- If no external link exists, add `Link: none` in the reference entry.
