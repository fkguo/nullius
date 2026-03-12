# Orchestrator MCP Tools Architecture Specification

> **Status**: Phase 0 deliverable (NEW-R15-spec)
> **Created**: 2026-02-24
> **Scope**: Defines the MCP tool surface for `@autoresearch/orchestrator`, boundary rules between run-infrastructure and strategy orchestration, threat model, and approval gate design.

---

## 1. Tool Surface Definition

### 1.1 Namespace Strategy

| Namespace | Owner | Scope |
|---|---|---|
| `orch_run_*` | `@autoresearch/orchestrator` | Run lifecycle management (create, status, approve, reject, pause, resume, export) |
| `hep_run_*` | `@autoresearch/hep-mcp` | Evidence-first research artifacts (build, query, write, render) |
| `hep_project_*` | `@autoresearch/hep-mcp` | Project-level operations |
| `inspire_*` | `@autoresearch/hep-mcp` | INSPIRE network queries |
| `pdg_*` | `@autoresearch/pdg-mcp` | PDG offline lookups |
| `zotero_*` | `@autoresearch/zotero-mcp` | Zotero Local API |

**Rule**: `orch_run_*` tools manage run lifecycle state (state.json, ledger.jsonl, approvals). `hep_run_*` tools manage research artifacts within a run. An agent must use `orch_run_create` to obtain a `run_id` before calling any `hep_run_*` tool.

### 1.2 `orch_run_*` Tool Catalog

| Tool | Risk Level | Description |
|---|---|---|
| `orch_run_create` | `write` | Create a new run under a project. Returns `run_id`. Writes `state.json` + `ledger.jsonl`. |
| `orch_run_status` | `read` | Read-only snapshot of run state, phase, pending approvals, branch info. |
| `orch_run_approve` | `destructive` | Approve a pending approval gate. Requires `_confirm: true` + `approval_id` + `approval_packet_sha256`. Subject to C-01 timeout/budget enforcement. |
| `orch_run_reject` | `destructive` | Reject a pending approval. Requires `_confirm: true`; pauses the run irreversibly for the current approval attempt. |
| `orch_run_pause` | `write` | Pause a running run. Preserves state for later resume. |
| `orch_run_resume` | `write` | Resume a paused run. Validates state consistency before resuming. |
| `orch_run_checkpoint` | `write` | Record a phase checkpoint. Enforces approval timeout/budget (C-01). |
| `orch_run_export` | `destructive` | Export run artifacts to a portable bundle. Requires `_confirm: true`. |
| `orch_run_request_approval` | `write` | Create a pending approval gate with timeout policy. |
| `orch_run_logs` | `read` | Tail the run ledger (last N events). |
| `orch_run_branch_list` | `read` | List branches in the current run. |
| `orch_run_branch_add` | `write` | Add a new exploration branch. |
| `orch_run_branch_switch` | `write` | Switch active branch. |

### 1.3 Tool Parameter Conventions

All `orch_run_*` tools share these common parameters:

```typescript
interface OrchRunToolParams {
  run_id: string;       // Required for all except orch_run_create
  project_id?: string;  // Required for orch_run_create
}
```

Approval-gated tools additionally require:

```typescript
interface ApprovalParams {
  approval_id: string;
  approval_packet_sha256: string;  // SHA-256 of the serialized approval packet
}
```

---

## 2. Run-Infra vs Strategy Orchestration Boundary

### 2.1 Boundary Definition

| Layer | Responsibility | Implemented By |
|---|---|---|
| **Run-Infra** | State machine transitions, ledger writes, approval gates, timeout enforcement, branch management, artifact registry | `@autoresearch/orchestrator` (`orch_run_*`) |
| **Strategy Orchestration** | Workflow sequencing (如 `ingest → reproduce → revision → computation` 等语义 DAG)、evidence retrieval、section writing、review loops、quality gates | Agent (Claude/Gemini) using `hep_run_*` tools |

### 2.2 Invariant Rules

1. **Run-infra never calls domain tools.** The orchestrator never invokes `inspire_search`, `hep_run_build_writing_evidence`, or any research-domain tool. It only manages lifecycle.

2. **Strategy never bypasses run-infra.** An agent must not write to `state.json` or `ledger.jsonl` directly. All state transitions go through `orch_run_*` tools.

3. **Approval gates are run-infra.** Even when an approval gate is triggered by a strategy decision (e.g., "outline ready for review"), the gate mechanism (timeout, budget, escalation) is managed by run-infra.

4. **Evidence artifacts are strategy-scoped.** `hep_run_*` writes evidence catalogs, embeddings, section drafts — these are domain artifacts. Run-infra only tracks their existence in the artifact registry, never interprets their content.

5. **Run-infra is workflow-agnostic.** The orchestrator does not encode any fixed `ingest → reproduce → revision → computation` sequence. It provides generic phases, branches, and checkpoints. The workflow DAG is defined in run cards and interpreted by the agent.

### 2.3 Interaction Diagram

```
Agent (Claude/Gemini)
  │
  ├──► orch_run_create(project_id)         → run_id
  ├──► orch_run_status(run_id)             → state snapshot
  ├──► hep_run_build_writing_evidence(...)  → evidence artifacts
  ├──► hep_run_writing_create_outline_*(...)→ outline artifacts
  ├──► orch_run_checkpoint(run_id)          → checkpoint recorded
  ├──► orch_run_request_approval(run_id, ...) → pending approval
  │        (human reviews)
  ├──► orch_run_approve(run_id, approval_id, sha256)
  ├──► hep_run_writing_create_section_*(...)→ section artifacts
  ├──► orch_run_export(run_id, _confirm)   → bundle
  └──► orch_run_status(run_id)             → completed
```

---

## 3. Threat Model

### 3.1 Agent Self-Approval

**Threat**: An agent approves its own work without human review.

**Mitigations**:
- C-01 `budgets.max_approvals` budget limits total approvals per run.
- C-01 `timeout_at` enforces time-bounded approval windows.
- `on_timeout` policy defaults to `"block"` (fail-closed), not `"approve"`.
- Ledger records all approval events for audit trail.
- `approval_packet_sha256` (Stage 2): will tie approval to a specific content hash. *Not yet implemented in Python CLI; TS skeleton provides `approvalPacketSha256()` for forward compatibility.*

**Residual risk**: An agent with MCP tool access can technically call `orch_run_approve`. Defense is defense-in-depth: budget limits, timeout enforcement, and ledger audit trail enable post-hoc detection.

### 3.2 State Corruption

**Threat**: Concurrent agents or processes corrupt `state.json`.

**Mitigations**:
- File-level locking (`fcntl.flock` in Python, `proper-lockfile` in TS — *Stage 2*) on state reads/writes.
- Atomic write pattern: write to `.tmp` → `os.replace()` → cleanup on failure.
- `schema_version` field for format evolution; `state_version` counter for stale-write detection (*Stage 2*).
- `orch_run_status` reads are lock-free (snapshot isolation via atomic file reads).

**Residual risk**: Cross-platform lock semantics differ (NFS, networked drives). Mitigation: document that runs must reside on local filesystems.

### 3.3 Namespace Collision

**Threat**: `orch_run_*` and `hep_run_*` tools operate on the same `run_id` directory, potentially conflicting on file writes.

**Mitigations**:
- **Directory partitioning**: Run-infra owns `.autoresearch/state.json`, `.autoresearch/ledger.jsonl`. Approval packets go in `artifacts/runs/<run_id>/approvals/<approval_id>/packet.md`. Research artifacts go in `artifacts/runs/<run_id>/`.
- **Naming convention**: Run-infra state is under `.autoresearch/`. Research artifacts use prefixed names (`writing_outline_v2.json`, `latex_evidence_catalog.jsonl`).
- **Manifest separation**: Run-infra state is in `.autoresearch/state.json`. Artifact registry is in `manifest.json` (owned by `hep_run_*`).

### 3.4 Unauthorized Destructive Operations

**Threat**: Agent calls `orch_run_export` (destructive) without human consent.

**Mitigations**:
- H-11a risk level: `destructive` tools require `_confirm: true` parameter.
- Without `_confirm`, the tool returns a confirmation prompt describing what will happen, not the result.
- `orch_run_export` additionally checks that all pending approvals are resolved before export.

### 3.5 Approval Timeout Bypass

**Threat**: Agent ignores `timeout_at` and continues operating on a timed-out approval.

**Mitigations**:
- C-01 enforcement: `orch_run_checkpoint` and `orch_run_approve` check timeout before proceeding.
- On timeout, state transitions to `blocked`/`rejected`/`needs_recovery` per `on_timeout` policy.
- Once blocked, no `orch_run_*` write operations succeed until human intervention.

---

## 4. Approval Gate Design (H-11a Integration)

### 4.1 Approval Flow

```
orch_run_request_approval(run_id, {
  gate_id: "outline_review",
  scope: "writing.phase_outline",
  approval_packet: { ... },       // serialized content for review
  timeout_minutes: 1440,          // 24 hours
  on_timeout: "block",            // block | reject | escalate
})
  → pending_approval: {
      approval_id: "apr_...",
      approval_packet_sha256: "abc123...",
      timeout_at: "2026-02-25T03:00:00Z",
      on_timeout: "block",
    }

orch_run_approve(run_id, {
  approval_id: "apr_...",
  approval_packet_sha256: "abc123...",
})
  → state: "running"  (approval cleared)
```

### 4.2 Approval Packet Schema

```typescript
interface ApprovalPacket {
  gate_id: string;
  scope: string;                    // phase/section identifier
  content_summary: string;          // human-readable summary
  artifact_refs: string[];          // URIs to artifacts for review
  sha256: string;                   // SHA-256 of canonical JSON serialization
}
```

### 4.3 Approval Budget (C-01)

Configured in `approval_policy.schema.json` under `budgets`:

```json
{
  "schema_version": 1,
  "mode": "safe",
  "budgets": {
    "max_network_calls": 200,
    "max_runtime_minutes": 60,
    "max_approvals": 10
  },
  "timeouts": {
    "mass_search": { "timeout_seconds": 86400, "on_timeout": "block" }
  }
}
```

- `budgets.max_approvals: 0` means unlimited (default).
- Budget is counted per run, across all gates.
- When budget is exhausted, run transitions to `blocked` with ledger event `approval_budget_exhausted`.

---

## 5. URI Scheme

### 5.1 `orch://` URI Scheme

```
orch://runs/<run_id>                      → run root
orch://runs/<run_id>/state                → state.json
orch://runs/<run_id>/ledger               → ledger.jsonl
orch://runs/<run_id>/approvals/<id>       → approval record
```

### 5.2 Relationship with `hep://`

```
hep://projects/<project_id>               → project root (owned by hep-mcp)
hep://runs/<run_id>                       → run artifacts (owned by hep-mcp)
orch://runs/<run_id>                      → run lifecycle (owned by orchestrator)
```

**Rule**: `hep://runs/<run_id>` and `orch://runs/<run_id>` refer to the same filesystem directory but different logical scopes. `hep://` addresses research artifacts. `orch://` addresses lifecycle state.

**Resolution**: Both URI schemes resolve to `<HEP_DATA_DIR>/projects/<project_id>/runs/<run_id>/`. The orchestrator and hep-mcp share the same filesystem root but operate on disjoint file sets.

---

## 6. Compatibility with Python Orchestrator

During the migration period (NEW-05a Stages 1-2), both the Python `orchestrator_cli.py` and TS `@autoresearch/orchestrator` may operate on the same run directory.

### 6.1 Compatibility Rules

1. `state.json` format is shared. Both implementations read/write the same schema.
2. `ledger.jsonl` format is shared. Both implementations append events in the same format.
3. File locking must be cross-process compatible (`fcntl.flock` in Python, `proper-lockfile` in TS).
4. The TS orchestrator must not introduce new state fields without updating the Python reader (or vice versa).
5. During Stage 1, the TS orchestrator is read-only for state operations (can read state, write ledger events, but delegates state mutations to Python CLI).

### 6.2 Migration Path

| Stage | TS Orchestrator Capability | Python CLI Status |
|---|---|---|
| Stage 1 | Read state, write ledger, MCP client | Primary |
| Stage 2 | Full state management, approval gates | Gradually deprecated |
| Stage 3+ | Primary orchestrator | Retired |
