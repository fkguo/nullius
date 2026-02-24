# W5-03 Review Packet (Round 003)

## Context
Round 002 results:
- Claude (Opus): `VERDICT: NOT_READY`
- Gemini: `VERDICT: READY`

This round applies minimal fixes for all round-002 blockers and re-submits for convergence.

## Blocker Resolution Summary

1) **"Anti-pollution script not shown"**
- Resolved by including exact script logic below and keeping scripts in both tool repos:
  - `idea-core/scripts/check_no_test_instance_pollution.py`
  - `idea-generator/scripts/check_no_test_instance_pollution.py`

2) **"manifest.lock schema unspecified"**
- Resolved with explicit schema + automated validation:
  - `idea-runs/schemas/manifest.lock.schema.json`
  - `idea-runs/scripts/validate_manifest_lock.py`
  - `idea-runs/Makefile` (`make validate`)

3) **"No automated test for migration completeness"**
- Resolved with explicit migrated-path guard in `idea-core`:
  - `idea-core/scripts/check_m5_legacy_migration_absent.py`
  - wired into `idea-core/Makefile` `validate` target.

## Exact Gate Logic (verbatim)

### anti-pollution forbidden roots
```python
FORBIDDEN_ROOTS = (
    Path("research"),
    Path("docs/research"),
    Path("artifacts/runs"),
)
```
Behavior: if any forbidden root exists with content (file/dir/symlink), exit non-zero fail-fast.

### migration-completeness guard
```python
MIGRATED_PATHS = (
    Path("docs/research/pion-gff-bootstrap/m0.1-preflight.md"),
    Path("docs/research/pion-gff-bootstrap/m0.2-design.md"),
    Path("docs/research/pion-gff-bootstrap/tracker.md"),
    Path("docs/research/pion-gff-bootstrap/sync/2026-02-14-m0.2-board-sync.txt"),
    Path("docs/research/pion-gff-bootstrap/sync/2026-02-14-m0.3-blocked-note.txt"),
)
```
Behavior: if any migrated legacy path is reintroduced into `idea-core`, exit non-zero fail-fast.

## New / Changed Files Since Round 002

### idea-core
- Added: `scripts/check_m5_legacy_migration_absent.py`
- Modified: `Makefile` (`validate` now runs anti-pollution + migration guard + contract validate)
- Existing from W5-03:
  - `scripts/check_no_test_instance_pollution.py`
  - removed `docs/research/pion-gff-bootstrap/**` from tool repo

### idea-generator
- Added: `Makefile` (`make validate` anti-pollution gate)
- Added: `scripts/check_no_test_instance_pollution.py`
- Modified tracker / planning docs:
  - `docs/plans/2026-02-12-implementation-plan-tracker.md`
  - `docs/plans/2026-02-15-w5-hardening-execution-plan.md`

### idea-runs (new decoupled repo)
- Added schema + validator:
  - `schemas/manifest.lock.schema.json`
  - `scripts/validate_manifest_lock.py`
  - `Makefile`
- Added template + projects:
  - `projects/_template/**`
  - `projects/expected-limitations-method-drift/**`
  - `projects/pion-gff-bootstrap-m5-legacy/**`
- Added provenance doc:
  - `projects/pion-gff-bootstrap-m5-legacy/PROVENANCE.md`

## DoD Checklist (W5-03)
- [x] `idea-runs` monorepo created with `projects/<project_slug>/` template structure.
- [x] `toolchain/manifest.lock.json` with repo URL + commit SHA + checksum metadata.
- [x] At least one expected-limitations sample project included.
- [x] Anti-pollution gates added to both tool repos.
- [x] Migration completeness automated check added.
- [x] Tracker updated with board-sync evidence + append-only log.

## Verification Commands + Evidence

### idea-core
- Evidence: `idea-core/docs/reviews/bundles/2026-02-15-w5-03-validate-v1.txt`
- Commands covered:
  - `python3 scripts/check_no_test_instance_pollution.py`
  - `python3 scripts/check_m5_legacy_migration_absent.py`
  - `PYTHONPATH=src make validate`

### idea-generator
- Evidence: `idea-generator/docs/reviews/bundles/2026-02-15-w5-03-validate-v1.txt`
- Command covered:
  - `make validate`

### idea-runs
- Evidence: `idea-runs/evidence/2026-02-15-w5-03-validate-v1.txt`
- Command covered:
  - `make validate`

### tracker↔board sync
- Evidence: `idea-generator/docs/reviews/bundles/2026-02-15-w5-03-board-sync-check-v1.txt`

## Scope / Boundary Check
- Tool repos do not retain test-instance run trees.
- Test-instance/legacy research content archived in `idea-runs` only.
- W5-03 changes are tooling-policy and infrastructure-oriented; no physics-method implementation mixed into tool repos.

## Required verdict format
First line exactly `VERDICT: READY` or `VERDICT: NOT_READY`.
