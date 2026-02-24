# Methodology Trace

Purpose:
- Extend Phase C2 (`hepar method-design`) with a **runtime** PDG query template (`pdg_runtime`) to complement the design-time snapshot (`pdg_snapshot`).
- Preserve an auditable contract that binds compute runs to PDG locators/versions when needed.

## Metadata

- Date: 2026-02-09
- Tag (milestone/round): M82
- Mode/Profile: toolkit_extraction
- Owner: fkg

## Problem statement

- `pdg_snapshot` (design-time) is great for reproducibility when you want the compute run to be self-contained.
- Some workflows want PDG access to be part of the compute DAG itself (e.g., to record the PDG locator/edition used at runtime, or to share a method DAG that queries PDG as an explicit step).

## Decision

- Add `pdg_runtime` template:
  - Generates a W_compute project with a phase that calls MCP `pdg_get_property` at runtime.
  - Writes `results/pdg_property.json` with:
    - query parameters (particle/property/allow_derived)
    - raw tool response (includes `locator` when available)
    - action log (initialize + tool call)
- Keep generation deterministic:
  - `hepar method-design --template pdg_runtime` does not require a live MCP server.
  - Running the generated project requires a `.mcp.json` in the project directory (or overriding `mcp_config` parameter).

## Evidence / pointers

- Code:
  - [method_design.py](../../src/hep_autoresearch/toolkit/method_design.py) (`template == "pdg_runtime"`)
  - [orchestrator_cli.py](../../src/hep_autoresearch/orchestrator_cli.py) (`--template pdg_runtime` choice)
- Tests:
  - [test_method_design_cli.py](../../tests/test_method_design_cli.py) (`test_method_design_pdg_runtime_with_stub_mcp`)
- Workflow spec:
  - [C2_method_design](../../workflows/C2_method_design.md)

