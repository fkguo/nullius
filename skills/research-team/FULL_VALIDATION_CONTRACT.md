# FULL_VALIDATION_CONTRACT — `research-team` skill

Status: APPROVED (A/B/C reviewed)
Last updated: 2026-01-19

This document defines what “full validation” means for the `research-team` skill: scope, acceptance criteria, test matrix, and evidence requirements.

## 0) Scope and goals

Full validation is about **workflow correctness and reproducibility**, not about proving a specific scientific claim.

We validate that:
- Deterministic gates behave as documented.
- A full team cycle reliably reaches the mandatory convergence gate once Member A/B reports exist.
- Artifacts and logs are produced in a traceable, reviewable way (trajectory + adjudication + plan updates).
- Knowledge-base growth and citation integrity are enforced (clickable links, no silent drift).

Out of scope (explicitly):
- Guaranteeing that LLM reviewers never hallucinate; we only enforce a contract + convergence loop.
- Optimizing runtime/cost beyond basic “no runaway loops / clear stop conditions”.

Reproducibility scope (important):
- “Reproducible” means: given the same skill version + project baseline + profile, the workflow produces the same **gate outcomes** and the same **trajectory structure**.
- It does **not** require byte-identical LLM prose or timestamps (packets/trajectory contain dates by design).

## 1) Definitions (contract terms)

- **Preflight-only**: deterministic gates + packet build, without calling any LLM runners (`--preflight-only`).
- **Full cycle**: preflight + Member A + Member B (and optional Member C sidecar) + convergence gate.
- **Mandatory convergence gate**: `scripts/gates/check_team_convergence.py` (invoked by `scripts/bin/run_team_cycle.sh`).
- **Trajectory index**: `team/trajectory_index.json` written/updated by `scripts/bin/update_trajectory_index.py`.
- **Profiles** (project-level config `research_team_config.json`): `mixed`, `methodology_dev`, `toolkit_extraction` (at minimum).
- **Members**:
  - Member A: Claude (primary rigorous reviewer)
  - Member B: Gemini (independent replication/review)
  - Member C: optional numerics audit sidecar (non-blocking by policy)

## 2) Baseline and traceability requirements

To run “full validation” you must pin a baseline:
- Record the `research-team` skill git commit SHA (or a tarball hash).
- Record the test project git commit SHA (or the scaffold command + archived scaffold output).
- Use isolated output locations to avoid cross-run interference:
  - Prefer a dedicated test repo, or
  - Use a dedicated `--out-dir` such as `team_skill_validation/`.

Naming conventions (recommended):
- Tags: `V1-mixed-r1`, `V1-methodology-r1`, `V1-toolkit-r1` (avoid reusing tags).
- Adjudications: `team/<tag>_adjudication.md` in the test project.

Tag safety (required for validation):
- Validation runs must use unique tags. Prefer `--auto-tag`.
- Do not reuse a tag: `team/trajectory_index.json` is an upsert-by-(tag,stage) index and tag reuse will overwrite prior stage records.

Handling LLM non-determinism (required):
- If Member A/B disagree across reruns with identical inputs, record the variance in the adjudication as an LLM-environment issue.
- Treat it as a validation failure only if the deterministic workflow behavior changes (gates/trajectory/convergence execution order).

## 3) Acceptance criteria

### P0 (must pass before claiming “validated”)

1) **Deterministic smoke suite passes**
- Command: `bash scripts/dev/run_all_smoke_tests.sh`
- Pass condition: exit code 0.

2) **Legacy entrypoints functional check**
- Run the deterministic wrapper regression:
  - `bash scripts/dev/smoke/smoke_test_run_team_cycle_convergence_gate.sh`
- Pass condition: exit code 0.
  - This exercises legacy `scripts/run_team_cycle.sh` and `scripts/check_team_convergence.py` end-to-end.

3) **Mandatory convergence gate is unskippable once A/B exist**
- For any full cycle run that successfully writes:
  - `team/<tag>_member_a.md`
  - `team/<tag>_member_b.md`
- The script must:
  - invoke `scripts/gates/check_team_convergence.py` and capture its exit code, and
  - print an observable log line containing `[gate] running convergence gate`, and
  - propagate the gate result:
    - gate exit code 0 → full cycle exits 0 and trajectory contains `stage=converged`
    - gate exit code non-zero → full cycle exits non-zero and trajectory contains `stage=not_converged`

Verification hint (machine-checkable):
- Logs: grep for `[gate] running convergence gate` and either `[ok] Converged` or `[fail] Not converged`.
- Trajectory: parse `team/trajectory_index.json` and assert stages exist for the tag.

4) **Sidecar is warn-only**
- If Member C is enabled and fails/times out, the full cycle must still satisfy P0.3 (convergence gate execution + trajectory stage update).
- Deterministic injection (required):
  - `bash scripts/dev/smoke/smoke_test_run_team_cycle_convergence_gate.sh`
  - `bash scripts/dev/smoke/smoke_test_convergence_gate_sidecar.sh`

5) **Three-profile end-to-end validation (at least 1 real run each)**
For each profile in:
- `mixed`
- `methodology_dev`
- `toolkit_extraction`

Run:
1) preflight-only
2) full cycle

Pass conditions:
- preflight-only exits 0.
- full cycle reaches convergence gate.
- trajectory records `member_reports` and then `converged/not_converged`.
- At least one of the three profile runs must result in `stage=converged` (proves the workflow can accept work).

6) **Rendering safety (links + math)**
- Links:
  - No Markdown link may appear inside inline-code spans (single-backtick code).
  - No `knowledge_base/*.md` path may be wrapped in inline code (use a Markdown link).
- Display math (project policy):
  - In `$$...$$` blocks, no line starts with `+`, `-`, or `=` (Markdown hazards).
  - Do not use LaTeX `\\( \\)` or `\\[ \\]` delimiters; use `$...$` / `$$...$$`.
- Required gate coverage in at least one “real project” run:
  - `features.notebook_integrity_gate=true` (enforces the rules above)
  - `features.references_gate=true` (ensures external + KB links in References)

7) **Knowledge base expansion is exercised**
- During validation, the project must add (beyond the scaffold baseline commit):
  - at least 1 new KB note under `knowledge_base/literature/` (not a demo file), and
  - at least 1 new methodology trace under `knowledge_base/methodology_traces/` documenting the query → selection → why.
- Minimum non-triviality for the new KB note:
  - contains at least one external link (arXiv/INSPIRE/DOI/GitHub), and
  - contains substantive synthesized content (not a stub).
- The choice and rationale must be linked from `PREWORK.md`.
- Machine-check hint (recommended): `git diff <scaffold-baseline> --name-only | grep '^knowledge_base/'` shows new files.

8) **Plan tracking updates are non-destructive (when enabled)**
- If `plan_tracking.enabled=true`, updates to `RESEARCH_PLAN.md` must be append-only (except `Last updated:`) and must not delete/rewrite unrelated user content.
- Verification hint: add a sentinel paragraph in `RESEARCH_PLAN.md`, run one full cycle, and confirm the sentinel text is preserved verbatim.

### P1 (should pass; required for “stable”)

1) **Gate↔docs semantic alignment spot-check**
- Randomly sample at least 5 gates and verify:
  - documentation promise ↔ implemented check ↔ a test case demonstrating both pass and fail.

2) **Failure-mode runbook exists**
- For each P0 gate failure class, there is a short “what failed / how to fix / how to rerun” entry.

3) **Sidecar status observability**
- If Member C is enabled, capture its outcome clearly (success/fail/timeout) in logs and/or an explicit artifact.

### P2 (nice-to-have)

- Structured JSONL gate logs (verdict + reason + timestamps).
- Budget/loop circuit-breakers (max rounds, token budget).

## 4) Test matrix (minimum set)

| ID | Scenario | Mode | Profile | Expected |
|---:|---|---|---|---|
| S0 | Skill smoke suite | deterministic | n/a | all smoke tests pass |
| S1 | Full cycle, sidecar OFF | real project | mixed | convergence gate runs; trajectory has converged/not_converged |
| S2 | Sidecar ON + forced failure (deterministic) | smoke | n/a | sidecar warns only; convergence still recorded |
| S3 | Methodology profile full cycle | real project | methodology_dev | claim/evidence gates and KB trace patterns exercised |
| S4 | Toolkit profile full cycle | real project | toolkit_extraction | toolkit-specific DoD satisfied; no goal drift |
| S5 | Legacy path invocation from project | real project | any | legacy `scripts/` entrypoints behave identically |
| S6 | KB expansion mid-project | real project | any | new KB note + trace + References remain clickable |

Notes:
- “Real project” means a scaffolded repo with nontrivial content (not the demo-only milestone).
- Each “real project” run must produce a closed-loop record: change list → gates → A/B(/C) reports → adjudication → next tasks.

## 5) Evidence and reporting (required artifacts)

For each validation run (tag):
- `team/team_packet_<tag>.txt` (or equivalent packet snapshot)
- `team/<tag>_member_a.md`
- `team/<tag>_member_b.md`
- optional: `team/<tag>_member_c*.md`
- `team/<tag>_adjudication.md` (human-readable closed-loop record)
- `team/trajectory_index.json` contains stage entries for the tag, including at minimum:
  - `{"stage":"preflight_ok","tag":"<tag>",...}`
  - `{"stage":"member_reports","tag":"<tag>",...}`
  - `{"stage":"converged","tag":"<tag>",...}` or `{"stage":"not_converged","tag":"<tag>",...}`

Schema reference: `scripts/bin/update_trajectory_index.py` (canonical stage vocabulary and JSON structure).

## 6) Stop conditions (avoid runaway)

Full validation must define, per project:
- Maximum allowed reruns for a tag family (example: 5 rounds).
- A “narrowing rule” when convergence is not reached:
  - narrow scope, reduce claim strength, or explicitly classify as `SCOPE/MATCHING` per the skill’s policy.
