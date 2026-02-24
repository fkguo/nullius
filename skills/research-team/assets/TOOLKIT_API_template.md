# TOOLKIT_API.md

Project: <PROJECT_NAME>
Last updated: <YYYY-MM-DD>

This document defines the reusable “toolkit” extracted from this research project.

Goals:
- Make reusable components explicit (APIs, modules, CLI entrypoints).
- Provide stable pointers to implementations (paths + function names).
- Record provenance: which milestones/claims required each tool.

Non-goals:
- This is not a full user manual; keep it concise and evidence-linked.

## 1) Scope

- What this toolkit covers:
- Out of scope:

## 2) API Surface

### 2.1 Modules / Files

- `toolkit/`: (fill; recommended for reusable code)
- `src/`: (fill; alternative for reusable code)
- `scripts/`: (fill; runnable entrypoints)

### 2.2 Public Functions (stable)

For each function, include:
- Signature
- Inputs/outputs (units/normalization if relevant)
- Deterministic test/proxy check
- Code pointer(s)

- `toolkit.<module>.<func>(...) -> ...`:
  - Purpose:
  - Inputs:
  - Outputs:
  - Proxy test:
  - Code pointers:

### 2.3 CLI Entry Points (reproducibility)

- `bash scripts/<entry>.sh ...`:
  - What it produces (artifact paths):
  - Key params:
  - Expected runtime:

## 3) Evidence & Provenance

For each extracted tool, link it to:
- milestone tag(s) (e.g. `M2-r3`)
- the notebook section / claim / methodology trace that motivated it

- Tool:
  - Used in: (fill; tags)
  - Notebook pointer:
  - Methodology trace:

## 4) Minimal Examples

- Example 1:
  - Command:
  - Expected outputs:

