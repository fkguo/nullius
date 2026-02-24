# W6-02 Review Packet (Round 001) — Idea Islands + Bootstrap Opportunity Pool (Gate Enforced)

## Scope
Implement **machine-checkable** artifacts for "islandized exploration" and a **bootstrap opportunity pool**, and enforce them via `make validate-project` in `idea-runs`.

Hard requirements (from campaign spec):
- If a project contains islands/opportunity config/artifact dirs, `validate-project` must require the corresponding artifacts exist and pass schema validation.
- Islands/opportunity records must contain reusable retrieval keys (`tags`, `bootstrap_mechanism_tags`, `island_id` / `opportunity_id`) and **at least one** evidence reference.
- Rejected/failed islands/opportunities must enter `failed_approach_v1.jsonl` and be retrievable via the failure library query (avoid-repeat closure).

## Repositories + File Changes

### idea-generator
- New schemas (design SSOT):
  - Added: `schemas/idea_island_plan_v1.schema.json`
  - Added: `schemas/idea_island_registry_v1.schema.json`
  - Added: `schemas/idea_island_progress_event_v1.schema.json`
  - Added: `schemas/bootstrap_opportunity_card_v1.schema.json`

- New examples + schema validator:
  - Added: `docs/plans/examples/2026-02-16-w6-01-islands-opportunities/**`
  - Added: `scripts/validate_w6_islands_opportunities_schemas.py`
  - Modified: `Makefile` (adds `check-w6-islands-opportunities-schemas` to `make validate`)

- Evidence:
  - Added: `docs/reviews/bundles/2026-02-16-w6-02-idea-generator-validate-v1.txt`
  - Added: `docs/reviews/bundles/2026-02-16-w6-02-idea-runs-validate-v1.txt`
  - Added: `docs/reviews/bundles/2026-02-16-w6-02-idea-runs-validate-project-v2.txt`
  - Added: `docs/reviews/bundles/2026-02-16-w6-02-failure-library-index-build-v1.txt`
  - Added: `docs/reviews/bundles/2026-02-16-w6-02-failure-library-query-run-v1.txt`

### idea-runs
- New schema snapshots (runtime enforcement lives here):
  - Added: `schemas/idea_island_plan_v1.schema.json`
  - Added: `schemas/idea_island_registry_v1.schema.json`
  - Added: `schemas/idea_island_progress_event_v1.schema.json`
  - Added: `schemas/bootstrap_opportunity_card_v1.schema.json`

- Gate enforcement (project-level):
  - Modified: `scripts/validate_project_artifacts.py`
    - If `artifacts/islands/` exists:
      - requires `artifacts/islands/idea_island_registry_v1.json`
      - validates registry schema
      - validates all registry-referenced plan artifacts with `idea_island_plan_v1`
      - if `artifacts/islands/idea_island_progress_v1.jsonl` exists, validates each event line
    - If `artifacts/opportunities/` exists:
      - requires `artifacts/opportunities/bootstrap_opportunity_pool_v1.jsonl`
      - validates each JSONL line as `bootstrap_opportunity_card_v1`

- Pilot project artifacts (now gate-enforced):
  - Added: `projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/islands/**`
  - Added: `projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/opportunities/**`

- Failure library closure for rejected opportunity:
  - Modified (append-only): `projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/ideas/failed_approach_v1.jsonl`
    - Added veto record tagged with `opportunity_id:...` + `scope:out_of_scope`
  - Modified: `projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/pipeline/failure_library_query_v1.json`
    - Broadened query: `tags=["scope:ecosystem_validation"]`, `failure_modes=["method_drift","scope_violation"]`
  - Regenerated: `evidence/failure_library_index_v1.json`
  - Regenerated: `projects/.../artifacts/failure_library/failure_library_hits_v1.json`

## DoD Checklist (W6-02)
- [x] Schema files exist (design repo + run repo snapshot).
- [x] Examples validate in idea-generator (`make validate` passes).
- [x] Gate enforced in idea-runs (`validate-project` fails if dirs exist but artifacts missing).
- [x] Pilot project includes islands registry + per-island plans + opportunity pool JSONL with evidence+tags.
- [x] Failure library closure demonstrated: rejected/out-of-scope opportunity veto is in `failed_approach_v1.jsonl` and is retrievable by the failure library query hook.

## Verification Commands + Results
- `idea-generator`: `make validate` => PASS  
  Evidence: `docs/reviews/bundles/2026-02-16-w6-02-idea-generator-validate-v1.txt`

- `idea-runs`: `make validate` => PASS  
  Evidence: `docs/reviews/bundles/2026-02-16-w6-02-idea-runs-validate-v1.txt`

- `idea-runs`: `PROJECT=projects/pion-gff-bootstrap-positivity-pilot-2026-02-15 make validate-project` => PASS  
  Evidence: `docs/reviews/bundles/2026-02-16-w6-02-idea-runs-validate-project-v2.txt`

- `idea-runs`: `make build-failure-library-index` => PASS  
  Evidence: `docs/reviews/bundles/2026-02-16-w6-02-failure-library-index-build-v1.txt`

- `idea-runs`: `PROJECT=projects/pion-gff-bootstrap-positivity-pilot-2026-02-15 make run-failure-library-query` => PASS  
  Evidence: `docs/reviews/bundles/2026-02-16-w6-02-failure-library-query-run-v1.txt`

## Evidence Paths (Key)
- Islands registry: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/islands/idea_island_registry_v1.json`
- Opportunity pool: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/opportunities/bootstrap_opportunity_pool_v1.jsonl`
- Veto record (append-only): `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/ideas/failed_approach_v1.jsonl`
- Failure library hits: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/failure_library/failure_library_hits_v1.json`

## Risks / Review Focus
1. **Gate semantics**: Are the enablement triggers correct and non-surprising? (Dirs exist => artifacts must validate.)
2. **Schema adequacy**: Do the schemas enforce the required retrieval keys and evidence refs without overfitting to one campaign?
3. **Anti-pollution**: Confirm no research-run scaffolds leaked into `idea-generator` (examples-only is OK).
4. **Failure-library closure**: Confirm the rejected opportunity is truly retrievable by the query hook and will prevent repeat discussions.

## Required verdict format
Use strict contract. First line must be exactly `VERDICT: READY` or `VERDICT: NOT_READY`.
