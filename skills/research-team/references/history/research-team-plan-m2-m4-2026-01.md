# research-team M2/M3/M4 detailed plan (historical archive)

Status: historical draft snapshot from 2026-01-29. Preserved for context only; it is not current SSOT.

Last updated: 2026-01-29

This document expands the January 2026 roadmap snapshot into an execution plan with:
- parallelizable work packages,
- concrete artifacts,
- acceptance tests,
- and a convergence protocol (Claude+Gemini).

Non‑negotiables (repo policy):
- Keep `assets/` model-agnostic (no hard-coded vendor model names).
- Prefer realistic research workflows (derivations + numerics + literature/code toolkit extraction + creativity), but auditable.
- Maintain skepticism: papers/books can be wrong; require discriminating checks.
- Deterministic gates stay deterministic; new enforcement is warn-only unless it prevents reproducibility/corruption.

## Progress board (single source for status)

M2:
- [ ] M2.0 Spec + schema (SSOT)
- [ ] M2.1 Resolver + cache (tooling; `--offline` fixtures mode)
- [ ] M2.2 Stage-aware references gate (exploration warn+debt; development/publication enforce)
- [ ] M2.3 Discovery trace gate (non-blocking in exploration)
- [ ] M2.4 Mini-project regression (ModelDependence-derived + synthetic fallback)

M3:
- [ ] M3.0 Correspondence manifest spec
- [ ] M3.1 Validator gate (stage-aware)
- [ ] M3.2 Toolkit promotion (project-local)

M4:
- [ ] M4.0 External B-check protocol (structured contract)
- [ ] M4.1 Debt graduation workflow
- [ ] M4.2 Lineage/audit tool

## Convergence protocol (mandatory)

For each milestone (M2/M3/M4):
1) Draft changes + acceptance tests.
2) Run two independent reviews (clean-room, no tool-use):
   - Reviewer A: Claude (local alias `claude-opus-4-5-20251101`)
   - Reviewer B: Gemini (local alias `gemini-3-pro-preview`)
3) Convergence gate:
   - If either reviewer says NOT_READY / mismatch / needs revision → revise and rerun both.
   - Only “READY + READY” allows the milestone to be marked done.
4) Record a short adjudication note (what changed, why) and update this plan’s checklist.

Review inputs and time bounds:
- Input to reviewers: the plan doc section(s) being advanced + the relevant diff (not the whole repo history).
- Timebox per review run: 15 minutes; if runner fails/hangs, treat as NOT_READY and rerun with a narrower prompt.
- If a reviewer is consistently unavailable (CLI errors), we either (a) SCOPE-KILL the specific change, or (b) proceed only for warn-only changes and explicitly mark the milestone as “provisional” (requires user sign-off).
Runner specification (so this is reproducible):
- Claude reviewer runner:
  - `bash $CODEX_HOME/skills/claude-cli-runner/scripts/run_claude.sh --model claude-opus-4-5-20251101 --system-prompt-file <SYS> --prompt-file <PROMPT> --out <OUT>`
- Gemini reviewer runner:
  - `bash assets/run_gemini.sh --model gemini-3-pro-preview --prompt-file <PROMPT_WITH_SYSTEM> --out <OUT>`
- Rationale: `assets/run_gemini.sh` strips known CLI preambles and yields prompt-only text for stable review logs.

Failure escalation (avoid infinite loops):
- “Consistently unavailable” = 3 consecutive runner failures OR 5 failures within one milestone.
- Max convergence iterations per milestone: 5 revision rounds.
- If not converged by then: write a short “SCOPE-KILL / DEFER” note with rationale and stop.

Review log (fill as we go):
- M2: pending
- M3: pending
- M4: pending

## Mini-project regression (included in M2)

Meaning:
- A **fixed, small, end-to-end** project used as an **integration regression** target.
- It exercises the *real workflow* (capsule → packet → gates → refs/trace) more faithfully than isolated smoke tests.

Source candidate (local, realism-first):
- `~/Work/Femtoscopy/ModelDependence`

Policy constraints:
- Do **not** commit private project content into the skill repo.
- Use snapshot copies under git-ignored paths (e.g., `skilldev/regression/...`) for regression runs.

Planned approach:
- Use the existing realism regression harness:
  - Register: `scripts/dev/register_real_project_regression.sh`
  - Run (safe snapshot-by-default): `scripts/dev/run_real_project_regression.sh`
- Add a “mini-project” wrapper (M2 task) that:
  - auto-registers `ModelDependence` when present,
  - runs a snapshot regression in `development` stage,
  - runs a second snapshot regression in `exploration` stage to ensure warn+debt behavior remains non-blocking,
  - and summarizes expected invariants (refs trace/debt).
  - Safety rule: auto-registration writes ONLY to git-ignored local registry under `skilldev/` and MUST NOT touch tracked files (no absolute paths in commits).
    - Source path should be provided via env var `MINIPROJ_SOURCE` or runtime detection only.

Acceptance (for M2):
- `bash scripts/dev/run_mini_project_regression.sh` (new) succeeds on machines that have the source project.
- `bash scripts/dev/run_mini_project_regression.sh --synthetic` (new fallback) succeeds everywhere by generating a deterministic mini-project (no network).

Synthetic mini-project definition (must be explicit and testable):
- Project root created under a temp dir with **at least**:
  - `research_contract.md` with a complete Reproducibility Capsule (minimal), and a `## References (required)` section.
  - `project_charter.md`, `project_index.md`, `research_preflight.md`, `research_plan.md`, `research_team_config.json`.
  - `knowledge_base/methodology_traces/literature_queries.md` with at least 1 discovery query row.
  - `knowledge_base/literature/<note>.md` KB note linked from References.
- It must include:
  - 1 stable anchor reference (DOI or arXiv or INSPIRE) with KB note link.
  - 1 intentionally “unstable/discovery” URL (non-allowlisted) to exercise:
    - exploration: warn + debt recording + trace requirement
    - development: fail-fast unless upgraded to stable anchor or audited exception is present
    - Concrete required discovery URL string (no fetch required): `https://example.com/discovery_tmp`
      - It must appear under `research_contract.md -> ## References (required)` as a link in a reference entry.
- It must include at least one tiny runnable command (Python or shell) that produces one output file referenced in the capsule outputs (to keep the workflow realistic without heavy compute).
  - Command must be deterministic and dependency-light (stdlib only).
  - Regression asserts BOTH:
    - exit code == 0
    - output file exists AND contains expected content (concrete contract below)
- Generator determinism:
  - No network access.
  - No randomness unless seeded and recorded (default: no randomness).
  - Timestamps are allowed but should not be used as correctness assertions in tests.

Concrete synthetic command/output contract (for deterministic assertions):
- The generator must create:
  - `scripts/mini_compute.py` (stdlib-only)
  - `artifacts/mini_output.json`
- The capsule must list the command and output:
  - Command: `python3 scripts/mini_compute.py --out artifacts/mini_output.json`
  - Output: `artifacts/mini_output.json`
- The produced JSON must equal:
  - `{\"ok\": true, \"value\": 1, \"units\": \"arb\"}`

## M2 — Audited discovery + references pipeline (no hard cutoffs in exploration)

Goal:
- Make “general search → trace → stable anchor → verified metadata” a first-class loop.
- In `exploration`: **warn + record debt**, do not block research.
- In `development/publication`: **enforce** stable anchors and metadata consistency.

Fail-fast definition (used throughout):
- A “fail-fast” gate returns a non-zero exit code and **stops the cycle before any LLM calls**.
- For `run_team_cycle.sh`, this means exiting before launching Member A/B runners.

Stage semantics SSOT location (must be unambiguous):
- Runtime SSOT: `research_team_config.json -> project_stage` as consumed by deterministic gates and `run_team_cycle.sh`.
- Documentation: `RUNBOOK.md` describes behavior, but must match runtime semantics; if it disagrees, treat it as a docs bug.
- Stage transition rule:
  - Only the human/team leader changes `research_team_config.json -> project_stage`.
  - Transition `exploration -> development/publication` requires closing all exploration debt items; otherwise the exploration-debt gate fails-fast in non-exploration stages.
  - Enforced today by: `scripts/gates/check_exploration_debt.py` (invoked by `run_team_cycle.sh` early in preflight after stage detection).
    - Expected failure UX: `run_team_cycle.sh` prints a fail-fast message and exits non-zero (before any LLM calls) when debt is still open.
- M2.0 includes updating `RUNBOOK.md` to reflect any new stage-aware behaviors, and adding a deterministic docs smoke check:
  - Assert `RUNBOOK.md` contains the exact phrase: `Runtime SSOT: research_team_config.json -> project_stage`.

### M2.0 Spec + schema (SSOT)

Deliverables:
- A small spec section (in `PLAN_M2_M4.md` + summarized in `ROADMAP.md`) defining:
  - “Discovery trace” minimum fields: query, filters, selection rationale, chosen stable anchors.
  - “Reference record” minimum fields: stable anchor, KB note link, retrieved date, optional verified metadata.
  - “Audited exception” rules: allowlist extension + required rationale.

Acceptance:
- New smoke test validates schema examples are parseable and stable.

Checklist:
- [ ] Define trace schema (JSONL row contract + Markdown template)
- [ ] Define reference metadata cache schema (stable keys + provenance)
- [ ] Define stage semantics (exploration warn/debt vs development block vs publication strict)

Parallelizable:
- Member A: propose schema + severity rules.
- Member B: propose minimal templates and edge cases from real projects.

### M2.1 Resolver + cache (tooling)

Deliverables:
- Extend `scripts/bin/literature_fetch.py` (or add a focused helper) to:
  - resolve DOI/arXiv/INSPIRE/GitHub/Zenodo/SWH → normalized metadata,
  - write/update a local cache (project-level, not skill-level),
  - generate a KB note skeleton with stable anchors and provenance.
- A deterministic **offline** mode (`--offline`) that refuses network access and runs only from fixtures (for smoke tests).

Acceptance:
- Smoke tests for resolver using fixtures (no network), including:
  - DOI metadata normalization,
  - arXiv record normalization,
  - “allow-stub” behavior (network failure → auditable stub).

Checklist:
- [ ] Implement cache read/write + versioning
- [ ] Add fixture-based tests for key resolvers
- [ ] Add CLI ergonomics (“write note”, “write reference entry”, “upgrade anchors”)
- [ ] Define allow-stub schema + stage behavior (below)

Allow-stub behavior (must be specified):
- Stubs are allowed ONLY for discovery-stage progress and must be clearly marked in cache/notes:
  - Required stub fields (minimum): `status="stub"`, `created_utc`, `source_kind`, `source_id_or_query`, `why_stub`, `next_action`.
  - Resolved records must have `status="resolved"` and include the stable anchor.
- Stub detection mechanism (deterministic; specify formats):
  - Project-level cache location (proposed for M2.1): `references/cache/reference_cache.json` (single JSON dict keyed by `RefKey`).
  - KB note header format: key/value lines until the first blank line (as in existing KB notes, e.g. `RefKey: ...`, `DOI: ...`).
    - A stub KB note MUST include `Status: stub` in this header block.
    - Parsing rules (for determinism):
      - Delimiter: colon (`:`). Recommended formatting is `Key: Value` (colon + single space).
      - Key match is case-insensitive (e.g., `status`, `Status`, `STATUS`).
      - Leading/trailing whitespace is trimmed.
  - Gates should prefer the cache; KB notes are used as the human-facing record.
- `next_action` semantics:
  - Informational field (does not affect gating); recommended values: `resolve_via_crossref`, `resolve_via_inspire`, `resolve_via_arxiv`, `upgrade_anchor`, `manual_metadata`, `allowlist_exception`.
  - Gates detect stubs via `status=="stub"` in cache/KB note headers, not by interpreting `next_action`.
- Stage enforcement:
  - `exploration`: stubs allowed, but create exploration debt item(s) referencing the stub(s).
  - `development/publication`: fail-fast if any stub is referenced by `research_contract.md -> References`.

Parallelizable:
- Member A: cache schema + normalization rules.
- Member B: fixtures + tricky metadata cases (journals, versions, datasets/software).

### M2.2 Stage-aware references gate (enforcement)

Deliverables:
- Update references gate to enforce per stage:
  - exploration: warn + record debt item(s) for unresolved/unanchored refs
  - development: fail-fast on unresolved/unanchored refs
  - publication: fail-fast + verify metadata consistency (cache ↔ KB note ↔ reference entry)
- Add an “anchor upgrader” helper path (existing `upgrade_reference_anchors.py` can be extended).

Acceptance:
- Smoke tests that run the gate in each stage on the same inputs and assert severity differences.

Checklist:
- [ ] Gate updates (stage severity)
- [ ] Debt recording integration (exploration)
- [ ] Metadata consistency checks (publication)
- [ ] Allowlist extension path + trace requirement

Parallelizable:
- Member A: gate semantics + debt integration.
- Member B: publication consistency rules + failure-mode examples.

### M2.3 Discovery trace gate (policy enforcement without blocking exploration)

Deliverables:
- A lightweight deterministic gate that checks:
  - if non-stable discovery URLs appear, a trace entry exists (and is linked),
  - final citations use stable anchors or audited exceptions.

Acceptance:
- Smoke tests covering:
  - “discovery used but no trace” → warn/debt in exploration, fail in development.

Checklist:
- [ ] Implement trace detection heuristics
- [ ] Implement linkage checks (PREWORK ↔ trace ↔ KB note ↔ References)

Trace detection heuristics (explicit baseline):
- “Stable anchors” (allowed as final citations without requiring a discovery trace):
  - DOI: `https://doi.org/...`
  - arXiv: `https://arxiv.org/abs/...`
  - INSPIRE: `https://inspirehep.net/literature/...`
  - GitHub repo: `https://github.com/<org>/<repo>` (specific release/tag preferred)
  - Zenodo: `https://zenodo.org/record/...` or `https://doi.org/10.5281/zenodo....`
  - Software Heritage: `https://archive.softwareheritage.org/...`
- Everything else is treated as “discovery URL” and requires:
  - a trace entry (query + selection rationale) AND
  - either an anchor upgrade path OR an audited exception (with allowlist + rationale).

### M2.4 Mini-project regression (ModelDependence-derived + synthetic fallback)

Deliverables:
- `scripts/dev/run_mini_project_regression.sh` (new)
  - `--source ~/Work/Femtoscopy/ModelDependence` (default)
  - `--synthetic` (generate a deterministic mini-project when source missing)
  - runs two snapshot regressions (exploration + development)
  - validates expected invariants (e.g., debt file created in exploration when appropriate; no debt required in development when resolved)

Acceptance:
- Local maintainer path works (ModelDependence present).
- Everyone else can run `--synthetic` deterministically.

Checklist:
- [ ] Implement synthetic mini-project generator (small but realistic)
- [ ] Integrate into `scripts/dev/run_all_smoke_tests.sh` (or keep as separate “regression suite”)

Invariants to assert (minimal but meaningful):
- Snapshot regression (`development`) passes preflight-only.
- Snapshot regression (`exploration`) does not block on discovery/ref issues, but records debt as expected.
- Synthetic regression must exercise BOTH “broken” and “resolved” paths deterministically:
  - Phase A (broken):
    - exploration: debt file exists and contains an item referencing the refs/trace gate
    - development: expected fail-fast on unresolved discovery/stub (this expected failure counts as PASS for the regression)
  - Phase B (resolved):
    - apply a deterministic local patch inside the temp project (upgrade discovery URL → stable anchor OR add audited exception; mark debt closed)
    - development: passes preflight-only with no open debt
- Debt idempotency:
  - If unresolved, re-running in exploration appends or preserves debt entries (no silent disappearance).
  - After resolving (marking checklist items), development run passes with no open debt.

## M3 — Theory ↔ numerics correspondence + toolkit extraction

Goal:
- Make “equation/definition ↔ code ↔ test ↔ output” mappings explicit and machine-checkable.
- Promote mature method traces into reusable toolkit modules.

### M3.0 Correspondence manifest spec

Deliverables:
- A project-level `correspondence_manifest.*` spec (JSON/YAML) mapping:
  - eq/def ids → code pointers → tests → outputs
  - conventions/units mappings (compatible with sweep/branch semantics)

Acceptance:
- Deterministic validator script parses and validates manifest structure.

Checklist:
- [ ] Define manifest schema + examples
- [ ] Choose id strategy (equation tags / stable anchors in Markdown)

### M3.1 Validator gate

Deliverables:
- Gate validates:
  - referenced equation/definition anchors exist in notebook,
  - code pointers resolve under declared environment,
  - listed tests are at least **locatable and runnable** (static check; deterministic):
    - test path exists
    - test command parses via `shlex.split` without error
    - command contains no shell operators (reject tokens like `|`, `>`, `<`, `&&`, `;`)
    - ignore leading env-var assignments (`FOO=bar`) and then:
      - first executable token is allowlisted (`python3`, `python`, `julia`, `bash`, `sh`, `make`, `pytest`) or begins with `./`
  - outputs listed in the capsule are present in the correspondence manifest (static mapping exists: `output_path -> generator`), without attempting to prove runtime production.

Stage-aware behavior (explicit):
- `exploration`: validator emits warnings + records exploration debt for missing anchors/pointers/tests/outputs, but does not block.
- `development/publication`: validator is fail-fast on missing anchors/pointers/tests/outputs.

Determinism note:
- The validator gate should not run heavyweight tests by default.
- “Test execution” is validated in two places instead:
  - smoke/mini-project (tiny deterministic tests actually run)
  - optional per-project setting (future): `correspondence.require_test_exec=true`

Acceptance:
- New smoke test uses a generated mini-project with 2–3 mapped equations.

Checklist:
- [ ] Implement anchor extraction + cross-check
- [ ] Implement code pointer + test existence checks
- [ ] Integrate with branch/multi-root semantics when applicable

### M3.2 Toolkit promotion

Deliverables:
- Script that can “promote” a marked methodology trace into a toolkit module:
  - extracts code blocks + docstring + minimal test skeleton,
  - writes to project `toolkit/` (project-local), not the skill.
  - MUST NOT write into the skill repo’s `assets/` or `scripts/` as part of promotion (avoid leaking project specifics).

Acceptance:
- Mini-project demonstrates 1 promoted helper + a test.

## M4 — External review protocol + debt graduation + lineage audit

Goal:
- Strengthen reliability and “why we believe this” traceability without blocking exploration.

### M4.0 External B-check protocol (structured)

Deliverables:
- A structured external review prompt + output contract:
  - issues list with severity, reproduction steps, and file/section anchors
  - READY/NOT_READY verdict
- Default behavior:
  - exploration: non-blocking (but logged)
  - development/publication: blocking on “Blockers”

Acceptance:
- Smoke test validates output contract and parsing.

### M4.1 Debt graduation workflow

Deliverables:
- A deterministic workflow to convert exploration debt items into:
  - actionable plan items with DoD,
  - and status tracking (open/closed with timestamps).

Acceptance:
- Demo run where debt is generated in exploration and “graduated” into plan tasks.

### M4.2 Lineage/audit tool

Deliverables:
- Deterministic analyzer that builds a lineage graph:
  - query/trace → references → claim → derivation → code → outputs
  - flags orphans and missing links.
- Output formats (auditable):
  - Machine-readable JSON (`lineage_report.json`) with a stable schema.
  - Optional DOT/Mermaid render for humans (non-gated).

Acceptance:
- Mini-project (synthetic) runs lineage audit with 0 orphans (or only allowlisted exceptions).

## Execution speedups (parallel + sub-agents)

Parallelization rules:
- Keep the outputs auditable; do not parallelize tasks that risk cross-contamination (e.g., two reviewers writing to the same file).
- Prefer parallelizing:
  - schema/spec writing vs fixtures/test harness writing
  - mini-project wrapper vs resolver internals
  - docs updates vs implementation

Concrete safety rules for parallel work:
- Use separate git branches (or git worktrees) per work package: `m2-schema`, `m2-fixtures`, `m2-gates`, `m2-miniproj`.
- One “integration owner” (leader) merges work packages in a controlled order and resolves conflicts.
- Do not run snapshot regressions concurrently into the same `--runs-dir`:
  - Either rely on the harness’s unique run IDs, or set per-run `--runs-dir` when parallelizing.
- If two packages must touch the same file, serialize that portion (small PRs, merge quickly).

Sub-agent usage (recommended):
- Use Claude+Gemini as “independent reviewers” for:
  - spec clarity (do they interpret the rules the same way?)
  - failure-mode enumeration (what will break in real projects?)
  - acceptance test completeness (is the DoD testable?)
