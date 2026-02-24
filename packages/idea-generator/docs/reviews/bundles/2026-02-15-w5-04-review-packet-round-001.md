# W5-04 Review Packet (Round 001)

## Scope
Implement generic quality-gate schemas and checklist artifacts in `idea-generator` only (design/contract level, no test-instance run trees).

## Changed Files
- `schemas/scope_classification_v1.schema.json`
- `schemas/method_fidelity_contract_v1.schema.json`
- `schemas/literature_search_evidence_v2.schema.json`
- `schemas/numerics_method_selection_v1.schema.json`
- `schemas/numerics_validation_report_v1.schema.json`
- `schemas/portability_report_v1.schema.json`
- `schemas/core_loop_execution_audit_v1.schema.json`
- `docs/plans/examples/2026-02-15-w5-04-gates/*.json`
- `docs/plans/2026-02-15-w5-04-quality-gates-checklist-v1.md`
- `scripts/validate_w5_quality_schemas.py`
- `Makefile` (`validate` now runs pollution check + W5 schema validation)

## W5-04 DoD Checklist
- [x] `method_fidelity_contract_v1`
- [x] `literature_search_evidence_v2` (role/family/coverage/gap analysis)
- [x] `numerics_method_selection_v1`
- [x] `numerics_validation_report_v1`
- [x] `portability_report_v1`
- [x] scope grading + non-citation policy (`scope_classification_v1`)
- [x] optional anti-skip audit (`core_loop_execution_audit_v1`)
- [x] minimum example artifacts in docs (no research run tree)
- [x] machine-check checklist doc

## Non-scope / Guardrails
- No physics-specific algorithm hardcoding.
- No test-instance run content in tool repos.
- No `research/**` or `docs/research/**` artifacts added.

## Verification
- Evidence: `docs/reviews/bundles/2026-02-15-w5-04-validate-v1.txt`
- Command:
  - `make validate`
  - internally runs:
    - `python3 scripts/check_no_test_instance_pollution.py`
    - `python3 scripts/validate_w5_quality_schemas.py`

## Reviewer Focus
1. Are schemas truly generic and reusable beyond one physics project?
2. Do schema constraints enforce non-citation scope semantics correctly?
3. Does `core_loop_execution_audit_v1` make anti-skip requirements machine-checkable?
4. Are examples minimal, valid, and free of test-instance leakage?

## Required verdict format
First line exactly `VERDICT: READY` or `VERDICT: NOT_READY`.
