# Idea-Runs Integration Contract

Status: active

## Scope

This contract defines the observable integration surface for idea handoff ingestion via `hep_run_create_from_idea` in `@autoresearch/hep-mcp`.

The contract is intentionally aligned with the current implementation in `packages/hep-mcp/src/tools/create-from-idea.ts` and `packages/hep-mcp/src/core/runs.ts`.

## 1) Artifact Naming and Path Constraints

### Required run artifacts

After a successful `hep_run_create_from_idea` call, the created run MUST include:

- `args_snapshot.json`
- `outline_seed_v1.json`

### Naming constraints

- The outline seed artifact name is fixed: `outline_seed_v1.json`.
- The run args snapshot artifact name is fixed by run creation contract: `args_snapshot.json`.
- Tool clients should treat these names as stable contract identifiers.

### Path constraints

For run `<run_id>` under `HEP_DATA_DIR`, artifacts MUST resolve to:

- `<HEP_DATA_DIR>/runs/<run_id>/artifacts/args_snapshot.json`
- `<HEP_DATA_DIR>/runs/<run_id>/artifacts/outline_seed_v1.json`

Returned URIs MUST follow:

- `manifest_uri = hep://runs/<run_id>/manifest`
- `outline_seed_uri = hep://runs/<run_id>/artifact/outline_seed_v1.json`

`handoff_uri` input path constraints:

- `hep://runs/<run_id>/artifact/<artifact_name>` is allowed.
- Absolute/relative file paths are allowed only when they resolve inside `HEP_DATA_DIR` (containment enforced).

## 2) Idea Handoff -> Run Seed Mapping

`outline_seed_v1.json` MUST be produced with the following field mapping:

- `idea_card.thesis_statement` -> `outline_seed_v1.thesis`
- `idea_card.claims` -> `outline_seed_v1.claims`
- `idea_card.testable_hypotheses` -> `outline_seed_v1.hypotheses`
- `handoff_uri` (input) -> `outline_seed_v1.source_handoff_uri`

Validation requirements enforced by tool:

- `idea_card` must exist and be object-like.
- `thesis_statement` must be non-empty string.
- `claims` must be non-empty array.
- `testable_hypotheses` must be array of strings.

## 3) Cross-Reference Integrity

Successful output MUST satisfy:

- `run_id` equals the run id embedded in `manifest_uri`.
- `run_id` equals the run id embedded in `outline_seed_uri`.
- `outline_seed_v1.source_handoff_uri` equals the exact input `handoff_uri` (no canonicalization rewrite).

Args snapshot provenance MUST satisfy:

- `args_snapshot.json.args_snapshot.source = "create_from_idea"`
- `args_snapshot.json.args_snapshot.handoff_uri = <input handoff_uri>`
- `run_label` is included only when provided by caller.

## 4) Compatibility Notes

- This contract is fail-fast and does not provide backward-compatible aliases.
- If these artifact names or URI patterns change, contract tests under `packages/hep-mcp/tests/contracts/` must be updated in the same change.
