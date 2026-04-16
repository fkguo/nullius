# Orchestrator MCP Tools Architecture Specification

> **Status**: live inventory sync for `main` on 2026-04-14
> **Scope**: exact `orch_*` tool surface, run-infra vs strategy boundary, approval/fleet semantics, and URI ownership.
> **Classification anchor**: this document is the `canonical_public` exact `orch_*` inventory surface referenced by `meta/front_door_authority_map_v1.json`; it does not own CLI command taxonomies.

---

## 1. Tool Surface Definition

### 1.1 Namespace Strategy

| Namespace | Owner | Scope |
|---|---|---|
| orchestrator run-tool family | `@autoresearch/orchestrator` | Project-root run lifecycle, approvals, export, and bounded agent runtime execution |
| orchestrator policy-tool family | `@autoresearch/orchestrator` | Read-only policy inspection for approval/operation gates |
| orchestrator fleet-tool family | `@autoresearch/orchestrator` | Queue and worker coordination for the per-project fleet substrate |
| `hep_run_*` | `@autoresearch/hep-mcp` | Evidence-first run artifacts and run-scoped research assets |
| `hep_project_*` | `@autoresearch/hep-mcp` | Project-level evidence/query/export operations |
| `inspire_*` / `hepdata_*` / `openalex_*` / `arxiv_*` | provider packages | Network/data retrieval and literature analysis |
| `pdg_*` | `@autoresearch/pdg-mcp` | PDG offline lookups |
| `zotero_*` | `@autoresearch/zotero-mcp` | Zotero Local API integration |

**Rule**: `orch_*` owns lifecycle state, approvals, queueing, and orchestration policy. Domain/runtime content remains outside that namespace. An agent may correlate `orch_*` with `hep_*`, but must not treat research artifacts as lifecycle authority or lifecycle tools as evidence authority.

### 1.2 Exact Live `orch_*` Catalog

#### Run lifecycle / project-root authority

| Tool | Risk | Live responsibility |
|---|---|---|
| `orch_run_create` | `write` | Initialize or replay an orchestrator run in a project root |
| `orch_run_stage_idea` | `write` | Stage IdeaHandoffC2 artifacts into an existing domain-owned run directory |
| `orch_run_stage_content` | `write` | Stage generic writing/review content into an existing run directory and return a `rep://runs/.../artifact/...` staging URI; loop-owned draft/review tasks may attach task-scoped provenance so completion and downstream review refresh can fail closed on missing outputs |
| `orch_run_plan_computation` | `write` | Compile staged idea artifacts into `execution_plan_v1.json` and a run-local `computation/manifest.json`, preferring provider-backed materialization when the staged surface carries an explicit method bundle |
| `orch_run_execute_manifest` | `destructive` | Execute an approved run-local `computation_manifest_v1` from an existing run directory |
| `orch_run_progress_followups` | `destructive` | Progress exactly one computation-generated follow-up through the generic delegated runtime surface; delegated idea/literature feedback and writer/reviewer continuation are live |
| `orch_run_record_proposal_decision` | `write` | Record one local operator decision for the current run's current repair/skill/optimize/innovate proposal and write proposal decision memory into `.autoresearch/proposal_decisions_v1.json` |
| `orch_run_record_verification` | `write` | Record one decisive verification result for an existing computation run, materializing `verification_check_run_v1` plus refreshed verdict/coverage/check-run refs |
| `orch_run_request_final_conclusions` | `write` | Evaluate canonical computation-result verification truth and create an A5 final-conclusions approval request only when higher-conclusion readiness is a decisive pass |
| `orch_run_status` | `read` | Return the current run status from `.autoresearch/state.json`, including current-run `final_conclusions_v1`, a thin project-level `project_recent_digest`, and a plan view rebuilt from `state.json#/plan` when derived `plan.md` is missing or stale |
| `orch_run_list` | `read` | List recorded runs from the project ledger |
| `orch_run_approve` | `destructive` | Approve a pending gate with packet SHA verification; A5 approvals consume into a local `final_conclusions_v1` artifact instead of resuming execution |
| `orch_run_reject` | `destructive` | Reject a pending gate and pause the run |
| `orch_run_pause` | `write` | Pause the current run |
| `orch_run_resume` | `write` | Resume a paused run |
| `orch_run_approvals_list` | `read` | Inspect pending and historical approvals for a run |
| `orch_run_export` | `destructive` | Export run summary/artifact listing, including current-run `final_conclusions_v1` summary and the same thin project-level `project_recent_digest` when readable |
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
| `orch_fleet_adjudicate_stale_claim` | `write` | Manually settle a stale claimed queue item |
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

Run-scoped tools then add `run_id` when they target a known run. Approval-resolution tools additionally require:

```typescript
interface ApprovalResolutionParams {
  approval_id: string;
  approval_packet_sha256: string;
}
```

Fleet tools operate on queue items and worker ids rather than on artifact ids or domain objects.

---

## 2. Run-Infra vs Strategy Boundary

### 2.1 Boundary Definition

| Layer | Responsibility | Implemented by |
|---|---|---|
| **Run-infra / control plane** | State transitions, approval gates, checkpointed agent runtime, project-root queueing, worker liveness, export summaries | `@autoresearch/orchestrator` via `orch_*` |
| **Strategy / domain execution** | Evidence retrieval, plan resolution, writing/export, literature analysis, domain packs, measurement extraction | `hep_*`, `inspire_*`, `openalex_*`, `pdg_*`, `zotero_*`, etc. |

### 2.2 Invariants

1. `orch_*` is workflow-agnostic. It owns control-plane semantics, not domain DAG content.
2. Domain tools must not mutate `.autoresearch/state.json`, ledger state, queue state, or approval packets directly.
3. Approval resolution lives on `orch_run_status`, `orch_run_approvals_list`, `orch_run_approve`, and `orch_run_reject`; domain tools may trigger the need for a gate but do not own the gate state.
4. Fleet semantics live on the orchestrator fleet-tool family; they are not hidden behind domain packs or legacy Python shells.
5. `autoresearch` remains the generic front door for lifecycle / workflow-plan / bounded computation; `orch_*` is the MCP/operator counterpart of that control plane rather than a competing product identity.

### 2.3 Interaction Sketch

```
Agent / operator
  │
  ├──► orch_run_create(project_root, run_id)            → initialize / replay run
  ├──► orch_run_stage_idea(run_dir, handoff_path, ...)  → stage provider-local idea artifacts
  ├──► orch_run_stage_content(run_dir, content_type, ...) → stage generic writing/review artifacts
  ├──► orch_run_plan_computation(...)                   → compile staged idea into execution plan + run-local manifest
  ├──► orch_run_execute_manifest(...)                   → execute approved run-local computation manifest
  ├──► orch_run_progress_followups(...)                 → advance one feedback/literature or writing/review continuation
  ├──► orch_run_record_proposal_decision(...)           → record local decision memory for the current proposal
  ├──► orch_run_record_verification(...)                → record decisive verification truth for the canonical computation result
  ├──► orch_run_request_final_conclusions(...)          → request A5 only when canonical verification truth decisively passes
  ├──► orch_run_status(project_root)                    → lifecycle snapshot
  ├──► hep_run_* / hep_project_* / inspire_* ...        → strategy/domain work
  ├──► orch_run_approvals_list(project_root, run_id)    → inspect pending gates
  ├──► orch_run_approve(...) or orch_run_reject(...)    → resolve approval
  ├──► orch_run_execute_agent(...)                      → bounded orchestrator runtime
  ├──► orch_fleet_enqueue(...) / orch_fleet_worker_poll(...) → queue-backed orchestration
  └──► orch_run_export(project_root)                    → portable summary/artifact listing
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
- State and ledger writes remain under `.autoresearch/`.
- `orch_run_status` is read-only and can be used to verify recovery state after interruptions.
- `orch_run_execute_agent` persists run-scoped checkpoints instead of treating transient transcript state as the sole authority.

### 3.3 Queue misuse / stale claims

**Threat**: a worker disappears while holding a queue item, or an operator silently steals ownership.

**Mitigations**:
- `orch_fleet_worker_heartbeat` and `orch_fleet_worker_poll` keep liveness explicit.
- `orch_fleet_adjudicate_stale_claim` and `orch_fleet_reassign_claim` require expected claim/owner ids plus operator notes.
- `orch_fleet_release` is the explicit settlement surface; the system does not assume silent takeover semantics.

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
- `orch_run_request_final_conclusions` only creates the pending A5 request.
- `orch_run_approve` consumes that A5 request into `artifacts/runs/<run_id>/final_conclusions_v1.json`, records `gate_satisfied.A5`, and leaves the run `completed`.
- `orch_run_status` / `orch_run_export` are the read surfaces for the current run's local outcome-facing `final_conclusions_v1` seam; no separate public read tool is introduced in this slice.

Current live approval producers include:
- `orch_run_execute_manifest` for A3 compute execution
- `orch_run_record_proposal_decision` for local proposal lifecycle closure without a second approval family
- `orch_run_record_verification` for runtime decisive verification truth that can unlock A5 pass
- `orch_run_request_final_conclusions` for the first A5 higher-conclusion boundary consumer

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
orch://runs/export                  → export summary pointer
```

### 5.2 Relationship with `hep://`

```
hep://projects/<project_id>         → project root / evidence-facing project identity
hep://runs/<run_id>/manifest        → evidence/run manifest view
hep://runs/<run_id>/artifact/<name> → evidence artifact view
orch://runs/<run_id>                → lifecycle / control-plane view
```

`hep://` and `orch://` are intentionally separate owned namespaces. Cross-scheme correlation must be carried explicitly by workflow metadata or operator context, not by implicit aliasing.

---

## 6. Compatibility and Migration Notes

1. The old “TS orchestrator is read-only Stage 1” framing is no longer live truth. `@autoresearch/orchestrator` already owns the current `orch_*` surface.
2. `packages/hep-autoresearch` is now a provider-local internal parser/toolkit residue. The retired public `hepar` shell must not reclaim `orch_*` or `autoresearch` authority.
3. Public documentation or review packets that need the current orchestrator MCP truth should point at this file plus the live tool registry/tests (`packages/hep-mcp/tests/toolContracts.test.ts`, `packages/hep-mcp/tests/docs/docToolDrift.test.ts`) rather than older Stage 1/2 sketches.
