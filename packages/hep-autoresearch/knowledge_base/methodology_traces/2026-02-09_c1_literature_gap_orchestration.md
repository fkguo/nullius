# Methodology Trace

Purpose:
- Record the design decision for Phase C1 (`hepar literature-gap`) as a **deterministic, testable MCP orchestration** workflow (no internal LLM calls).
- Preserve a reproducible evidence trail: what MCP tools were called, what artifacts were written, and the minimal offline regression strategy.

## Metadata

- Date: 2026-02-09
- Tag (milestone/round): M73
- Mode/Profile: toolkit_extraction
- Owner: fkg
- Scope:
  - In scope: deterministic orchestration of INSPIRE discovery/analysis via MCP tools + artifact contract.
  - Out of scope: LLM synthesis / question generation (separate workflows).

## Problem statement (what we are trying to compute/decide)

- Goal:
  - Given a topic string, run a stable discovery pass to collect a candidate set and then perform deeper structured analyses on a chosen seed set.
- Inputs:
  - Topic string + optional focus keywords (discover phase).
  - External seed selection manifest `seed_selection.json` (analyze phase).
  - MCP server config (`.mcp.json`) + deterministic environment scoping.
- Outputs:
  - Evidence-first artifact bundles under `artifacts/runs/<TAG>/literature_gap/{discover,analyze}/`.
- Constraints:
  - Deterministic runner: no LLM calls inside the command.
  - Must be testable offline (CI-safe) via a stub MCP server.
  - Avoid secret leakage: MCP subprocess env is allowlisted; do not forward full env.

## Candidate methods (compare before implementing)

| Candidate | Pros | Cons / Risks | Decision |
|---|---|---|---|
| A. Orchestrate INSPIRE workflows via MCP tools | Reuse stable tool contracts; consistent with platform architecture; keeps network access inside MCP process | MCP server availability required; output schemas may evolve | selected |
| B. Call INSPIRE REST directly from this repo | No MCP dependency | Duplicates network logic; higher drift risk; auth/snapshot policy lives here | rejected |

## Decision (chosen approach)

- Chosen method: A (MCP INSPIRE toolchain) with a deterministic CLI entrypoint.
- Split into two phases to keep relevance decisions auditable and failure-isolated:
  - `discover`: calls `inspire_field_survey` and writes `candidates.json` (no ranking implied)
  - `analyze`: consumes `seed_selection.json` (external SSOT) and calls:
    - `inspire_topic_analysis`
    - `inspire_critical_research`
    - `inspire_network_analysis`

## Execution log (what was run and what it produced)

| Step | Input | Output | Decision |
|---|---|---|---|
| 1 | `hepar literature-gap --phase discover --tag <TAG> --topic <TOPIC>` + local `.mcp.json` (not committed) | Artifacts under `artifacts/runs/<TAG>/literature_gap/discover/` (manifest/summary/analysis + gap_report.json + field_survey.json + candidates.json + report.md) | Deterministic orchestration; writes artifacts even if non-fatal errors occur |
| 2 | External selection (human/LLM): write `seed_selection.json` | `seed_selection.json` is SSOT for the relevance decision (logic + per-recid reasons) | No deterministic fallback inside the tool |
| 3 | `hepar literature-gap --phase analyze --tag <TAG> --seed-selection <PATH>` | Artifacts under `artifacts/runs/<TAG>/literature_gap/analyze/` (artifact triple + gap_report.json + seed_selection.json + topic/critical/network JSON + report.md) | Fail-fast if seed manifest is missing/invalid/inconsistent |
| 4 | `python3 -m unittest discover -s tests -p "test_*.py"` | Offline regression via [mcp_stub_server.py](../../tests/mcp_stub_server.py) | Keep tests stdlib-only; stub server returns stable JSON payloads |

## Reuse / extraction

- Reusable artifact(s):
  - Deterministic "INSPIRE discovery bundle" contract (`candidates.json` + raw tool outputs + artifact triple)
  - Deterministic "INSPIRE analysis bundle" contract (topic/critical/network outputs keyed by a pinned seed manifest)
- API surface:
  - Workflow spec: [C1_literature_gap](../../workflows/C1_literature_gap.md)

## Evidence

- Files:
  - [orchestrator_cli.py](../../src/hep_autoresearch/orchestrator_cli.py)
  - [mcp_stub_server.py](../../tests/mcp_stub_server.py)
  - [test_literature_gap_cli.py](../../tests/test_literature_gap_cli.py)
  - [C1_literature_gap](../../workflows/C1_literature_gap.md)
- Commands:
  - `python3 -m unittest discover -s tests -p "test_*.py"`

