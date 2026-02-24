# Example — Pre-task Clarifier

Project: <PROJECT_NAME>  
Date: 2026-01-14  
Owner: leader

Chosen profile: `methodology_dev`

## 1) Minimal Q&A (example)

1. Question: upgrade `research-team` from documentation to executable scaffolding + deterministic gates, and keep it migratable to MCP tools later.
2. Comparable outputs: runnable scripts/gates; configurable profile; reproducible fixtures + smoke tests.
3. Evidence types: CLI scripts + deterministic gate outputs + passing smoke tests + reviewer reports.
4. Falsification: gates cannot produce fixable error messages; mechanisms are not profile-aware; cannot be mapped into tool schemas.
5. Key risks: being too strict and blocking real work; format/protocol drift prevents automation.
6. External inputs: none (do not integrate `hep-research-mcp` in this milestone).

## 2) Milestones (example)

### M0 — Mechanism templates landed
- Deliverables: `mechanisms/*.md`, scaffold scripts
- DoD: `smoke_test_*` passes
- Kill: if after one iteration we still cannot produce a minimal claim+evidence pair (reproducible) and the gate errors are not fixable, stop and narrow scope

### M1 — Claim DAG MVP
- Deliverables: `knowledge_graph/`, 3 gate scripts
- DoD: gates are configurable and errors are fixable
- Kill: if schema churn repeatedly breaks >=2 projects and versioning cannot converge, stop and simplify the interface

