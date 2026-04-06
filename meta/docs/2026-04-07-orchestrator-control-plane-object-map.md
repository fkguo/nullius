# 2026-04-07 Orchestrator Control-Plane Object Map

## Purpose

This document records the current control-plane object families in `packages/orchestrator/` so later `CP-OBJ-01` slices can converge them without inventing new parallel authorities.

It is intentionally source-grounded. It describes the live code as of `main`, not an aspirational greenfield model.

## Hard Boundaries

- `autoresearch` remains the generic front door and long-term control plane.
- HEP stays a domain pack, not the root object language.
- Transcript/message history is execution evidence, not project-state SSOT.
- Derived read models and diagnostics bridges must not become second authorities.
- Future `job` / `turn` work must converge onto existing authority families rather than adding another parallel tree.

## Canonical Object Families

| Family | Canonical types | Owns today | Does not own | Primary files |
|---|---|---|---|---|
| Root project run | `RunState`, `PendingApproval`, `ApprovalHistoryEntry`, `LedgerEvent` | project-level lifecycle status, root approval slot, current step / plan linkage, append-only root audit events | delegated assignment/session lineage, raw agent turn evidence, research task graph | `packages/orchestrator/src/types.ts`, `packages/orchestrator/src/state-manager.ts`, `packages/orchestrator/src/ledger-writer.ts`, `packages/orchestrator/src/orch-tools/run-read-model.ts` |
| Delegated execution | `TeamExecutionState`, `TeamDelegateAssignment`, `TeamAssignmentSession`, `TeamPendingApproval`, `TeamCheckpointBinding`, `TeamExecutionEvent` | per-assignment execution lifecycle, assignment-local approval metadata, session lineage, assignment checkpoint binding, team replay | root project-run status, raw tool/turn transcript, research-loop task graph authority | `packages/orchestrator/src/team-execution-types.ts`, `packages/orchestrator/src/team-execution-assignment-*.ts`, `packages/orchestrator/src/team-execution-scoping.ts`, `packages/orchestrator/src/team-execution-events.ts`, `packages/orchestrator/src/team-execution-view.ts`, `packages/orchestrator/src/team-unified-runtime-support.ts` |
| Runtime step checkpoint / resume | `RunManifest`, `StepCheckpoint` | per-runtime-run step completion, resume cursor, skip-on-resume behavior | operator-facing run status, assignment/session semantics, task graph semantics | `packages/orchestrator/src/run-manifest.ts`, `packages/orchestrator/src/research-loop/delegated-agent-runtime.ts`, `packages/orchestrator/src/agent-runner-ops.ts` |
| Research task substrate | `ResearchTask`, `ResearchEvent`, `ResearchCheckpoint`, `ResearchHandoff`, `ResearchLoopRuntimeState` | task graph / follow-up lineage, task status transitions, task-scoped checkpoints, handoff registration | live delegated session authority, operator read model, root lifecycle state | `packages/orchestrator/src/research-loop/task-types.ts`, `packages/orchestrator/src/research-loop/event-types.ts`, `packages/orchestrator/src/research-loop/checkpoint-types.ts`, `packages/orchestrator/src/research-loop/runtime.ts`, `packages/orchestrator/src/computation/feedback-*.ts` |
| Execution evidence stream | `AgentEvent` | append-only evidence for one agent execution attempt: text, tool calls, approval-required markers, runtime markers, terminal done/error | durable run/session/task state, operator replay truth, canonical task/session identity | `packages/orchestrator/src/agent-runner-ops.ts`, `packages/orchestrator/src/agent-runner-runtime-state.ts`, `packages/orchestrator/src/research-loop/delegated-agent-runtime.ts` |
| Derived operator projections | `buildRunStatusView(...)`, `buildTeamControlPlaneView(...)`, `RuntimeDiagnosticsBridgeArtifactV1` | operator-facing summaries over root run, delegated execution, manifest, runtime markers | source-of-truth lifecycle ownership; they must remain derived views | `packages/orchestrator/src/orch-tools/run-read-model.ts`, `packages/orchestrator/src/team-execution-view.ts`, `packages/orchestrator/src/runtime-diagnostics-bridge.ts` |

## What Each Family Means Right Now

### 1. Root project run

`RunState` is the canonical project-root lifecycle authority. It owns `run_status`, root `pending_approval`, `approval_history`, `gate_satisfied`, `current_step`, and top-level plan linkage. `LedgerEvent` is the append-only audit stream for that root run.

This family is intentionally narrow:

- it knows the root run state
- it does not directly store delegated assignment/session lineage
- it does not store raw agent turn/tool history
- it does not own the research task graph

### 2. Delegated execution

`TeamExecutionState` is the canonical authority for delegated execution underneath one root run. Its center of gravity is `TeamDelegateAssignment`, which is the current live execution unit for delegated work.

Today, the most important delegated objects are:

- `TeamDelegateAssignment`
  - the live execution unit for one delegated work item
  - owns assignment-local status, task-carried execution metadata, approval fields, resume/checkpoint pointers, and delegate identity
- `TeamAssignmentSession`
  - the canonical lineage object for one concrete execution attempt / resume / fork of an assignment
  - owns `session_id`, `parent_session_id`, `context_kind`, runtime status, and checkpoint/resume pointers
- `TeamExecutionEvent`
  - operator replay/control-plane event log over assignment lifecycle changes
  - not a raw transcript
- `TeamPendingApproval`
  - derived from assignment-local approval fields and kept as team-local approval surface

This family is already closer to a first-class execution substrate than the current docs/tracker wording sometimes implies. The main weakness is not absence; it is identity duplication and projection repair.

### 3. Runtime step checkpoint / resume

`RunManifest` is the canonical authority for step-level recovery inside one runtime run. It is persisted under `artifacts/runs/<run_id>/manifest.json` and owns:

- durable `last_completed_step`
- `resume_from`
- `checkpoints[]` keyed by tool-use `step_id`

This is not the same kind of object as a project run or a task. It is a step-checkpoint ledger for one runtime execution.

### 4. Research task substrate

`ResearchTask` and friends are the canonical task graph / follow-up substrate.

They already own:

- task identity and parent-task lineage
- follow-up spawning
- task status transitions
- task-scoped checkpoint snapshots
- handoff registration

But they do not yet own the live delegated execution path. In current code, `task_id` crosses into delegated runtime primarily as carried metadata and a coordination key.

### 5. Execution evidence stream

`AgentEvent` is the raw append-only event stream produced by `AgentRunner` and delegated runtime execution.

It is execution evidence, not control-plane state:

- good for diagnostics, approval detection, runtime markers, and eventual turn/session projections
- not sufficient by itself to serve as root run or delegated execution SSOT

This is where future stable `turn` projection should come from, but `turn` is not a durable first-class object yet.

### 6. Derived operator projections

Current operator-facing surfaces are projections over the above authorities:

- root run read model
- team live status / background task / replay view
- runtime diagnostics bridge artifact

These are necessary, but they are not allowed to become another authority family.

## Explicitly Non-Canonical Or Not Yet First-Class

### `job`

There is no first-class generic `job` object in `packages/orchestrator/` today.

The closest live execution unit is `TeamDelegateAssignment`. If future work needs `job` wording, it should either:

- remain a thin naming/projection layer over assignment/task families, or
- be introduced as a typed wrapper that clearly maps to those families

If `job` becomes necessary, the closest useful pattern is an orthogonal batch/attempt dimension like Codex `AgentJob`/`AgentJobItem`, not a synonym for `run`, `task`, or `session`.

It must not arrive as a separate SSOT.

### `turn`

There is no first-class persisted `turn` object today.

Current turn-level reality is spread across:

- `AgentEvent[]`
- terminal `done` / `error`
- runtime markers
- tool-use `step_id` / `RunManifest` checkpoints

Future `CP-OBJ-01C` may create a stable turn/session projection, but it must remain a projection over execution evidence and delegated execution state rather than a transcript-as-SSOT pivot.

### Synthetic delegated runtime ids

`runtimeRunId(runId, assignmentId)` in `team-execution-scoping.ts` is a string convention that currently glues multiple layers together.

It is useful, but it is not a typed identity object. This is one of the main reasons `CP-OBJ-01B` should introduce a typed execution-identity seam.

## Current Duplication / Drift Map

### 1. Run identity is split across four layers

Today, "run" can mean:

- root project run: `RunState.run_id`
- team-local delegated-execution container: `TeamExecutionState.run_id`
- runtime step-checkpoint scope: `RunManifest.run_id`
- synthetic delegated runtime execution id: `runtimeRunId(runId, assignmentId)`

These are related but not identical. Current code relies too heavily on string-level naming convention instead of typed identity relations.

### 2. Task identity crosses into execution as carried metadata

`ResearchTask.task_id` and `TeamDelegateAssignment.task_id` currently line up by convention, but the live delegated runtime path still mostly treats `task_id` as carried metadata rather than a typed bridge between task-graph authority and execution authority.

### 3. Session state still needs repair/synthesis

`TeamAssignmentSession` is real authority, but `normalizeTeamScopingState()` still has to synthesize sessions for assignments whose persisted session object is missing.

That is a direct sign that session projection / persistence is not yet fully converged.

### 4. Checkpoint means three different things

Current code has three distinct checkpoint families:

- runtime step checkpoints: `RunManifest.checkpoints`
- delegated execution binding checkpoints: `TeamCheckpointBinding`
- research task checkpoints: `ResearchCheckpoint`

These are all legitimate, but they need a typed identity seam and clearer naming discipline so they are not treated as interchangeable.

### 5. Events are split by purpose, but the boundary is easy to blur

Current event families are:

- `LedgerEvent`: root audit
- `AgentEvent`: raw execution evidence
- `TeamExecutionEvent`: assignment-lifecycle replay
- `ResearchEvent`: task-graph lifecycle

This split is acceptable only if later read models keep them purpose-specific. A unified operator read model should reuse a shared vocabulary, not collapse them into one shapeless event blob.

### 6. Status projection already exists in multiple derived forms

One assignment status currently feeds:

- `TeamDelegateAssignment.status`
- `taskLifecycleFromAssignmentStatus(...)`
- `TeamAssignmentSession.runtime_status`
- `TeamAssignmentSession.task_lifecycle_status`
- `TeamAssignmentSession.task_status`
- `TeamBackgroundTaskView.task_status`

This is a healthy signal that projection is needed, but it also shows where silent divergence can emerge if later slices continue to patch each view independently.

### 7. Approval authority is split between root slot, delegated execution, and projection

Current approval surfaces are:

- root lifecycle authority: `RunState.pending_approval`
- delegated execution-local authority: `TeamDelegateAssignment.approval_id`, `approval_packet_path`, `approval_requested_at`
- derived team projection: `TeamPendingApproval`

There is also an `ApprovalGate`-shaped interface in the runtime path, but current live mutation authority still centers on `StateManager` root approval methods plus assignment-local delegated fields. This is a real duplication seam rather than just naming noise.

## CP-OBJ Guidance For The Next Slices

### `CP-OBJ-01B` — Typed execution identity seam

This slice should converge the string-level identity seams first.

Preferred landing zone:

- new helper module in `packages/orchestrator/src/` for typed refs / identity helpers
- `packages/orchestrator/src/team-execution-scoping.ts`
- `packages/orchestrator/src/team-execution-types.ts`
- `packages/orchestrator/src/run-manifest.ts`

Primary target:

- make the relationship between root run, delegated runtime run, assignment, session, task, approval, step, and checkpoint explicit without rewriting behavior

### `CP-OBJ-01C` — Delegated runtime session/turn projection

This slice should create a stable projection seam from:

- `AgentEvent[]`
- `RunManifest`
- assignment/session state

It should reduce the need for synthetic session repair on the common path and give later diagnostics/read-model work a stable session/turn substrate.

### `CP-OBJ-01D` — Unified operator read model

This slice should unify projection vocabulary across:

- `buildRunStatusView(...)`
- `buildTeamControlPlaneView(...)`
- runtime diagnostics bridge

The goal is not one giant state object. The goal is consistent projection vocabulary and lineage across root run, delegated execution, and execution evidence.

### `CP-OBJ-01E` — Research-task bridge into live execution

This slice should make the relation between `ResearchTask` and delegated execution explicit enough that task identity survives through:

- follow-up seed creation
- assignment registration
- delegated execution
- result/feedback follow-up chains

The aim is to stop treating `task_id` as decorative metadata on the live path.

## What We Are Explicitly Not Doing Here

- no runtime rewrite
- no remote/server/fleet widening
- no transcript/thread promotion into project-state SSOT
- no new generic eval stack
- no HEP/domain-pack-specific object taxonomy in the generic substrate

## External Source Patterns Worth Absorbing

For `CP-OBJ-01`, `codex` is the stronger primary control-plane reference. `claude-code-sourcemap` is still valuable, but mainly as a secondary source for lineage anchors, typed control sideband, and operator resume/read-model behavior.

The strongest source-grounded patterns from `codex` and `claude-code-sourcemap` are:

- durable container vs execution-item separation
  - Codex keeps thread container identity separate from turn/item execution stream
  - Codex `AgentJob`/`AgentJobItem` also shows how a job dimension can stay orthogonal to session/thread container identity
- append-only event normalization
  - Codex normalizes raw runtime items into explicit JSONL event/item families rather than overloading one status blob
- parent/child execution lineage as first-class relation
  - Codex analytics tracks parent thread relation explicitly rather than only through naming convention
- control sideband separated from message stream
  - Claude Code keeps control request/response and permission flow typed beside, not inside, message content
- typed session/protocol signals
  - Claude Code exposes session/message/progress shapes as typed protocol surface

What should not be copied:

- thread/transcript as the top-level project-state object
- remote/UI-first runtime baggage
- giant omnibus message schema imported wholesale into `autoresearch`

## Current Planning Consequence

Until `CP-OBJ-01B` begins, new runtime slices should avoid introducing fresh ad hoc ids, fresh synthetic read models, or fresh "job"/"turn" language that is not explicitly mapped back to the families above.
