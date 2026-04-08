# C1_literature_gap (Legacy Maintainer Fixture)

This file documents the surviving artifact contract for the old Phase C1 literature-gap flow after the internal parser command was deleted.
It is a maintainer/eval fixture contract and not a default product front door.

- Public/front-door authority:
  - `autoresearch workflow-plan --recipe literature_gap_analysis`
  - checked-in recipe authority stays in `packages/literature-workflows` / `meta/recipes/literature_gap_analysis.json`
- Legacy fixture usage in this file remains maintainer/eval/regression compatibility coverage only.
- Lower-level checked-in consumers that now prove the flow:
  - `packages/hep-autoresearch/src/hep_autoresearch/toolkit/literature_gap.py`
  - `packages/hep-autoresearch/tests/test_literature_gap_runner.py`
  - `packages/literature-workflows/tests/resolve.test.ts`
  - `packages/orchestrator/tests/autoresearch-cli.test.ts`
- Deleted surface:
  - the internal parser `literature-gap` command in `hep_autoresearch.orchestrator_cli`

## Preserved intent

The surviving runner-level flow still splits into two phases:

- `discover`: launcher-resolved seed search that writes a candidate bundle without deterministic relevance scoring
- `analyze`: bounded topic / critical / network / connection analysis over an externally selected seed set

Seed selection remains external and auditable through `seed_selection.json`. The runner intentionally keeps no deterministic relevance fallback.

## Inputs

Discover runner inputs:

- `tag`
- `topic`
- optional `focus[]`
- optional `seed_recid`
- optional MCP config overrides (`mcp_config`, `mcp_server`, `hep_data_dir`)

Analyze runner inputs:

- `tag`
- `seed_selection`
- optional `topic` (defaults from `candidates.json#/inputs/topic`)
- optional `candidates`
- optional `max_recids`
- optional `allow_external_seeds`
- optional `allow_external_inputs`
- topic/network analysis knobs

## Artifact contract

Discover writes:

- `artifacts/runs/<TAG>/literature_gap/discover/manifest.json`
- `artifacts/runs/<TAG>/literature_gap/discover/summary.json`
- `artifacts/runs/<TAG>/literature_gap/discover/analysis.json`
- `artifacts/runs/<TAG>/literature_gap/discover/gap_report.json`
- `artifacts/runs/<TAG>/literature_gap/discover/workflow_plan.json`
- `artifacts/runs/<TAG>/literature_gap/discover/seed_search.json`
- `artifacts/runs/<TAG>/literature_gap/discover/candidates.json`
- `artifacts/runs/<TAG>/literature_gap/discover/report.md`

Analyze writes:

- `artifacts/runs/<TAG>/literature_gap/analyze/manifest.json`
- `artifacts/runs/<TAG>/literature_gap/analyze/summary.json`
- `artifacts/runs/<TAG>/literature_gap/analyze/analysis.json`
- `artifacts/runs/<TAG>/literature_gap/analyze/gap_report.json`
- `artifacts/runs/<TAG>/literature_gap/analyze/workflow_plan.json`
- `artifacts/runs/<TAG>/literature_gap/analyze/topic_analysis.json`
- `artifacts/runs/<TAG>/literature_gap/analyze/critical_analysis.json`
- `artifacts/runs/<TAG>/literature_gap/analyze/network_analysis.json`
- `artifacts/runs/<TAG>/literature_gap/analyze/connection_scan.json`
- `artifacts/runs/<TAG>/literature_gap/analyze/seed_selection.json`
- `artifacts/runs/<TAG>/literature_gap/analyze/report.md`

## `seed_selection.json` contract

- `schema_version = 1`
- `selection_logic` must be a non-empty string
- `items[]` must include:
  - `recid`
  - `reason_for_inclusion`

Default consistency gate:

- every selected `recid` must already exist in `candidates.json`
- `allow_external_seeds` is the only override, and it is still recorded into the analysis outputs

## Executable proof

Primary regression proof now lives in tests instead of the parser shell:

```bash
PYTHONPYCACHEPREFIX=/tmp/pycache python3 -m pytest -q packages/hep-autoresearch/tests/test_literature_gap_runner.py packages/hep-autoresearch/tests/test_public_cli_surface.py
pnpm --filter @autoresearch/literature-workflows test -- tests/resolve.test.ts
pnpm --filter @autoresearch/orchestrator test -- tests/autoresearch-cli.test.ts
```
