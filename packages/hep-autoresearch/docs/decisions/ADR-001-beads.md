# ADR-001: Beads (bd) evaluation — do not integrate

Status: **ACCEPTED**  
Date: **2026-02-05**  
Decision owner: **hep-autoresearch maintainers**

## Context

We evaluated **Beads** (`bd`) as a potential addition to the `hep-autoresearch` ecosystem.

Beads positions itself as a **distributed, git-backed, dependency-aware graph issue tracker for AI agents**, providing persistent task memory via:
- per-project SQLite cache + git-tracked JSONL export (`.beads/issues.jsonl`)
- an optional per-project daemon (`.beads/bd.sock`) and optional MCP server (`beads-mcp`)
- workflow helpers like “ready work” (`bd ready`) and task compaction (“memory decay”)

Our project already has a workflow-specific state model:
- Plan SSOT: `specs/plan.schema.json` bound into `.autopilot/state.json`
- Append-only ledger: `.autopilot/ledger.jsonl`
- Evidence-first artifacts: `artifacts/runs/<tag>/...` with manifest/summary/analysis
- Approval gates (A1–A5) and dual review convergence before commits

## Decision

We **do not integrate Beads** into `hep-autoresearch`:
- no runtime dependency on `bd` / `beads-mcp`
- no repository-level adoption of `.beads/` as an additional SSOT
- **no optional export/bridge** (read-only or otherwise) between our Plan/ledger and Beads

Maintainers may still use Beads **personally** for generic project management, but it is **out of scope** for this repo’s workflow contract and must not become a required setup step for users.

## Rationale

1. **Competing SSOTs**: Beads would introduce a second task-state SSOT (SQLite/JSONL) that conflicts with our Plan/ledger SSOT designed around run provenance, approvals, and artifacts.
2. **Daemon + auto-sync mismatch**: Beads’ daemon/auto-sync model adds additional background state and potential auto-commit behaviors that are orthogonal to (and can conflict with) our “dual review then commit” gate.
3. **Workflow mismatch**: `hep-autoresearch` is run/evidence-centric (workflows, approvals, artifacts), while Beads is issue-centric (generic epics/tasks). Mapping semantics both ways is non-trivial and would be a long-term maintenance burden.
4. **Security/safety surface area**: adding another daemon + MCP surface expands operational complexity without clear incremental value for our current roadmap.

## Consequences

- We continue to evolve the existing Plan/ledger contracts as the only task-state SSOT.
- If we need Beads-like capabilities (dependency graphs, “ready” detection, compaction), we implement them **inside** our Plan/ledger/approval model with eval coverage.
- Documentation should not instruct users to install Beads for `hep-autoresearch`.

## Alternatives considered

- **Full integration** (Beads as project task tracker + MCP): rejected (SSOT and workflow mismatch).
- **Optional read-only bridge/export**: explicitly rejected by decision (avoid SSOT ambiguity and integration drift).

## References

- [Beads repository — steveyegge/beads](https://github.com/steveyegge/beads) (reviewed at commit `c96e62e6b59cc82a1ee244a98ff450d9ec294d9`)
