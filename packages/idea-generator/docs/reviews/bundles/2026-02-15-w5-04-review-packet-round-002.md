# W5-04 Review Packet (Round 002)

## Scope
Review W5-04 generic quality-gate schemas and checklist in `idea-generator` only. This stage is design/contract hardening, not research-instance work.

## Round intent
Round-001 had reviewer disagreement. This round adds direct, machine-verifiable evidence snippets to prevent stale or fabricated blockers.

## Changed Files (same scope as round-001)
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
- `Makefile`

## W5-04 DoD Checklist
- [x] `method_fidelity_contract_v1`
- [x] `literature_search_evidence_v2` (`evidence_role` + `method_family` + `coverage_report` + `seed_gap_analysis`)
- [x] `numerics_method_selection_v1`
- [x] `numerics_validation_report_v1`
- [x] `portability_report_v1`
- [x] scope grading + non-citation policy (`scope_classification_v1`)
- [x] optional anti-skip audit (`core_loop_execution_audit_v1`)
- [x] minimum example artifacts in docs (no run tree)
- [x] machine-check checklist doc

## Ground-truth evidence (must review against current files)
1. Schema-instance validation is enforced in CI script:
   - `scripts/validate_w5_quality_schemas.py` imports `Draft202012Validator`
   - it calls `validator.iter_errors(instance)` for each example
   - it fails non-zero on any validation error
2. Top-level schema hygiene is present:
   - all seven schemas include `$schema`, `$id`, and top-level `"additionalProperties": false`
3. `literature_search_evidence_v2` contract shape:
   - uses `records` (not `entries`)
   - `records.items.required` includes:
     `record_id,title,uri,evidence_role,method_family,decision,triage_reason`
4. `core_loop_execution_audit_v1` anti-skip shape:
   - uses `events` (not `steps`)
   - `events.items.required` includes:
     `step,idempotency_key,status,started_at,completed_at`
   - `allOf` + `contains` enforce successful presence of:
     `search.step`, `eval.run`, `rank.compute`, `node.promote`
5. No test-instance logic:
   - no bootstrap/pion/domain-specific algorithm fields in these schemas/examples

## Reviewer boundaries
- Judge only current file contents under this packet scope.
- If raising a blocker, cite exact file path and exact key/constraint that is missing in current file.
- Do not treat unrelated SSOT archives as schema blockers for W5-04.

## Verification
- Evidence: `docs/reviews/bundles/2026-02-15-w5-04-validate-v1.txt`
- Command:
  - `make validate`

## Required verdict format
First line exactly `VERDICT: READY` or `VERDICT: NOT_READY`.
