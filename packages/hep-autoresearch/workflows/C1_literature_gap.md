# C1_literature_gap (Phase C1)

Goal: produce an evidence-first, auditable INSPIRE discovery bundle via MCP, split into two phases:

- **discover**: fetch a wide candidate set (no relevance decisions)
- **analyze**: run deeper analysis on a *chosen* seed set

Key principle: **relevance ranking / seed selection is external (human/LLM) and must be recorded** in `seed_selection.json`.
This workflow intentionally provides **no deterministic relevance fallback**.

## Inputs

Common:
- `--tag`: run tag used for artifact output paths (e.g. `M73-r1`)
- MCP config:
  - `.mcp.json` (ignored by git) with a server entry (default name: `hep-research`)
  - Optional: `--mcp-config`, `--mcp-server`, `--hep-data-dir`

Phase: **discover** (default):
- `--phase discover`
- `--topic` (required)
- Optional knobs:
  - `--focus` (repeatable): focus keywords passed to `inspire_field_survey`
  - `--seed-recid`: optional INSPIRE seed recid passed to `inspire_field_survey` (crawl hint only; *not* seed selection for analyze)
  - `--iterations`, `--max-papers`, `--prefer-journal`

Phase: **analyze**:
- `--phase analyze`
- `--seed-selection <PATH>` (required): the external seed selection manifest
- Optional knobs:
  - `--topic`: optional (will be inferred from `candidates.json#/inputs/topic` when omitted)
  - `--candidates <PATH>`: optional override for `candidates.json`
  - `--max-recids`: cap how many recids from `seed_selection.json` are used
  - `--allow-external-seeds`: allow recids not present in `candidates.json` (default: refuse)
  - `--allow-external-inputs`: allow seed/candidates paths outside the project root (default: refuse)
  - `--topic-mode`, `--topic-limit`, `--topic-granularity`
  - `--critical-mode`
  - `--network-mode`, `--network-limit`, `--network-depth`, `--network-direction`

Required MCP tools on the server:
- discover: `inspire_field_survey`
- analyze: `inspire_topic_analysis`, `inspire_critical_research`, `inspire_network_analysis`

## Outputs (artifacts)

Writes to:
- `artifacts/runs/<TAG>/literature_gap/discover/`
- `artifacts/runs/<TAG>/literature_gap/analyze/`

Both phases write the artifact triple:
- `manifest.json` / `summary.json` / `analysis.json`
- `gap_report.json` (structured SSOT summary + action log)
- `report.md` (deterministic view derived from SSOT JSON)

Phase: **discover** also writes:
- `field_survey.json` (raw MCP tool output)
- `candidates.json` (deduped candidate list; *no ranking implied*)

Phase: **analyze** also writes:
- `seed_selection.json` (copied into the artifact dir; SHA256 recorded in `gap_report.json`)
- `topic_analysis.json` / `critical_research.json` / `network_analysis.json` (raw MCP tool outputs)

## `seed_selection.json` contract (schema_version=1)

Required:
- `schema_version`: `1`
- `selection_logic`: non-empty string (how the selector judged relevance)
- `items`: non-empty list of:
  - `recid`: non-empty string
  - `reason_for_inclusion`: non-empty string

Consistency gate (default):
- Every `recid` must exist in `candidates.json` from `discover` (refuse to continue otherwise).
- Override only with `--allow-external-seeds` (still logged as a warning).

## Gates / acceptance

- Exit codes:
  - `0`: completed without recorded errors
  - `2`: completed but recorded errors (artifacts still written)
  - nonzero (other): missing config / tool missing / fatal exception
- Offline regression:
  - `tests/mcp_stub_server.py` implements deterministic `inspire_*` tools
  - `tests/test_literature_gap_cli.py` validates the CLI and artifact output contract

## MVP scope (v1)

- Deterministic MCP orchestration only (no internal LLM calls).
- Candidate extraction is schema-flexible and best-effort.
- **No deterministic relevance scoring** inside the tool.
- Seed selection is external and must be auditable (`seed_selection.json`).

## Extension roadmap

- Optional *approval-gated* helper to generate `seed_selection.json` via LLM (still writing SSOT + hash, resumable).
- Optional prompt-packet emitter for downstream LLM analysis (keeping SSOT JSON as the source of truth).
- Add an eval case under `evals/` to validate artifact schema + required fields for literature-gap runs.

## Example commands

Discover candidates:

```bash
PYTHONPATH=src python3 -m hep_autoresearch.orchestrator_cli --project-root . \
  literature-gap \
  --phase discover \
  --tag M73-r1 \
  --topic "lattice QCD dibaryons" \
  --iterations 2 \
  --max-papers 40
```

Create `seed_selection.json` (external: human/LLM), then analyze:

```bash
PYTHONPATH=src python3 -m hep_autoresearch.orchestrator_cli --project-root . \
  literature-gap \
  --phase analyze \
  --tag M73-r1 \
  --seed-selection seed_selection.json \
  --max-recids 12 \
  --topic-mode timeline \
  --critical-mode analysis \
  --network-mode citation
```
