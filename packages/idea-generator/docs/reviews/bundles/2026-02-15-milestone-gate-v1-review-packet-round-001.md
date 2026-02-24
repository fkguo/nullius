# Milestone Gate v1 Review Packet (Round 001)

## Scope
Review only the milestone gate consumability changes in `idea-generator`.

## Changed files
- `schemas/milestone_gate_v1.schema.json`
- `docs/plans/examples/2026-02-15-w5-04-gates/milestone_gate_v1.example.json`
- `scripts/validate_w5_quality_schemas.py`
- `docs/plans/2026-02-15-w5-04-quality-gates-checklist-v1.md`
- `docs/plans/2026-02-12-implementation-plan-tracker.md`

## Intent
Make `milestone_gate_v1` a consumed gate contract, not an orphan schema.

## Required checks
1. Consumption wiring
- `scripts/validate_w5_quality_schemas.py` must include `milestone_gate_v1.schema.json` in `SCHEMA_FILES`.
- `EXAMPLE_MAP` must include `milestone_gate_v1.example.json`.
- `make validate` must pass.

2. Gate semantics (machine-checkable)
- Dual-review lock:
  - reviewer_a model is `opus`
  - reviewer_b requested/resolved model is `gemini-3-pro-preview`
  - `fallback_mode` is `ask`
  - `both_ready` is `true`
- Scope policy lock:
  - includes `scope` and `non_citation_required`
  - for `ecosystem_validation|preliminary_physics`, `NOT_FOR_CITATION` policy is required.
- Core-loop anti-skip lock:
  - must require `search.step`, `eval.run`, `rank.compute`, `node.promote`
  - must require core artifacts refs and `failed_approach_count>=1`.

3. Backward safety in repo scope
- No test-instance tree introduced.
- Checklist references include milestone gate schema/example.
- Tracker updated append-only.

## Verification evidence
- Command: `make validate`
- Expected output includes:
  - `OK: no test-instance pollution paths detected.`
  - `OK: W5 quality-gate schemas and examples validated`

## Required verdict format
First line exactly `VERDICT: READY` or `VERDICT: NOT_READY`.
