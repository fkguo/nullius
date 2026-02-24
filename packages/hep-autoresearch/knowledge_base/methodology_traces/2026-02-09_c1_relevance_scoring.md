# Methodology Trace

Purpose:
- Record the **Phase C1 seed-selection decision** for `hepar literature-gap`: maximize research quality by avoiding any deterministic keyword-based "relevance scoring" fallback.
- Define the auditable SSOT contract for external (human/LLM) relevance judgment via `seed_selection.json`.

## Metadata

- Date: 2026-02-09
- Tag (milestone/round): M81
- Mode/Profile: toolkit_extraction
- Owner: fkg
- Scope:
  - In scope: candidate extraction + seed-selection contract + fail-fast gating.
  - Out of scope: implementing tool-internal LLM reranking (future optional extension).

## Problem statement (what we are trying to compute/decide)

- Input: `inspire_field_survey` output + a topic/focus.
- Output: a *short* seed set (`recids`) to drive the deeper analysis phase (topic analysis / critical research / network analysis).
- Primary requirement: **quality-first semantic relevance**, not keyword overlap.
- Secondary requirement: make the relevance decision **auditable and resumable** (SSOT file + hash; rerunnable analysis without repeating discovery).

## Candidate methods (compare before implementing)

| Candidate | Pros | Cons / Risks | Decision |
|---|---|---|---|
| A. Deterministic lexical overlap + citation/recency bonuses | CI-friendly; explainable; stable | **Not semantic**; susceptible to "keyword drift" (high false positives) | rejected |
| B. Tool-internal rerank (LLM-as-judge / cross-encoder) | Single atomic call; tool can expose scores/reasons | Requires LLM backend + prompt surface inside the tool; larger failure surface; harder to keep full research context | defer (optional future) |
| C. External seed selection by the calling agent (human/LLM), recorded as SSOT | **Highest quality** (full context available); failure-isolated; resumable; selection rationale explicit | Non-deterministic; needs a contract + validation gate | selected |

## Decision (chosen approach)

- Chosen method: **C**.
- Core design: split Phase C1 into:
  - `discover`: fetch candidates + write `candidates.json` (no ranking implied)
  - `analyze`: consume `seed_selection.json` (external) + run deeper MCP analyses
- Hard gate: **no deterministic fallback** for relevance ranking inside `hepar` (if `seed_selection.json` missing/invalid → fail-fast).

### `seed_selection.json` contract (schema_version=1)

Required:
- `schema_version: 1`
- `selection_logic`: non-empty string
- `items[]`:
  - `recid`: non-empty string
  - `reason_for_inclusion`: non-empty string

Consistency rule (default):
- Each `recid` must exist in `candidates.json` from `discover` (reject otherwise; override only with `--allow-external-seeds`).

## Implementation notes

- Code:
  - Candidate extraction (schema-flexible): [orchestrator_cli.py](../../src/hep_autoresearch/orchestrator_cli.py) (`_c1_extract_field_survey_candidates`)
  - CLI entrypoint: [orchestrator_cli.py](../../src/hep_autoresearch/orchestrator_cli.py) (`cmd_literature_gap`)
- Artifacts:
  - `artifacts/runs/<TAG>/literature_gap/discover/`:
    - `candidates.json`, `field_survey.json`, and the artifact triple + `report.md`
  - `artifacts/runs/<TAG>/literature_gap/analyze/`:
    - `seed_selection.json` (copied in) + `topic_analysis.json`/`critical_research.json`/`network_analysis.json`
- Regression strategy (offline):
  - Stub MCP server: [mcp_stub_server.py](../../tests/mcp_stub_server.py)
  - CLI tests validate the two-phase contract + fail-fast gates: [test_literature_gap_cli.py](../../tests/test_literature_gap_cli.py)

## Limitations / future work

- Non-determinism: external seed selection can vary. Mitigation: SSOT (`seed_selection.json`) + SHA256 recorded in `gap_report.json`.
- Future optional enhancement (quality-first, approval-gated):
  - Provide a helper that generates `seed_selection.json` via LLM, *still* writing SSOT + rationale + allowing human edits before `analyze`.

