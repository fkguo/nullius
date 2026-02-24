# W5-03 Review Packet (Round 001)

## Scope
Implement test-instance decoupling and anti-pollution safeguards as generic tooling capabilities.

## Repositories + File Changes

### idea-core
- Added: `scripts/check_no_test_instance_pollution.py`
- Modified: `Makefile` (validate now runs anti-pollution check first)
- Removed from tool repo (migrated to `idea-runs`):
  - `docs/research/pion-gff-bootstrap/m0.1-preflight.md`
  - `docs/research/pion-gff-bootstrap/m0.2-design.md`
  - `docs/research/pion-gff-bootstrap/tracker.md`
  - `docs/research/pion-gff-bootstrap/sync/2026-02-14-m0.2-board-sync.txt`
  - `docs/research/pion-gff-bootstrap/sync/2026-02-14-m0.3-blocked-note.txt`

### idea-generator
- Added: `Makefile` (minimal `make validate` + anti-pollution check)
- Added: `scripts/check_no_test_instance_pollution.py`
- Added planning/evidence:
  - `docs/plans/2026-02-15-w5-hardening-execution-plan.md`
  - `docs/reviews/bundles/2026-02-15-w5-03-board-sync-check-v1.txt`
- Modified: `docs/plans/2026-02-12-implementation-plan-tracker.md`
  - W5-03 -> `IN_PROGRESS`
  - append-only update log entries for board sync + plan path

### idea-runs (new decoupled run repo)
- New repo root: `/home/user/Coding/Agents/Autoresearch/idea-runs`
- Added monorepo scaffolding and templates under `projects/`
- Added expected-limitations sample project:
  - `projects/expected-limitations-method-drift/**`
  - includes `toolchain/manifest.lock.json` and `artifacts/ideas/failed_approach_v1.jsonl`
- Added legacy archive project (migrated from tool repo):
  - `projects/pion-gff-bootstrap-m5-legacy/archive/from-idea-core-docs-research/pion-gff-bootstrap/**`

## DoD Checklist (W5-03)
- [x] `idea-runs` monorepo created with `projects/<project_slug>/` template structure.
- [x] `toolchain/manifest.lock.json` added with repo URL + commit SHA + checksum metadata.
- [x] At least one expected-limitations sample project included.
- [x] Anti-pollution gate added to tool repos (`idea-core`, `idea-generator`).
- [x] Tracker updated with W5-03 start + board sync evidence.

## Verification Commands + Results
- `idea-core`: `python3 scripts/check_no_test_instance_pollution.py` => PASS
- `idea-core`: `PYTHONPATH=src make validate` => PASS
- `idea-generator`: `make validate` => PASS
- Board sync: `gh project item-list ...` confirms
  - `[W5-03]` = `In Progress`
  - `[W5-04]` / `[W5-05]` = `Todo`

## Evidence Paths
- `docs/reviews/bundles/2026-02-15-w5-03-board-sync-check-v1.txt` (tracker↔board sync)
- `docs/plans/2026-02-15-w5-hardening-execution-plan.md` (execution plan)

## Risks / Review Focus
1. Gate strictness: verify anti-pollution check blocks all forbidden paths without false negatives.
2. Migration completeness: verify no test-instance files remain in tool repos.
3. Decoupled repo quality: verify `idea-runs` layout is generic and not tied to a physics-specific workflow.
4. Audit chain: verify tracker log and board status changes are append-only and traceable.

## Required verdict format
Use strict contract. First line must be exactly `VERDICT: READY` or `VERDICT: NOT_READY`.
