# TOOLKIT_API.md

Goal: split the “research agent platform” into reusable, testable, replaceable modules. This file defines the v0 API boundaries (interface contracts); implementation lives in `src/` (or a future `toolkit/` package).

## 0) Design constraints (SSOT)

- Evidence-first: every core output must point to artifacts or a checkable derivation.
- Reproducibility: each run writes the `manifest/summary/analysis` triple (see `docs/ARTIFACT_CONTRACT.md` and `specs/`).
- Model-agnostic: do not bind to a single LLM; the Orchestrator depends only on “role interfaces” and “tool interfaces”.

## 1) Module layout (v0)

### A. `ingest` (W1)

Responsibilities:
- input (recid/arXiv/DOI/query) → stable anchor → references snapshot → reading note (RefKey-templated)

Draft interfaces:
- `ingest.resolve_anchor(input) -> {kind, id, urls, texkey?}`
- `ingest.fetch_source(anchor, prefer="latex") -> references/<anchor>/...`
- `ingest.write_reading_note(anchor, refkey, out_path) -> path`

### B. `artifacts` (unified on-disk contracts)

Responsibilities:
- generic utilities to write/validate `manifest/summary/analysis`

Draft interfaces:
- `artifacts.write_manifest(run_ctx, outputs, extra={})`
- `artifacts.validate_manifest(path, schema=specs/artifact_manifest.schema.json)`

### C. `evals`

Responsibilities:
- read `evals/cases/*/case.json` and run acceptance checkers (start with static checks: required_paths/required_fields)

Draft interfaces:
- `evals.load_case(path) -> case`
- `evals.check_case(case, project_root) -> pass/fail + report`

### D. `orchestrator`

Responsibilities:
- planning/routing/run state management/gate triggering/archiving and rollback

Draft interfaces:
- `orchestrator.run(workflow_id, inputs, policy) -> run_result`
- `orchestrator.resume(run_id) -> run_result`

### E. `gates`

Responsibilities:
- composable gates: link hygiene / references / compile / evidence / convergence / schema validation

Draft interfaces:
- `gates.run_all(run_ctx, targets) -> report`

### F. `roles`

Responsibilities:
- treat Planner/Executor/Reviewer (and Researcher/Writer/Checker) as first-class abstractions, supporting:
  - pluggable runners (Codex/Claude/Gemini/local models)
  - context isolation and permission isolation (especially Reviewer)

Draft interfaces:
- `roles.run(role_id, task_packet, policy) -> role_output`

### G. `memory`

Responsibilities:
- L1 evolution: persist each run into reusable assets (KB/trace/run ledger/error bank)

Draft interfaces:
- `memory.append_trace(kind, payload, out_path) -> path`
- `memory.index_runs(out_dir=team/trajectory_index.json) -> path`

### H. `policies`

Responsibilities:
- configure approval gates, budgets, network scope, and gate strength as policies (see `specs/approval_policy.schema.json`).

Draft interfaces:
- `policies.load_approval_policy(path) -> policy`
- `policies.should_pause(action_kind, policy) -> bool`

## 2) Version strategy (suggested)

- v0: only promise W1 ingestion + eval static checker (reliability engineering bootstrap)
- v1: add W3 revision loop (LaTeX compilable + diff + citation/evidence gates)
- v2: add W2 reproduce (toy first, then real papers)
