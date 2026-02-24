# W5-02 Review Packet (Round 001)

## Scope
Engineer a reusable failure library (negative results) with:
- structured storage (failed_approach records),
- reusable retrieval keys (tags + optional failure_modes),
- evidence refs,
- and an executable "avoid known dead ends" workflow hook (query config -> hits artifact) that can be gate-validated.

## Repositories + File Changes

### idea-generator
- Extended: `schemas/failed_approach_v1.schema.json`
  - adds optional `failure_modes[]` for multi-label retrieval
  - strengthens `tags[]` to be unique + documents key:value convention
- Added schemas:
  - `schemas/failure_library_query_v1.schema.json`
  - `schemas/failure_library_index_v1.schema.json`
  - `schemas/failure_library_hits_v1.schema.json`
- Added examples:
  - `docs/plans/examples/2026-02-15-w5-02-failure-library/*.example.json`
- Added validator:
  - `scripts/validate_w5_failure_library_schemas.py`
- Wired into `make validate`:
  - `Makefile` adds `check-w5-failure-library-schemas`

### idea-runs
- Added schema snapshots (for local validation inside run repo):
  - `schemas/failed_approach_v1.schema.json`
  - `schemas/failure_library_{query,index,hits}_v1.schema.json`
- Fixed existing negative-result sample to conform to schema:
  - `projects/expected-limitations-method-drift/artifacts/ideas/failed_approach_v1.jsonl`
- Added failure library tooling:
  - `scripts/build_failure_library_index.py` (scans `projects/*/artifacts/ideas/failed_approach_v1.jsonl` and writes `evidence/failure_library_index_v1.json`)
  - `scripts/run_failure_library_query.py` (project-local query hook)
  - `Makefile` targets: `build-failure-library-index`, `run-failure-library-query`
- Hook enforcement:
  - `scripts/validate_project_artifacts.py` now enforces: if `pipeline/failure_library_query_v1.json` exists, then the configured hits artifact must exist and validate.
- Pilot project updated to demonstrate hook end-to-end:
  - local failures: `projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/ideas/failed_approach_v1.jsonl`
  - query config: `projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/pipeline/failure_library_query_v1.json`
  - hits artifact: `projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/failure_library/failure_library_hits_v1.json`
  - updated `evidence/index.md` + `reports/draft.md` to reference the hook

## DoD Checklist (W5-02)
- [x] Failure records are structured, include evidence refs, and include reusable retrieval keys.
- [x] Failure library index can be built reproducibly and is schema-validated.
- [x] Query hook exists (config -> hits artifact) and is gate-validated.
- [x] At least one failure record exists and is discoverable via tags/failure_modes.
- [x] Validation commands pass and evidence is persisted.

## Verification Commands + Results
- `idea-generator`: `make validate` => PASS
- `idea-runs`: `make validate` => PASS
- `idea-runs`: `make build-failure-library-index` => PASS (writes `evidence/failure_library_index_v1.json`)
- `idea-runs`: `PROJECT=projects/pion-gff-bootstrap-positivity-pilot-2026-02-15 make run-failure-library-query` => PASS
- `idea-runs`: `PROJECT=projects/pion-gff-bootstrap-positivity-pilot-2026-02-15 make validate-project` => PASS (enforces hook output)

Evidence: `docs/reviews/bundles/2026-02-15-w5-02-validate-v1.txt`

## Evidence Paths
- Validation: `docs/reviews/bundles/2026-02-15-w5-02-validate-v1.txt`
- Examples: `docs/plans/examples/2026-02-15-w5-02-failure-library/`
- Failure library index output: `/home/user/Coding/Agents/Autoresearch/idea-runs/evidence/failure_library_index_v1.json`
- Pilot hook artifacts:
  - query config: `/home/user/Coding/Agents/Autoresearch/idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/pipeline/failure_library_query_v1.json`
  - hits: `/home/user/Coding/Agents/Autoresearch/idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/failure_library/failure_library_hits_v1.json`

## Risks / Review Focus
1. Genericity: ensure failure library doesn't bake in pion/GFF specifics; tags/keys should generalize.
2. Hook enforceability: ensure missing output fails validation when config is present.
3. Retrieval key discipline: ensure tags/failure_modes are sufficient and stable for reuse.
4. Evidence refs: ensure each failure record includes URIs that are meaningful and portable.

## Required verdict format
Use strict contract. First line must be exactly `VERDICT: READY` or `VERDICT: NOT_READY`.
