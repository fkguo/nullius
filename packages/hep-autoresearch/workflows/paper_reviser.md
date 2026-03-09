# paper_reviser — Paper reviser (LaTeX) + verification loop (A–E)

Chinese version: `workflows/paper_reviser.zh.md`.

## Goal

Integrate the Codex skill `paper-reviser` into `hepar` as an evidence-first, resumable workflow:

- A) revise a draft `.tex` (writer + auditor + deep verifier),
- B) build a deterministic verification plan for literature checks,
- C) execute retrieval tasks under an A1 approval gate (mass_search),
- D) synthesize evidence into per-request notes (LLM allowed; JSON SSOT + deterministic render),
- E) revise again once with the evidence context.

All SSOT outputs live under:
`artifacts/runs/<RUN_ID>/paper_reviser/`

## Inputs

- Draft `.tex` path (default: `<paper-root>/<tex-main>`)
- Writer model config: `--writer-backend` + `--writer-model` (required, non-empty)
- Auditor model config: `--auditor-backend` + `--auditor-model` (required, non-empty)
- Evidence synthesis config:
  - either `--evidence-synth-backend` + `--evidence-synth-model`, or
  - `--manual-evidence` (user writes evidence notes by hand)

## Outputs (artifacts; SSOT)

Required:
- `manifest.json`, `summary.json`, `analysis.json`, `report.md`
- `round_01/` and `round_02/` (paper-reviser outputs incl. `run.json`, `clean.tex`, `changes.diff`)
- `verification/verification_plan.json`
- `verification/task_state/*.json` + `verification/logs/*.log`
- `verification/evidence_state/*.json` + `verification/evidence/<VR-ID>.json` + `verification/evidence/<VR-ID>.md`

## Steps (MVP)

1) Step A — Revise (offline)
   - Run `paper_reviser_edit.py` on the input draft `.tex`.
   - Write SSOT under `round_01/` (incl. `run.json`, `clean.tex`, `changes.diff`, `verification_requests.json`).
2) Step B — Build verification plan (offline)
   - If `round_01/verification_requests.json` exists, run `build_verification_plan.py`.
   - Force all retrieval outputs to live under `artifacts/runs/<RUN_ID>/paper_reviser/verification/` (no KB/refs pollution).
3) Step C — Approval gate + execute retrieval (networked retrieval only)
   - If retrieval tasks exist, always request **A1 approval** (mass_search) before executing.
   - Execute each `research-team.literature_fetch` task with per-task `task_state/<id>.json` + `logs/<id>.log`.
4) Step D — Evidence synthesis (fan-in; offline LLM allowed)
   - Automatic: per VR writes `verification/evidence/<VR-ID>.json` (SSOT) + deterministic `verification/evidence/<VR-ID>.md`.
   - Manual: stop after Step C and require user-authored `verification/evidence/<VR-ID>.md`.
5) Step E — Revise again (offline)
   - Re-run `paper_reviser_edit.py` once on `round_01/clean.tex` with `--context-dir verification/evidence/`.
   - Write SSOT under `round_02/`.

## Gates (approval)

- **A1 (mass_search)**: required for Step C whenever retrieval tasks exist.
- **A4 (paper_edits)**: only required if the user passes `--apply-to-draft` and the project approval policy requires paper edits approval.

## Gates (acceptance)

- SSOT exists under `artifacts/runs/<RUN_ID>/paper_reviser/`:
  - `manifest.json`, `summary.json`, `analysis.json`, `report.md`
  - `round_01/run.json` + `round_01/clean.tex` + `round_01/changes.diff`
  - `round_02/run.json` + `round_02/clean.tex` + `round_02/changes.diff` (unless blocked by A1/A4 or manual evidence)
- Step A/E success criteria (per-round):
  - `run.json` has `schema_version==1`, `exit_status==0`, `converged==true`
- Step C gating:
  - If tasks exist, must be blocked with `exit=3` until A1 is approved.
  - No retrieval output paths may escape the run-root (evidence-first).
- Step C/D idempotence:
  - Step C skip requires `exit_code==0` and `log_sha256` match.
  - Step D skip requires `exit_code==0` and `output_json_sha256` match.

## Resume / idempotence

- Step A/E: considered complete iff `round_xx/run.json` shows `exit_status==0` and `converged==true` and required files exist; otherwise rerun requires `--force`.
- Step C: each retrieval task has `task_state/<id>.json` + `logs/<id>.log`; task is skipped only when `exit_code==0` and the log SHA256 matches.
- Step D: each VR has `evidence_state/<VR-ID>.json` + output JSON; VR is skipped only when `exit_code==0` and output JSON SHA256 matches.

## MVP scope

- v0 includes:
  - A–E pipeline with SSOT artifacts under `artifacts/runs/<RUN_ID>/paper_reviser/`
  - A1-gated retrieval (Step C) and optional A4-gated apply-to-draft
  - Evidence synthesis modes: automatic (LLM/stub) or manual evidence notes
- v0 intentionally excludes:
  - Writing to `knowledge_base/` or `references/` by default
  - LaTeX compilation gates (run `latexmk` separately if desired)
  - Multi-round revise loops beyond `round_01` + `round_02`

## Extension roadmap (v1/v2)

- v1:
  - Add an optional compile gate (`latexmk`) to validate `round_01` / `round_02` outputs.
  - Add richer evidence packaging (e.g., include fetched notes/snippets directly in the VR context).
- v2:
  - Multi-round revision until converged (with a bounded budget) and better cross-round diffing/traceability.
  - Optional “copy evidence into KB/refs” step (opt-in; recorded in manifest for auditability).

## CLI

Run:

```bash
hepar run --run-id <RUN_ID> --workflow-id paper_reviser \
  --writer-backend claude --writer-model <MODEL> \
  --auditor-backend gemini --auditor-model <MODEL> \
  --evidence-synth-backend gemini --evidence-synth-model <MODEL>
```

Optional robustness knobs (forwarded to `paper_reviser_edit.py` in both round_01 and round_02):

```bash
hepar run --run-id <RUN_ID> --workflow-id paper_reviser \
  ... \
  --paper-reviser-min-clean-size-ratio 0.70 \
  --paper-reviser-codex-model <CODEX_MODEL> \
  --paper-reviser-codex-config reasoning.effort=medium \
  --paper-reviser-codex-config sandbox_mode=read-only \
  --paper-reviser-fallback-auditor claude \
  --paper-reviser-fallback-auditor-model <CLAUDE_MODEL> \
  --paper-reviser-secondary-deep-verify-backend gemini \
  --paper-reviser-secondary-deep-verify-model <GEMINI_MODEL>
```

Approve retrieval (Step C):

```bash
hepar status
hepar approve A1-0001
hepar run --run-id <RUN_ID> --workflow-id paper_reviser ...
```

Manual evidence mode:

```bash
hepar run ... --manual-evidence
# write artifacts/runs/<RUN_ID>/paper_reviser/verification/evidence/<VR-ID>.md
hepar run ...
```
