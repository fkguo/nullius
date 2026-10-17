# Orchestrator MCP Tools Architecture Specification

> **Status**: live inventory sync for `main` on 2026-04-19
> **Scope**: exact `orch_*` tool surface, run-infra vs strategy boundary, approval/fleet semantics, and URI ownership.
> **Classification anchor**: this document is the `canonical_public` exact `orch_*` inventory surface referenced by `meta/front_door_authority_map_v1.json`; it does not own CLI command taxonomies.
> **Drift lock**: fail-closed ownership and inventory verification lives in `packages/orchestrator/tests/orchestrator-mcp-tools-spec.test.ts`.

---

## 1. Tool Surface Definition

### 1.1 Namespace Strategy

| Namespace | Owner | Scope |
|---|---|---|
| orchestrator run-tool family | `@nullius/orchestrator` | Project-root run lifecycle, approvals, export, and bounded agent runtime execution |
| orchestrator policy-tool family | `@nullius/orchestrator` | Read-only policy inspection for approval/operation gates |
| orchestrator fleet-tool family | `@nullius/orchestrator` | Queue and worker coordination for the per-project fleet substrate |
| `hep_inspire_*` / `hep_import_from_zotero` | `@nullius/hep-mcp` | Search exports and identifier mappings written into a caller-chosen `output_dir` inside the project; hep-mcp keeps no runs of its own |
| `inspire_*` / `hepdata_*` / `openalex_*` / `arxiv_*` | `@nullius/hep-mcp` (`inspire_*`); provider packages (`hepdata_*` / `openalex_*` / `arxiv_*`) | Network/data retrieval and literature analysis |
| `pdg_*` | `@nullius/pdg-mcp` | PDG offline lookups |
| `zotero_*` | `@nullius/zotero-mcp` | Zotero Local API integration |

**Rule**: `orch_*` owns lifecycle state, approvals, queueing, and orchestration policy. Domain/runtime content remains outside that namespace. An agent may correlate `orch_*` with `hep_*`, but must not treat research artifacts as lifecycle authority or lifecycle tools as evidence authority.

### 1.2 Exact Live `orch_*` Catalog

#### Run lifecycle / project-root authority

| Tool | Risk | Live responsibility |
|---|---|---|
| `orch_run_create` | `write` | Initialize or replay an orchestrator run in a project root |
| `orch_run_stage_idea` | `write` | Stage IdeaHandoffC2 artifacts into the run's own directory, `<project_root>/artifacts/runs/<run_id>` |
| `orch_run_stage_content` | `write` | Stage generic writing/review content into the run's own directory and return a `rep://runs/.../artifact/...` staging URI; loop-owned draft/review tasks may attach task-scoped provenance so completion and downstream review refresh can fail closed on missing outputs |
| `orch_run_plan_computation` | `write` | Compile staged idea artifacts into `execution_plan_v1.json` and a run-local `computation/manifest.json`, requiring a supplied `method_spec` with files and `run_card`; missing methods are refused before executable artifacts are written |
| `orch_run_execute_manifest` | `destructive` | Execute a run-local `computation_manifest_v1` from the run's own directory; when the A3 `compute_runs` gate is enabled by policy (default off) or an A3 approval is already pending or was granted, it first returns an approval request and runs only once that approval is granted |
| `orch_run_progress_followups` | `destructive` | Progress exactly one computation-generated follow-up through the generic delegated runtime surface; delegated idea/literature feedback and writer/reviewer continuation are live |
| `orch_run_record_proposal_decision` | `write` | Record one local operator decision for the current run's current repair/skill/optimize/innovate proposal and write proposal decision memory into `.nullius/proposal_decisions_v1.json` |
| `orch_run_record_verification` | `write` | Execute one checker under a runtime environment allowlist and record adjacent production snapshots plus the checker's request-bound self-reported matching observations; `passed` does not prove actual reads or complete dependencies |
| `orch_run_request_final_conclusions` | `write` | Evaluate exactly one canonical subject; current literal incomplete dependency closure makes A5 `unavailable` and creates no approval request |
| `orch_run_status` | `read` | Return the current run status from `.nullius/state.json`, including current-run `final_conclusions_v1`, `current_run_workflow_outputs`, the legacy-stable `resume_context`, the richer `recovery_context`, a thin project-level `project_recent_digest`, diagnostic-only `project_surface_drift` for stale scaffold/guidance and durable-project-truth warnings, the declared `execution_mode` plus the `decision_ledger` read model of `.nullius/decisions.jsonl` (conversational decisions with still-open questions; closing `resolves` and non-closing `relates`; `unrecognized_relations` for ignored malformed links whose records remain admitted; `normalized_kinds` for legacy/unknown string kinds retained under current `decided` semantics; `duplicate_ids` for ids the ledger carries on more than one line; `ambiguous_provisional_ids` for retained branch identities that are not one-to-one; and `unlanded_count` / bounded `unlanded_ids` for valid provisional identities awaiting trunk-side `nullius decision land`; existing durable `D<n>` entries remain valid without migration), and a plan view rebuilt from `state.json#/plan` when derived `plan.md` is missing or stale |
| `orch_run_list` | `read` | List recorded runs from the project ledger |
| `orch_run_approve` | `destructive` | Approve a pending gate with packet SHA verification; a generic A5 consumer exists for a future complete-closure path, but current validation bindings cannot create that pending A5 state |
| `orch_run_reject` | `destructive` | Reject a pending gate and pause the run |
| `orch_run_pause` | `write` | Pause the current run |
| `orch_run_resume` | `write` | Resume a paused run |
| `orch_run_approvals_list` | `read` | Inspect pending and historical approvals for a run |
| `orch_run_export` | `destructive` | Export run summary/artifact listing, including current-run `final_conclusions_v1`, `current_run_workflow_outputs`, `current_run_resume_context`, `current_run_recovery_context`, the same thin project-level `project_recent_digest` when readable, and diagnostic-only `project_surface_drift` |
| `orch_run_execute_agent` | `destructive` | Execute an orchestrator agent runtime with persisted checkpoints |

#### Policy surface

| Tool | Risk | Live responsibility |
|---|---|---|
| `orch_policy_query` | `read` | Read the current approval policy / precedent view for an operation |

#### Fleet queue / worker coordination

| Tool | Risk | Live responsibility |
|---|---|---|
| `orch_fleet_enqueue` | `write` | Enqueue a known run into the per-project fleet queue |
| `orch_fleet_claim` | `write` | Claim the next queued run or a specific queued run |
| `orch_fleet_adjudicate_stale_claim` | `write` | Manually settle a claimed queue item the operator judges stale (guarded by expected claim and owner ids and a required note) |
| `orch_fleet_reassign_claim` | `write` | Reassign a currently claimed queue item to a different worker |
| `orch_fleet_release` | `write` | Release or settle a claimed queue item |
| `orch_fleet_status` | `read` | Aggregate read-only fleet visibility across project roots |
| `orch_fleet_worker_poll` | `write` | Heartbeat a worker and claim the next queued run when capacity exists |
| `orch_fleet_worker_heartbeat` | `write` | Refresh worker liveness/resource-slot metadata |
| `orch_fleet_worker_set_claim_acceptance` | `write` | Toggle whether a worker may claim new queue items |
| `orch_fleet_worker_unregister` | `write` | Remove a drained worker after explicit shutdown and zero claims |

### 1.3 Parameter Conventions

Current live `orch_*` tools are keyed by the orchestration workspace, not by a separate logical project id.

```typescript
interface OrchProjectScopedParams {
  project_root: string; // absolute or tilde-prefixed path to the external project root
}
```

Run-scoped tools then add `run_id` when they target a known run. The exception is `orch_fleet_status`, which takes a list `project_roots` instead of `project_root`. Approval-resolution tools additionally require `approval_id`; `orch_run_approve` also requires the packet digest:

```typescript
interface ApprovalResolutionParams {
  approval_id: string;
  approval_packet_sha256?: string; // required by orch_run_approve only
}
```

Fleet tools operate on queue items and worker ids rather than on artifact ids or domain objects.

---

## 2. Run-Infra vs Strategy Boundary

### 2.1 Boundary Definition

| Layer | Responsibility | Implemented by |
|---|---|---|
| **Run-infra / control plane** | State transitions, approval gates, checkpointed agent runtime, project-root queueing, worker liveness, export summaries | `@nullius/orchestrator` via `orch_*` |
| **Strategy / domain execution** | Evidence retrieval, literature search exports, literature analysis, domain packs, measurement-tension checks | `hep_*`, `inspire_*`, `openalex_*`, `pdg_*`, `zotero_*`, etc. |

### 2.2 Invariants

1. `orch_*` is workflow-agnostic. It owns control-plane semantics, not domain DAG content.
2. Domain tools must not mutate `.nullius/state.json`, ledger state, queue state, or approval packets directly.
3. Approval resolution lives on `orch_run_status`, `orch_run_approvals_list`, `orch_run_approve`, and `orch_run_reject`; domain tools may trigger the need for a gate but do not own the gate state.
4. Fleet semantics live on the orchestrator fleet-tool family; they are not hidden behind domain packs or legacy Python shells.
5. `nullius` remains the generic front door for lifecycle / workflow-plan / bounded computation; `orch_*` is the MCP/operator counterpart of that control plane rather than a competing product identity.
6. The computation bridge tools (`orch_run_stage_idea`, `orch_run_stage_content`, `orch_run_plan_computation`, `orch_run_execute_manifest`, `orch_run_progress_followups`) admit `project_root` as every other front door does (canonical form, outside any nullius checkout) and require `run_dir` to be the run's own directory, `<project_root>/artifacts/runs/<run_id>`, where its approval packets, proposals and team state are kept by run id, so a run's records are never split between two directories. It may be spelled through an alias above the project root; a symbolic link below the project root is refused, and so is one anywhere in the run directory, including every entry directly under `computation/`; only entries nested below the method's own real workspace directories under `computation/` are left to the manifest checks at materialization and preparation. `handoff_path` (`orch_run_stage_idea`) must be absolute. The exception is per subdirectory: at admission the manifest may not exist yet, so every real subdirectory of `computation/` other than the runtime-managed ones is treated as method workspace there. Admission is a pathname check at call time, so it has a time-of-check window across the whole run directory: a link or special file placed anywhere in it after admission is not seen by the bridge tool that admitted the call. The manifest's declared paths are checked again at materialization and preparation, and that later check is what guards execution; later tool calls admit the run directory afresh.

### 2.3 Interaction Sketch

```
Agent / operator
  │
  ├──► orch_run_create(project_root, run_id)            → initialize / replay run
  ├──► orch_run_stage_idea(project_root, run_dir, handoff_path, ...) → stage idea artifacts into the run directory
  ├──► orch_run_stage_content(project_root, run_dir, content_type, ...) → stage generic writing/review artifacts
  ├──► orch_run_plan_computation(...)                   → compile staged idea into execution plan + run-local manifest
  ├──► orch_run_execute_manifest(...)                   → execute run-local computation manifest (after A3 approval when that gate is enabled)
  ├──► orch_run_progress_followups(...)                 → advance one feedback/literature or writing/review continuation
  ├──► orch_run_record_proposal_decision(...)           → record local decision memory for the current proposal
  ├──► orch_run_record_verification(...)                → record adjacent snapshots plus checker self-reported matching observations
  ├──► orch_run_request_final_conclusions(...)          → return A5 unavailable while dependency closure is incomplete
  ├──► orch_run_status(project_root)                    → lifecycle snapshot
  ├──► hep_inspire_* / inspire_* / arxiv_* ...         → strategy/domain work (file outputs into a caller-chosen output_dir inside the project root)
  ├──► orch_run_approvals_list(project_root, run_id)    → inspect pending gates
  ├──► orch_run_approve(...) or orch_run_reject(...)    → resolve approval
  ├──► orch_run_execute_agent(...)                      → bounded orchestrator runtime
  ├──► orch_fleet_enqueue(...) / orch_fleet_worker_poll(...) → queue-backed orchestration
  └──► orch_run_export(project_root, _confirm)          → portable summary/artifact listing
```

---

## 3. Threat Model

### 3.1 Agent self-approval

**Threat**: an agent resolves its own pending gate without meaningful human review.

**Mitigations**:
- `orch_run_approve` requires `_confirm: true`, `approval_id`, and `approval_packet_sha256`.
- `orch_run_status` and `orch_run_approvals_list` keep the pending gate visible before resolution.
- Approval budgets/timeouts remain policy-controlled and auditable in project-root state.
- `orch_policy_query` lets operators inspect whether an operation should require approval before execution.

### 3.2 State corruption

**Threat**: concurrent runtimes or tools corrupt orchestration state.

**Mitigations**:
- `orch_*` writes are constrained to the orchestration workspace rather than arbitrary domain artifact roots.
- State and ledger writes remain under `.nullius/`.
- `orch_run_status` changes no run state (it only refreshes the harness invocation marker) and can be used to verify recovery state after interruptions.
- `orch_run_execute_agent` persists run-scoped checkpoints instead of treating transient transcript state as the sole authority.

### 3.3 Queue misuse / stale claims

**Threat**: a worker disappears while holding a queue item, or an operator silently steals ownership.

**Mitigations**:
- `orch_fleet_worker_heartbeat` and `orch_fleet_worker_poll` keep worker liveness explicit; only poll renews claim leases.
- `orch_fleet_adjudicate_stale_claim` and `orch_fleet_reassign_claim` require expected claim/owner ids plus operator notes.
- `orch_fleet_release` is the explicit settlement surface; claims carry a lease (default 60 seconds), and `orch_fleet_worker_poll` renews the polling worker's own leases and requeues expired ones from any worker (ledger event `fleet_claim_auto_released`), so the only takeover without an operator note is lease expiry.

### 3.4 Unauthorized destructive operations

**Threat**: an agent executes destructive control-plane actions without operator intent.

**Mitigations**:
- `orch_run_approve`, `orch_run_reject`, `orch_run_export`, `orch_run_execute_manifest`, `orch_run_progress_followups`, and `orch_run_execute_agent` are destructive and require `_confirm: true`.
- The destructive surface is intentionally smaller than the full `orch_*` family; read/write semantics are explicit in the registry/tests.
- Fleet mutation surfaces are write-only rather than destructive, but still require explicit worker/queue identifiers and notes for sensitive transitions.

---

## 4. Approval and Fleet Semantics

### 4.1 Approval flow

Current live approval flow is intentionally split into creation, inspection, and resolution:

1. A run-scoped orchestrator write path produces a pending approval packet under the project root.
2. Operators inspect state via `orch_run_status` and `orch_run_approvals_list`.
3. Resolution happens via `orch_run_approve` or `orch_run_reject`.

For the higher-conclusion boundary:
- `orch_run_request_final_conclusions` currently supports exactly one canonical subject, verdict, and coverage artifact.
- Every current validation binding declares incomplete dependency/import closure, so the request returns `unavailable` and creates no pending A5 state.
- `orch_run_approve` retains a generic future complete-closure consumer, but it is not reachable from current validation bindings.
- `orch_run_status` / `orch_run_export` are the read surfaces for the current run's local outcome-facing `final_conclusions_v1` seam; no separate public read tool is introduced in this slice.

Current live approval producers are:
- `orch_run_plan_computation` and `orch_run_execute_manifest` for A3 compute execution (only when the `compute_runs` gate is enabled by policy (default off) or an A3 approval already exists for the run)

Tools that record local results and create no approval (the A5 request is listed last because it can create one in principle, but currently returns `unavailable`):
- `orch_run_record_proposal_decision` for local proposal lifecycle closure without a second approval family
- `orch_run_record_verification` for adjacent production snapshots, absolute declared external refs, runtime/checker identity, logs, and checker self-reported matching observations. A recorded pass does not prove actual output reads, negative-control execution, semantic independence, or complete dependencies.
- `orch_run_request_final_conclusions` for the exactly-one-subject A5 consumer, currently fail-closed as `unavailable` because dependency closure is literal incomplete

This keeps approval state on the control plane even when the underlying need for approval originated in computation, writing, or delegated runtime execution.

### 4.2 Fleet flow

The orchestrator fleet-tool family is the only live scheduler-facing surface:

1. enqueue a run with `orch_fleet_enqueue`
2. heartbeat or poll workers with `orch_fleet_worker_heartbeat` / `orch_fleet_worker_poll`
3. inspect aggregate truth with `orch_fleet_status`
4. settle edge cases with `orch_fleet_release`, `orch_fleet_adjudicate_stale_claim`, or `orch_fleet_reassign_claim`
5. drain workers with `orch_fleet_worker_set_claim_acceptance` + `orch_fleet_worker_unregister`

No domain pack should grow a second queue authority around the same project-root runs.

---

## 5. URI Ownership

### 5.1 `orch://` live emitted surface

```
orch://runs/<run_id>                → run lifecycle / read-model root
orch://runs/<run_id>/approvals/<id> → approval record pointer
orch://runs/<run_id>/artifact/<artifact_path> → run artifact pointer
orch://runs/export                  → export summary pointer
```

### 5.2 Relationship with `hep://`

```
orch://runs/<run_id>                → lifecycle / control-plane view
```

hep-mcp no longer creates `hep://` identifiers (`hep://runs/...` or `hep://projects/...`); historical ones are resolved by the reading rules in `docs/URI_REGISTRY.md`.

`hep://` and `orch://` are intentionally separate owned namespaces. Cross-scheme correlation must be carried explicitly by workflow metadata or operator context, not by implicit aliasing.

---

## 6. Compatibility and Migration Notes

1. The old “TS orchestrator is read-only Stage 1” framing is no longer live truth. `@nullius/orchestrator` already owns the current `orch_*` surface.
2. The provider-local Python parser package has been retired. Do not recreate provider-local Python control-plane authority.
3. Public documentation or review packets that need the current orchestrator MCP truth should point at this file plus the live tool registry/tests (`packages/orchestrator/src/orch-tools/index.ts`, `packages/orchestrator/tests/orchestrator-mcp-tools-spec.test.ts`) rather than older Stage 1/2 sketches.
