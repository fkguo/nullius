# W5-01 Review Packet (Round 001)

## Scope
Start a **new decoupled pilot** (new slug) in `idea-runs/` and wire **A0.1 charter + A0.2 promotion contract (smoke)** as machine-checkable artifacts. Enforce **ecosystem_validation** scope discipline (NOT_FOR_CITATION) and provide replayable validation evidence.

This is a workflow-quality stage (not physics-result stage).

## Repositories + File Changes

### idea-runs
- New project (new slug):
  - `projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/**`
  - Includes:
    - toolchain pin: `toolchain/manifest.lock.json`
    - A0.1 charter (machine-checkable): `artifacts/charter/campaign_charter_v1.json`
    - A0.2 promotion contract smoke (machine-checkable): `artifacts/promotion/promotion_result_v1.smoke.json`
    - scope enforcement: `artifacts/scope/scope_classification_v1.json` + `reports/draft.md` contains `NOT_FOR_CITATION`
    - evidence index: `evidence/index.md`

- Added validator + schema snapshots to make A0 artifacts machine-checkable inside the run repo:
  - Added: `scripts/validate_project_artifacts.py`
  - Modified: `Makefile` (adds `validate-project`)
  - Added: `schemas/campaign_charter_v1.schema.json`
  - Added: `schemas/scope_classification_v1.schema.json`
  - Added: `schemas/promotion_result_v1.schema.json`
  - Added: `schemas/budget_snapshot_v1.schema.json`
  - Added: `schemas/idempotency_meta_v1.schema.json`

### idea-generator
- Tracker + board sync evidence:
  - Modified: `docs/plans/2026-02-12-implementation-plan-tracker.md` (W5-01 -> IN_PROGRESS; update log appended)
  - Added: `docs/reviews/bundles/2026-02-15-w5-01-board-sync-check-v1.txt`
- Validation evidence:
  - Added: `docs/reviews/bundles/2026-02-15-w5-01-validate-v1.txt`

## DoD Checklist (W5-01)
- [x] New decoupled pilot project exists under `idea-runs/projects/<new_slug>/`.
- [x] A0.1 charter artifact is present and schema-validated.
- [x] A0.2 promotion contract smoke artifact is present and schema-validated.
- [x] Scope is `ecosystem_validation` and NOT_FOR_CITATION is enforced in the single human report.
- [x] Replayable evidence bundle exists (toolchain pin + evidence index).
- [x] Validation commands pass and evidence is persisted.

## Verification Commands + Results
- `idea-generator`: `make validate` => PASS
- `idea-runs`: `make validate` => PASS
- `idea-runs`: `PROJECT=projects/pion-gff-bootstrap-positivity-pilot-2026-02-15 make validate-project` => PASS

Evidence: `docs/reviews/bundles/2026-02-15-w5-01-validate-v1.txt`

## Evidence Paths
- Board sync: `docs/reviews/bundles/2026-02-15-w5-01-board-sync-check-v1.txt`
- Validation: `docs/reviews/bundles/2026-02-15-w5-01-validate-v1.txt`
- Pilot evidence index: `/home/user/Coding/Agents/Autoresearch/idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/index.md`

## Risks / Review Focus
1. **Decoupling boundary**: confirm no test-instance content leaked into `idea-generator`.
2. **Machine-checkability**: confirm validators are strict enough (schema + NOT_FOR_CITATION enforcement).
3. **Portability**: confirm pilot docs avoid absolute-path dependence (manifest lock is self-contained and checksums documented).
4. **A0 semantics**: confirm A0.2 promotion smoke test is clearly labeled as contract validation only (not a claim of a real promotion run).

## Required verdict format
Use strict contract. First line must be exactly `VERDICT: READY` or `VERDICT: NOT_READY`.
