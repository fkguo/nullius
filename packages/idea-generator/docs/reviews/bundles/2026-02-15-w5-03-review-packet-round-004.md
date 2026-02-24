# W5-03 Review Packet (Round 004)

## Context
Round 003 results:
- Claude (Opus): `VERDICT: READY`
- Gemini: `VERDICT: NOT_READY`

Round-003 Gemini blockers addressed in this round.

## Round-003 Gemini Blockers -> Fixes

1) **Blocker: pollution persists in `docs/plans/auto-relay/idea-program.profile.yaml`**
- Fix: removed `docs/plans/auto-relay/**` from `idea-generator` workspace.
- Evidence: `idea-generator/docs/reviews/bundles/2026-02-15-w5-03-validate-v2.txt` includes:
  - `test ! -d docs/plans/auto-relay` => OK

2) **Blocker: anti-pollution false negatives due to scope confusion**
- Clarified boundary policy in both scripts (docstring):
  - forbidden: `research/**`, `docs/research/**`, `artifacts/runs/**`
  - allowed: design/review SSOT under `docs/plans/**` and `docs/reviews/**`
- Files:
  - `idea-core/scripts/check_no_test_instance_pollution.py`
  - `idea-generator/scripts/check_no_test_instance_pollution.py`

3) **Blocker: `docs/plans/agent-team-output/2026-02-15-m5-retro-swarm-v1/` should be moved**
- Resolution: this path is explicitly mandated SSOT design evidence (retro+swarm archive) in this program and is not a run tree.
- It is intentionally retained in `idea-generator/docs/plans/agent-team-output/...` as design/audit input.
- Evidence: `idea-generator/docs/reviews/bundles/2026-02-15-w5-03-validate-v2.txt` includes:
  - `test -d docs/plans/agent-team-output/2026-02-15-m5-retro-swarm-v1` => OK

## W5-03 Deliverables (current state)

### idea-core
- Added: `scripts/check_no_test_instance_pollution.py`
- Added: `scripts/check_m5_legacy_migration_absent.py`
- Modified: `Makefile` (`validate` runs anti-pollution + migration guard + contracts validate)
- Removed from tool repo and migrated to `idea-runs`:
  - `docs/research/pion-gff-bootstrap/**`

### idea-generator
- Added: `Makefile` + `scripts/check_no_test_instance_pollution.py`
- Updated tracker and planning evidence:
  - `docs/plans/2026-02-12-implementation-plan-tracker.md`
  - `docs/plans/2026-02-15-w5-hardening-execution-plan.md`
  - `docs/reviews/bundles/2026-02-15-w5-03-board-sync-check-v1.txt`
- Removed transient local state:
  - `docs/plans/auto-relay/**`

### idea-runs (new repo)
- Added project template and two projects:
  - `_template`
  - `expected-limitations-method-drift`
  - `pion-gff-bootstrap-m5-legacy`
- Added `manifest.lock` contract + validation:
  - `schemas/manifest.lock.schema.json`
  - `scripts/validate_manifest_lock.py`
  - `Makefile`
- Added legacy migration provenance:
  - `projects/pion-gff-bootstrap-m5-legacy/PROVENANCE.md`

## Verification Evidence

- `idea-core/docs/reviews/bundles/2026-02-15-w5-03-validate-v2.txt`
- `idea-generator/docs/reviews/bundles/2026-02-15-w5-03-validate-v2.txt`
- `idea-runs/evidence/2026-02-15-w5-03-validate-v2.txt`

## Required verdict format
First line exactly `VERDICT: READY` or `VERDICT: NOT_READY`.
