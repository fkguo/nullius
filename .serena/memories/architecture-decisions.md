## Cross-Component Architecture Decisions

> This tracked Serena memory stores only stable, cross-session architecture decisions.
> Detailed closeout evidence, review rounds, exact validation commands, and item history live in checked-in closeout docs plus the current source/tests/front-door docs; do not rely on deleted tracker/plan paths as authority.

### [2026-04-09] Idea public-authority invariant: `idea-engine` owns the live idea runtime and checked-in RPC contracts

**Decision**:
- Public package indexes, compatibility manifests, discovery metadata, and host-facing wording must treat TS `idea-engine` as the only public runtime authority for idea/campaign RPC.
- Retired `idea-generator` / `idea-core` package identities must not reappear in checked-in docs, market metadata, runtime asset paths, or contract naming.
- The checked-in RPC contract snapshot now lives under `packages/idea-engine/contracts/idea-runtime-contracts/**` with `idea_runtime_rpc_v1` naming, not `idea-core` authority residue.

**Why**: The live host path already runs through `idea-engine` and `idea-mcp`. Leaving `idea-core` in public inventories, keeping `idea-generator` alive as a quasi-authority, or preserving `idea-core`-named contract artifacts would keep a fake split-brain alive and invite new users onto surfaces we have already retired without backward-compatibility obligations.

### [2026-04-08] Regression harness external-root invariant: real-project semantics must be exercised on an external authority root, never by relaxing policy

**Decision**:
- Maintainer regression harnesses that exercise real-project flows must materialize a real external project root outside the dev repo and keep fail-closed `project_root` policy intact.
- If the harness needs repo-owned schemas or fixtures, it must explicitly mirror the bounded authority surface it depends on (for example `specs/`) into that external project root, rather than re-legitimizing repo-internal roots.
- For flows that cross the canonical TS front door, runtime state must live where the front door actually expects it; do not rely on Python-only runtime overrides to simulate approval/computation success.
- Repo-local copies under `artifacts/runs/*/orchestrator_regression/**` are snapshot anchors for audit/debug only, not project authorities.

**Why**: This keeps regression coverage aligned with the real generic front door and prevents maintainer harnesses from silently testing a looser world than the product actually permits.

### [2026-03-02] RT-05: semi-permeable clean room with information membrane

**Decision**:
- Multi-agent verification should use a semi-permeable clean room rather than either full isolation or unrestricted debate.
- Membrane rules classify information by semantic content, not by sender role: methods, references, and verification strategies may pass; results, conclusions, and target answers must stay blocked until independent work is complete.
- The filtering mechanism may evolve from heuristic to LLM-based classification, but the membrane boundary itself remains the stable design.

**Why**: The project needs independent verification without paying the quality cost of fully isolated agents.

### [2026-03-06] Monorepo architecture: retrieval, discovery, and routing are first-class subsystems

**Decision**:
- Retrieval, discovery, and routing are platform-level capabilities, not ad hoc per-tool follow-ups.
- These subsystems serve the near-term single-user research loop first; community/publishing layers consume them later rather than defining them up front.
- Generic/shared packages own reusable contracts and evaluation surfaces; provider packages own concrete adapters and capabilities.

**Why**: Long-chain research quality depends directly on these capability axes, so they must be treated as core architecture rather than incidental helpers.

### [2026-03-07] Single-project substrate precedes team and community runtime

**Decision**:
- `single-user` means a single governing human owner, not a single active agent.
- The single-project substrate (`ResearchWorkspace`, task/event graph, checkpoints, interventions, typed handoffs) must stabilize before the `EVO-13` team runtime is implemented.
- The `EVO-13` implementation prompt should not be drafted until the `NEW-LOOP-01` substrate contracts are closeout-stable.
- Later team/community layers must extend the same substrate rather than inventing parallel project-state models.

**Why**: Freezing multi-agent or community assumptions before the substrate is stable would lock the wrong execution model into the core.

### [2026-03-09] Root ecosystem boundary: root is workbench/governance, not product agent

**Decision**:
- The repo root remains the ecosystem/workbench/governance entrypoint, not a packaged end-user agent.
- `packages/orchestrator/` remains the runtime/control-plane nucleus.
- `packages/*-mcp` remain independent capability providers; do not build a root super-MCP.
- A future packaged end-user agent, if needed, must arrive as a leaf package after stable provider boundaries and `P5A` closure.

**Why**: Premature root-level agentization would harden provider-specific residue into long-lived generic abstractions.

### [2026-03-10] Shared boundary invariant: shared keeps seams, providers keep concrete authority

**Decision**:
- `packages/shared/` keeps only provider-agnostic typed seams and cross-package helpers.
- Concrete provider-owned authority must live in the owning leaf provider or aggregator package.
- For HEP-specific surfaces, concrete tool names, risk maps, URI wrappers, and similar provider-local authority stay in `packages/hep-mcp/`, not in shared.

**Why**: This preserves a domain-neutral core without preventing composition across providers.

### [2026-04-07] Discovery-card truth invariant: checked-in capability cards must match the live public host exactly

**Decision**:
- Checked-in discovery / agent-card capability inventories must advertise only the capabilities that the current public host actually serves.
- Unsupported lifecycle, ranking, or node methods must be deleted from discovery truth instead of being kept as aspirational placeholders, compatibility promises, or “future” capability claims.
- When a shared helper or adapter no longer has a live generic/public authority consumer, it should be removed rather than preserved as dormant compatibility surface.

**Why**: Over-advertised capability cards and dead shared surfaces create split-brain authority at the front door and quietly reintroduce legacy baggage into the generic substrate.

### [2026-03-10] Formalism boundary invariant: formalism is optional run-local metadata, not core contract authority

**Decision**:
- Public schemas and generic runtime must not require canonical formalism registries, formalism gates, or formalism-check handoff fields.
- Method/formalism information may exist only as optional, non-gating project/run-local metadata until a future explicit method-spec contract exists.
- Domain packs/providers expose capabilities and seams, not bundled worldview catalogs.

**Why**: The stable substrate centers on question, evidence, artifact, approval, and runtime semantics; method choice belongs in local research context rather than repo-wide mandatory authority.

### [2026-03-13] Execution-plan bridge invariant: audited IR first, manifest second

**Decision**:
- Staged idea surfaces must compile first into a provider-neutral audited `execution_plan_v1` intermediate representation.
- `computation_manifest_v1` remains the materialized execution surface; it must be derived from a validated execution plan rather than becoming parallel authority.
- Pre-approval bridge flows may write audited plan artifacts, manifests, and non-executable stubs, but they remain validation-only until explicit approval.

**Why**: This keeps provider routing and execution materialization downstream of a stable, auditable planning surface.

### [2026-03-07] Host-side MCP sampling routing stays on the host

**Decision**:
- MCP servers emit stable sampling metadata only; they do not self-select routes, models, or backends.
- The host owns routing config, resolution, fallback behavior, and audit logging for sampling requests.
- Shared sampling metadata must stay typed and provider-neutral so multiple servers can participate without leaking routing authority back into the server side.

**Why**: Host-side routing preserves a single control plane for cost/risk policy and avoids provider-local model selection drift.

### [2026-03-08] Canonical discovery and retrieval stay layered and auditable

**Decision**:
- Discovery remains library-first/shared-contract-first; provider packages contribute evidence and adapters rather than becoming discovery authority.
- Canonicalization follows an exact-ID-first fail-closed ladder; insufficient evidence stays unmerged.
- Ranking authority operates in canonical paper space; provider-native retrieval remains evidence only.
- Query reformulation/QPP is an explicit fail-closed planner layer, not a hidden replacement retrieval path.
- Structure-aware localization runs after retrieval as a bounded localization layer.
- Multimodal retrieval remains a bounded page-native fusion layer over existing PDF evidence artifacts, not a new global multimodal substrate.

**Why**: The stable backbone is retrieve -> canonicalize -> rerank -> localize -> optional multimodal fusion, with explicit artifacts and failure states at each layer.

### [2026-03-11] Semantic packet curation invariant: auditable candidates first, semantic authority second, deterministic replay last

**Decision**:
- Packet curation uses a three-layer contract: deterministic candidate expansion/ranking, semantic adjudication over those candidates, then deterministic replay/render planning.
- Headings, keyword hits, and section order may remain hints or provenance only; they must not be the final authority for critical selection.
- The stable public artifact is a structured selection record with explicit outcomes and failure states, not free-text model commentary.

**Why**: This preserves semantic quality while keeping the external contract replayable and fail-closed.

### [2026-03-14] Scaffold boundary invariant: one canonical minimal root, direct role names, template-backed shared authority

**Decision**:
- User-facing project-root entry names should describe role directly; obviously wrong legacy scaffold names should be directly renamed during the current refactor.
- `hepar init` and `research-team scaffold` are thin host entrypoints and must not own independent scaffold authority.
- The canonical minimal project-root surface is `project_charter.md`, `project_index.md`, `research_plan.md`, `research_notebook.md`, `research_contract.md`, and `.mcp.template.json`.
- Shared scaffold authority is complete only when every user-readable output is backed by a checked-in template inventory with bidirectional anti-drift checks.
- Host/provider extras remain optional, and provider bundles stay opt-in; generic scaffold examples must remain provider-neutral by default.

**Why**: A stable host-agnostic root surface prevents later control-plane drift and stops provider-specific defaults from becoming de facto core authority.

### [2026-03-23] External-root invariant: real projects stay outside the dev repo, maintainer fixtures stay explicit

**Decision**:
- Shared scaffold / contract authority now lives in the neutral Python package `packages/project-contracts/`; `research-team` public scaffold/contract-refresh entrypoints and `hep-autoresearch init` are consumers, not independent authorities.
- Public `real_project` flows must fail closed when the project root or real-project intermediate outputs resolve anywhere under the autoresearch-lab development repo checkout.
- Repo-internal workspaces are allowed only as explicit `maintainer_fixture` directories (currently `.tmp` under the dev repo); longer-lived maintainer-only materials should live in local non-public archives such as `~/.autoresearch-lab-dev/` and must never become real-project authority or a hidden fallback mode.
- This slice is authority extraction plus isolation only; it does not repoint the generic control plane yet and does not preserve future `hepar` / `hep-autoresearch` aliases by default.

**Why**: The shared scaffold contract cannot remain credible while public research flows can still create or route real work back into the development monorepo. The explicit real-project vs maintainer-fixture split closes that hole without expanding into a full Pipeline A repoint.

### [2026-04-07] CP-OBJ delegated execution identity invariant: typed relation seam, not new durable authority

**Decision**:
- Delegated runtime identity is now expressed through one shared typed value seam, `buildDelegatedExecutionIdentity(...)` plus `delegatedExecutionManifestPath(...)`, rather than repeated ad hoc string recomposition of `project_run_id + assignment_id -> runtime_run_id -> manifest_path`.
- This seam is deliberately not a new persisted control-plane object, public wire contract, or second read model. It is an internal relation helper consumed by delegated execution/scoping/view/runtime code.
- Existing wire fields such as `runtime_run_id` and `manifest_path` remain the same; later `CP-OBJ-01D/01E` work must consume this seam rather than inventing transcript/job/turn authority or recomposing the strings again.

**Why**: The real drift problem was string-level identity reconstruction spread across multiple layers, not the absence of another durable object family. Centralizing the relation while keeping it non-authoritative preserves boundedness and gives later session/turn/read-model slices a stable identity substrate.

### [2026-04-07] CP-OBJ delegated runtime projection landed invariant: compact turn/session sideband, not transcript promotion

**Decision**:
- `CP-OBJ-01C` is now landed around a compact typed session/turn projection derived from existing execution evidence (`AgentEvent`, `RunManifest`) plus `TeamAssignmentSession` lineage, rather than promoting transcript/message history into durable control-plane authority.
- Common-path turn lineage is now recorded while the runtime still knows real turn boundaries: `AgentRunner` records the projection at source, `executeDelegatedAgentRuntime(...)` returns the same seam, and `runtime-diagnostics-bridge.ts` consumes that seam instead of rescanning raw `AgentEvent[]`.
- The existing `runtime_run_id` and delegated manifest/spans container remain the stable delegated runtime identity. `TeamAssignmentSession.runtime_projection` hangs under that container as nullable derived sideband, stays `null` for synthetic/repaired sessions, and does not introduce a new generic `job` / `thread` authority or widen current public host/team payloads.

**Why**: The drift seam was projection loss, not missing transcript storage. Landing one compact turn/session summary at source preserves generic-first boundedness, keeps diagnostics/read models on one seam, and avoids importing remote/UI-first conversation models into the control plane.

### [2026-04-07] Control-plane layering invariant: single front door, canonical state, projection-only public surfaces, leaf-local legacy containment

**Decision**:
- Generic lifecycle / workflow / bounded computation authority must stay on one canonical front door (`autoresearch` + `packages/orchestrator`), rather than being replicated across legacy/provider-local CLIs.
- Canonical run/task/session state stays in typed durable control-plane substrate; operator dashboards, team views, public payloads, analytics, and compatibility fields are read-time projections only and must not back-propagate authority.
- Legacy/provider-local/maintainer tooling may remain only as leaf-local adapters, diagnostics, or support utilities; they must not keep an independent root mutation path for lifecycle, approval, or workflow authority.
- When multiple entry sources still exist, source taxonomy should be explicit and typed, while public/read-model output may expose only a curated/coarse-grained projection of that source information.

**Why**: A deeper source audit of mature agent implementations showed the same stable pattern repeatedly: one canonical front door, append-only or typed canonical state, separate projection layers, and strict containment of legacy/internal tooling. Encoding that split directly into Autoresearch is the safest way to keep generic-first authority from drifting back into legacy shells or maintainer-only surfaces.

### [2026-04-07] Legacy public-shell invariant (superseded on 2026-04-08): temporary bounded-pointer framing before full public-shell retirement

**Decision**:
- The installable Pipeline A aliases (`hep-autoresearch`, `hepar`, `hep-autopilot`) must not retain a suite of public workflow/support commands after generic authority has moved to `autoresearch`.
- This entry recorded the intermediate contraction stance before the later 2026-04-08 decision deleted the installable public shell entirely; it is kept only as historical sequencing, not as current authority.
- Legacy utilities such as `approvals`, `report`, `logs`, `context`, `smoke-test`, `method-design`, `propose`, `skill-propose`, `run-card`, `branch`, and `migrate` must either be internal full-parser only or be deleted; they are not public front-door truth.
- Exact public-shell inventory must stay fail-closed across source, front-door authority fixtures, docs, and tests.

**Why**: Leaving a public support-command bundle on the legacy shell recreates a second operator/public front door even when lifecycle and computation have already moved to the generic TS control plane. The next-day 2026-04-08 decision closed the remaining pointer entirely.

### [2026-04-07] Idea-engine discovery/runtime authority invariant: TS public host must not point back to legacy package paths

**Decision**:
- Installable `idea-mcp` is TS-host-only, and checked-in `idea-engine` discovery cards must point to TS-owned contract snapshots under `packages/idea-engine/**`, not `packages/idea-core/**`.
- `idea-mcp` and `IdeaRpcClient` must require an explicit data root and must fail closed rather than defaulting to repo-local `packages/idea-engine/runs`.
- Default runtime contract and builtin pack assets consumed by the live TS `idea-engine` path must live under package-local TS-owned paths, not legacy Python package paths.

**Why**: Leaving discovery contracts or runtime default assets under `idea-core` or repo-local default run roots preserves hidden fallback authority even after TS hosting became the only public idea surface, and it violates the dev-repo boundary for real runtime state.

### [2026-03-21] Pipeline A lifecycle invariant: `hep-autoresearch` and `hepar` move together

**Decision**:
- `hep-autoresearch` and its installable alias `hepar` are the same Pipeline A Python control-plane surface; they must not be governed as if one were retired while the other remained the default long-term authority.
- This historical invariant matters because later retirement applies to both names together; it should no longer be read as permission to keep either name alive as a public transitional entrypoint.
- When a batch changes lifecycle status for a package / CLI / pipeline surface (`current`, `transitional`, `retired`, `repointed`), the checked-in governance/docs set must distinguish then-current status from later retirement decisions so historical notes do not silently contradict live front-door truth.

**Why**: The repository then had both a Python Pipeline A and a target TS control plane. Without an explicit invariant tying `hep-autoresearch` and `hepar` together, docs drifted into contradictory states where one source said “retired” and another still presented the same surface as the default authority. The later 2026-04-08 retirement decision resolves that ambiguity in favor of full public-shell retirement.

### [2026-03-21] Orchestrator package boundary invariant: workspace source is singular, host adapters consume the package surface

**Decision**:
- `packages/orchestrator/` is the single source workspace for the workspace package `@autoresearch/orchestrator`; this is not a second implementation boundary.
- Host adapters such as `packages/hep-mcp/` must consume exported orchestrator surfaces (for example `ORCH_TOOL_SPECS`) from `@autoresearch/orchestrator` rather than re-defining generic orchestrator authority locally.
- The practical anti-drift risk is `src` vs built `dist` divergence, so shared-surface changes must keep `build + downstream host-path contract` in acceptance to catch stale package output.

**Why**: Treating the workspace package name as a duplicate implementation would hide the real failure mode. The stable boundary is one source package plus downstream consumers, not parallel generic runtimes.

### [2026-03-22] EVO-14 fleet visibility invariant: explicit-project-roots read model before queue/scheduler

**Decision**:
- EVO-14 begins with a read-only fleet visibility surface over explicit `project_roots`; Batch 1 aggregates only the existing run-level truth in `.autoresearch/state.json`, `.autoresearch/ledger.jsonl`, and current-run approval packets.
- Persistent fleet registry, queue/claim/lease, scheduler/worker/resource budgeting, global health, and reassignment remain later EVO-14 batches rather than entering the first visibility slice.
- EVO-13 team-local artifacts and views such as `team-execution-state.json`, `live_status`, and `replay` do not become fleet authority.

**Why**: This gives bounded cross-run operator visibility on the live TS-first shared -> orchestrator -> hep-mcp host path without reopening team-local runtime semantics or inventing scheduler authority early.

### [2026-03-22] EVO-14 fleet queue invariant: per-project queue authority before scheduler/health

**Decision**:
- EVO-14 Batch 2 introduces a per-project persistent queue registry at `.autoresearch/fleet_queue.json`; that file is the sole queue/claim ownership authority for fleet work.
- Cross-root fleet mutation is still forbidden at this stage. `orch_fleet_status` remains the only cross-root surface and stays read-only over explicit `project_roots`, while `orch_fleet_enqueue`, `orch_fleet_claim`, and `orch_fleet_release` mutate only one `project_root` at a time.
- `state.json` remains current-run authority, `ledger.jsonl` remains audit/provenance only, and EVO-13 team-local artifacts/views such as `team-execution-state.json`, `live_status`, and `replay` do not participate in fleet queue ownership decisions.
- Claim semantics are explicit non-expiring records only in Batch 2; TTL expiry, heartbeat takeover, auto-reclaim, scheduler authority, fleet health monitoring, and reassignment remain later EVO-14 work.

**Why**: This keeps queue truth singular and durable without smuggling Batch 3 scheduler/health semantics or a second ownership authority into the control plane early.

### [2026-03-22] EVO-14 worker-poll invariant: worker truth separate from queue truth and scheduler truth

**Decision**:
- EVO-14 Batch 3 introduces a per-project worker/resource registry at `.autoresearch/fleet_workers.json`; that file is the sole worker liveness and slot-capacity authority for fleet work.
- Queue truth remains only `.autoresearch/fleet_queue.json`; active claim counts and available worker slots must be derived from the full queue authority rather than persisted a second time in the worker registry.
- Scheduler truth remains transient `worker poll` behavior: `orch_fleet_worker_poll` is the only Batch 3 scheduler surface, while `orch_fleet_worker_heartbeat` only refreshes worker liveness and never mutates queue ownership.
- `orch_fleet_status` remains the only cross-root fleet surface and stays read-only over explicit `project_roots`.
- Batch 3 still excludes central tick/daemon authority, `scheduler_state.json`, TTL reclaim, heartbeat takeover, auto reassignment, and promotion of `state.json`, `ledger.jsonl`, `team-execution-state.json`, `live_status`, or `replay` into fleet authority.

**Why**: This keeps queue ownership, worker health/resource truth, and scheduling behavior from collapsing into competing authorities while still enabling bounded worker-pull scheduling and slot accounting.

### [2026-03-22] EVO-14 stale-claim intervention invariant: explicit manual adjudication only

**Decision**:
- EVO-14 Batch 4 adds a single explicit stale-claim intervention surface, `orch_fleet_adjudicate_stale_claim`, which may settle only a currently claimed queue item and must require exact `queue_item_id + claim_id + owner_id` match to fail closed on stale reads or concurrent mutation.
- Queue truth remains only `.autoresearch/fleet_queue.json`; worker/resource truth remains only `.autoresearch/fleet_workers.json`; and manual adjudication does not create any second persisted intervention authority file.
- Whether a claim is considered stale is operator judgment informed by existing read-only signals, not a new canonical persisted enum or an automatic authority decision.
- After adjudication, control returns to the existing Batch 3 path: queue mutation plus audit ledger event, followed later by ordinary `orch_fleet_worker_poll` claiming if the item was requeued.
- Batch 4 still excludes TTL expiry, heartbeat auto-release, auto takeover, auto reassignment, central tick/daemon authority, and promotion of `state.json`, `ledger.jsonl`, `team-execution-state.json`, `live_status`, or `replay` into fleet authority.

**Why**: This closes the operational gap around stale claims without prematurely turning health observations into ownership-breaking authority or introducing a second scheduler/intervention control plane.

### [2026-03-22] EVO-14 stale-signal visibility invariant: operator diagnostics stay read-only

**Decision**:
- EVO-14 Batch 5 extends `orch_fleet_status` with operator-facing stale-signal diagnostics only; it does not add TTL, lease expiry, auto release, takeover, or a second fleet read surface.
- Claimed-item diagnostics such as claim age, owner heartbeat age, owner worker health, and `attention_reasons` are derived read-model output only from the existing queue and worker authorities.
- The first bounded attention reasons are `OWNER_WORKER_MISSING`, `OWNER_WORKER_STALE`, `CLAIM_WITHOUT_OWNER`, and `QUEUE_OR_WORKER_REGISTRY_INVALID`; these are operator diagnostics, not persisted scheduler/intervention authority.
- Per-project counters for attention claims remain part of the read model and must not be written back into `.autoresearch/fleet_queue.json`, `.autoresearch/fleet_workers.json`, or any new derived fleet file.

**Why**: Fleet operators need a stable, source-grounded stale-signal surface before TTL or lease automation can be introduced. Locking that visibility contract first avoids smuggling expiry or takeover semantics into the read path and preserves a single authority split between queue truth, worker truth, and transient scheduler behavior.

### [2026-03-22] EVO-14 lease-expiry invariant: explicit queue-claim lease authority only

**Decision**:
- EVO-14 Batch 6 introduces lease semantics only by extending `.autoresearch/fleet_queue.json` claim records with explicit `lease_duration_seconds` and `lease_expires_at`; that claim record is the sole lease authority.
- Expiry is decided only from the persisted claim expiry timestamp against current time. Missing worker, stale worker, or missing heartbeat remain Batch 5 diagnostics only and cannot independently expire or release a claim.
- `orch_fleet_worker_poll` remains the only scheduler path allowed to act on lease truth: before claiming it may requeue expired claims in the same project and renew still-valid claims already owned by the polling worker, using the persisted claim duration rather than recomputing from defaults or heartbeat timeout.
- `orch_fleet_worker_heartbeat` remains worker-registry-only and never mutates queue truth; invalid `.autoresearch/fleet_workers.json` still fails closed for worker-poll mutation paths, including lease sweep.
- `orch_fleet_status` remains the only cross-root fleet read surface; lease-related fields and expired counters are derived read-model output only and do not become a second authority.

**Why**: Batch 6 closes the minimum explicit-expiry contract without turning worker liveness into a second lease authority, without adding a daemon or hidden sweep, and without letting audit/read models back-propagate into mutation truth.

### [2026-03-22] EVO-14 claim-acceptance invariant: worker registry gate only, no drain/takeover semantics

**Decision**:
- EVO-14 Batch 7 extends `.autoresearch/fleet_workers.json` with explicit `workers[].accepts_claims`; that field is the sole authority for whether an existing worker may take new queue claims.
- `orch_fleet_worker_set_claim_acceptance` is the only mutation surface allowed to change that gate. It must fail closed for unknown workers, write only the worker registry, and append audit-only ledger evidence.
- `orch_fleet_worker_heartbeat` and `orch_fleet_worker_poll` may continue to upsert worker liveness/capacity, but they must preserve existing `accepts_claims` rather than infer or overwrite it.
- `orch_fleet_worker_poll` may still heartbeat, renew owned leases, and sweep same-project expired claims before evaluating the gate; when `accepts_claims = false`, it returns deterministic non-error `WORKER_NOT_ACCEPTING_CLAIMS` and must not claim new queued work.
- Stopping new claims does not imply draining, releasing, takeover, reassignment, daemonized scheduling, or any second fleet read/authority surface. `orch_fleet_status` remains the only cross-root read surface and may expose only derived `accepts_claims` visibility/counters.

**Why**: Batch 7 adds the minimal operator-controlled worker-eligibility primitive needed after queue, worker, stale-signal, and lease authority were already split, while explicitly avoiding a second lifecycle authority or premature drain/takeover semantics.

### [2026-03-23] EVO-14 drained-worker unregister invariant: explicit opt-out only after drain is complete

**Decision**:
- EVO-14 Batch 8 adds a single explicit drained-worker unregister surface, `orch_fleet_worker_unregister`, and keeps it as the only mutation path allowed to remove a worker from `.autoresearch/fleet_workers.json`.
- Unregister remains fail-closed: it requires an existing worker, `accepts_claims === false`, and `active_claim_count === 0` derived only from `.autoresearch/fleet_queue.json`; invalid worker or queue registries are errors, while a missing queue file may be treated as zero active claims.
- Successful unregister mutates only `.autoresearch/fleet_workers.json` and appends audit-only `fleet_worker_unregistered` ledger history; it does not release/requeue claims, adjudicate stale claims, claim new work, mutate queue truth, or create any second lifecycle authority file.
- `orch_fleet_worker_heartbeat` and `orch_fleet_worker_poll` remain bounded upsert/scheduler paths only, so later same-id re-registration still occurs solely through the existing worker upsert path.
- `orch_fleet_status` remains the only cross-root read surface and reflects worker disappearance only through the existing read model shape.

**Why**: Batch 8 closes the minimal fleet lifecycle loop after the Batch 7 acceptance gate without smuggling reassignment, takeover, daemonized scheduling, or second-authority worker lifecycle semantics into EVO-14.

### [2026-03-28] EVO-14 manual-reassignment invariant: explicit queue-only claim replacement with operator-selected target

**Decision**:
- EVO-14 Batch 9 adds exactly one new intervention surface, `orch_fleet_reassign_claim`, and keeps it as the only mutation path allowed to manually reassign an already claimed queue item between workers inside one `project_root`.
- Reassignment remains fail-closed: it requires the queue item to be currently `claimed`, exact live matches for `expected_claim_id` and `expected_owner_id`, a still-registered current owner worker, a still-registered target worker, `target_worker_id !== expected_owner_id`, `accepts_claims === true` on the target, and target claim pressure derived only from `.autoresearch/fleet_queue.json` rather than any duplicated counter.
- Successful reassignment mutates only `.autoresearch/fleet_queue.json` by replacing the live claim record on the same queue item; `attempt_count`, priority/order, and `lease_duration_seconds` stay unchanged, while a fresh `claim_id`, `claimed_at`, and recomputed `lease_expires_at` are minted for the new owner.
- The worker registry remains validation input only and is never mutated by reassignment; audit history is append-only `fleet_claim_reassigned`, `orch_fleet_worker_poll` remains the only scheduler truth, and `orch_fleet_status` remains the only cross-root read surface.
- Missing/stale owner recovery stays in Batch 4 manual stale-claim adjudication territory; Batch 9 must not absorb stale-claim recovery, auto takeover, daemonized scheduling, target auto-selection, bulk drain orchestration, or any second fleet authority file/surface.

**Why**: Batch 9 closes the bounded operator handoff gap left after queue, worker, lease, claim-acceptance, and unregister semantics were separated, while keeping reassignment as an explicit queue-only intervention instead of a hidden scheduler or lifecycle automation authority.

### [2026-03-24] Literature workflow authority invariant: executable authority lives in a leaf launcher, not in MCP facades

**Decision**:
- Checked-in executable literature workflow authority lives in the leaf workspace package `packages/literature-workflows/`, which is the only recipe reader / validator / resolver for literature workflow recipes.
- `packages/hep-autoresearch` internal parser residue and `skills/research-team` (`literature_fetch.py workflow-plan`) are consumers of that launcher authority; they must not re-own recipe semantics.
- Provider-specific MCP tools remain bounded atomic operators underneath the workflow layer. Generic workflow authority must not move back into `packages/hep-mcp/` or `packages/shared/`.
- Workflow-like public literature MCP tools are pruned directly from both `standard` and `full`; they do not get a transitional `full` holding area. The retained public literature surface is bounded atomic analysis/operator tools only.

**Why**: Governance-only recipe registration was not enough; without a checked-in executable launcher and consumer repoints, the repo kept two competing high-level front doors. Putting executable authority in a leaf launcher preserves a single workflow authority while keeping provider MCP packages atomic and reusable.

### [2026-03-25] EVO-11 distributor boundary invariant: TS live seam stays family-neutral, slice-1 policy stays fixed

**Decision**:
- Live distributor authority remains on the TS `packages/idea-engine/` `campaign.init` + `search.step` path; do not reopen any legacy Python runtime as bandit runtime authority.
- EVO-11 slice-1 fixes the live runtime-configured public policy surface to `policy_id = ts.discounted_ucb_v1`, factorized action space, immutable campaign-scoped config/state/event artifacts, and checked-in hyperparameters rather than user-configurable policy tuning.
- The internal distributor seam remains family-neutral: operator descriptors, action-space enumeration, config/state/event contracts, and deterministic replay surfaces must not assume `discounted_ucb_v` is the only long-term family, so stronger future policies such as `Replicator MW-KL` or EVO-21-style adaptive strategies can attach without reworking the live TS authority boundary.

**Why**: Slice-1 optimizes for auditability, replay determinism, and low-complexity live integration while preserving a clean upgrade path to stronger future policy families.

### [2026-03-25] Verification kernel invariant: typed provider-neutral verification replaces heuristic authority

**Decision**:
- Verification semantics that must survive across compute, writing, review, and revision belong in provider-neutral, typed, artifact-backed surfaces rather than provider-local heuristic text validators.
- `physicsValidator` is heuristic residue to delete, not a keepable fallback authority. If any deterministic verification check survives, it must re-enter as a real producer of typed verification artifacts with explicit evidence refs and subject/verdict linkage.
- This follow-up is tracked as a new `NEW-VER-01` lane on top of the existing `NEW-COMP-02` / `EVO-03` substrate; it does not reopen `EVO-02`, `EVO-03`, or `EVO-13`, and it does not authorize runtime/scheduler/project-state redesign.

**Why**: The current repo already has canonical computation results and deterministic writing/review bridge artifacts, but it still lacks a first-class shared verification ledger. Heuristic claim-pattern detectors are not a credible decisive authority for quality-critical verification.

### [2026-03-25] Verification kernel Batch 1 contract invariant: four artifacts plus optional bridge refs

**Decision**:
- The canonical generic verification artifact family for Batch 1 is exactly `verification_subject_v1`, `verification_check_run_v1`, `verification_subject_verdict_v1`, and `verification_coverage_v1`.
- `subject_kind` stays a stable generic enum for long-lived subject categories, while `check_kind` stays an open non-empty string so verification method taxonomy is not frozen into shared authority.
- `computation_result_v1` and `writing_review_bridge_v1` may expose only an optional typed `verification_refs` container at this stage; Batch 1 must not inline verification producer/consumer authority into those existing contracts.

**Why**: This preserves a provider-neutral, artifact-backed verification ledger that can attach to existing compute and writing substrates without reopening runtime/project-state authority or hard-coding provider/domain-specific check taxonomies.

### [2026-03-26] Verification kernel Batch 2 invariant: computation-result producer, bridge pass-through, writing-metadata consumer

**Decision**:
- Batch 2's sole first live producer is `writeComputationResultArtifact()` on the computation-result path; it is not a multi-provider rollout and does not reopen generic runtime authority.
- Batch 2's first and only consumer is the `buildRunWritingEvidence()` metadata path in `packages/hep-mcp/src/core/writing/evidence.ts`.
- Writing/review bridge artifacts remain pass-through only for the populated `verification_refs` container; they must not derive new verification verdicts or become a second authority.
- Batch 2 emits exactly `verification_subject_computation_result_v1.json`, `verification_subject_verdict_computation_result_v1.json`, and `verification_coverage_v1.json`, and it must not synthesize `verification_check_run_v1` before a non-heuristic executed-check producer exists.
- To avoid a content-hash cycle, the Batch 2 subject's content-addressed `source_refs` are limited to `manifest_ref + produced_artifact_refs`; the final `computation_result_v1.json` URI is carried only via `linked_identifiers` with `id_kind = "computation_result_uri"`.
- Because the result/bridge `verification_refs` container cannot truthfully carry an empty check-run tuple in Batch 2, `verification_refs.check_run_refs` is omitted from `computation_result_v1` and bridge payloads; only `verification_subject_verdict_v1` carries `check_run_refs: []`.
- `physicsValidator` remains delete-only residue for Batch 3, not a keepable fallback, wrapper, or temporary semantic guardrail.

**Why**: The current repo already exposes one canonical upstream seam and one bounded downstream consumer. Locking that narrow path gives a credible first proof of typed verification flow without inventing fake check-run authority or widening into broader evidence/runtime redesign.

### [2026-03-26] Verification kernel Batch 3 invariant: delete heuristic residue once typed metadata authority is live

**Decision**:
- Once the typed verification path is live, `physicsValidator` must be fully deleted rather than retained as fallback, diagnostic residue, wrapper, or renamed helper.
- The surviving first live verification authority is exactly `writeComputationResultArtifact()` producer -> bridge `verification_refs` pass-through -> `buildRunWritingEvidence()` metadata output in `writing_evidence_meta_v1.json.verification`.
- Current-truth regression coverage must assert both halves of that boundary: typed verification metadata still surfaces, and the research barrel no longer exports `validatePhysics`, `PHYSICS_AXIOMS`, or `PhysicsValidationStatus`.
- Historical mentions of `physicsValidator` may remain only in governance/audit artifacts; live package exports, dedicated tests, and current-truth docs/registry surfaces must not present it as active authority.

**Why**: Keeping the heuristic alive after the typed artifact-backed path landed would preserve a second unverifiable authority and weaken the intended delete-and-replace boundary.

### [2026-03-26] Shell-boundary anti-drift invariant: enforce boundary truth before any future leaf shell

**Decision**:
- Boundary enforcement anti-drift must land before any future shell/gateway/frontend implementation work.
- The repo root remains the ecosystem/workbench/governance surface, not a product shell.
- Any packaged end-user agent remains a later leaf package after `P5A` closure rather than a root/orchestrator/provider promotion.
- `packages/shared` must not depend on provider-owned authority.
- `packages/orchestrator` must not depend on provider UX, shell, or app-layer authority.
- Host adapters must consume shared/orchestrator exports instead of re-defining generic authority locally.
- The durable enforcement surfaces for this invariant are the root checker `scripts/check-shell-boundary-anti-drift.mjs`, shared boundary test `packages/shared/src/__tests__/package-boundary-authority.test.ts`, orchestrator boundary test `packages/orchestrator/tests/package-boundary.test.ts`, and the host-consumption contract `packages/hep-mcp/tests/contracts/sharedOrchestratorPackageExports.test.ts`.
- The root checker is intentionally narrow: it locks front-door wording in `README.md`, `docs/README_zh.md`, and root `package.json`, and it rejects only premature exact shell-package names or standalone `shell` / `gateway` / `frontend` tokens in package basenames.
- The host-consumption proof remains layered: `@autoresearch/shared` owns ORCH tool-name constants, `@autoresearch/orchestrator` owns ORCH tool specs, and host adapters such as hep-mcp must alias/compose those exports rather than declaring local generic ORCH authority.
- DeerFlow is borrowed here only for the boundary-test anti-drift pattern; DeerFlow gateway/frontend/workspace shell remain later adaptation work rather than current authority.

**Why**: The architectural boundary is already decided in ADRs and prior closeouts. The missing gap is continuously enforced packaging truth that keeps future shell/product work from drifting back into root/shared/orchestrator/provider authority confusion.

### [2026-03-30] Coordinator output contract reminder: lane launches ship as complete forwardable packages

**Decision**:
- Supporting reminder only: root main-thread lane-launch outputs should default to one best complete forwardable package with explicit `plan_mode` and an embedded `report_back` template, rather than split instructions that the human must assemble manually.
- Do not proactively emit shortened/non-best variants unless the user explicitly asks for them.
- Normative governance authority remains `AGENTS.md`; this memory is only a concise cross-session reminder and must not become a second SSOT.

**Why**: Keeping lane-launch packets complete by default reduces avoidable coordinator-output drift while preserving a single governance authority.


### [2026-03-31] Research-team validation tier naming cleanup is post-M-22 doc debt, not current runtime authority work

**Decision**:
- The `research-team` skill's `P0` / `P1` / `P2` validation-tier labels still carry live meaning inside `FULL_VALIDATION_CONTRACT.md`, but the labels are semantically overloaded with broader repo phase/priority numbering and are no longer ideal front-door names.
- This is naming/front-door documentation debt rather than runtime authority debt. It should **not** expand the current `M-22 GateSpec research-team convergence first` implementation slice.
- The right sequencing is: finish the bounded `M-22` consumer-authority lane first, then handle a separate small doc-only cleanup that renames front-door validation-tier surfaces to semantic names (for example `validated` / `stable` / `optional hardening`) and renames files such as `P1_GATE_DOC_ALIGNMENT.md` accordingly.
- Until that cleanup lands, current `P0` / `P1` / `P2` labels remain acceptable as internal validation-tier references, but should not be promoted further as long-term generic/public naming.

**Why**:
- The current labels still encode real validation semantics, so removing them ad hoc inside `M-22` would widen scope and mix naming cleanup with runtime authority work.
- A later bounded doc-only slice can improve clarity without disturbing the now-active authority-convergence lane.

### [2026-04-07] Post-runtime eval authority invariant: eval stays bounded, bridge stays derived

**Decision**:
- Multi-axis post-runtime evaluation should extend the existing `packages/hep-mcp/src/eval/*` substrate rather than creating a second orchestrator-local or generic eval stack.
- Orchestrator may emit a runtime diagnostics bridge artifact that summarizes `run-manifest`, `spans.jsonl`, runtime markers, and terminal state, but that artifact remains derived bridge evidence rather than a second runtime authority or a new generic evaluation control plane.
- Protocol/interface perturbation remains a package-local eval harness until a later explicit genericization decision widens its scope; it must not silently become a generic runtime policy layer.
- Governance may ratify such bounded slices through tracker-only umbrella items when needed, but umbrella ratification records machine-readable truth without inventing new phase-counted remediation ids.

**Why**: Current evidence supports richer evaluation and diagnostics, but it does not support moving evaluation authority up into the generic control plane. Keeping outcome/perturbation close to the current domain-pack eval substrate while treating diagnostics as a derived bridge preserves the generic-first architecture and avoids parallel runtime authority drift.

### [2026-04-07] Control-plane object convergence invariant: keep one authority family per layer and treat projections as projections

**Decision**:
- Root project-run lifecycle and audit authority remains `RunState` + `LedgerEvent`; delegated runtime must not smuggle its own second root-run authority alongside that family.
- Delegated execution authority remains the team-runtime family (`TeamExecutionState` + `TeamDelegateAssignment` + `TeamAssignmentSession` plus team-local approval/checkpoint/event records). This family owns assignment/session lineage and assignment-local approval/checkpoint state.
- Runtime step-checkpoint authority remains `RunManifest`; it is a per-runtime-run resume ledger, not a project-run or task-graph authority.
- Research decomposition / follow-up authority remains the research-loop family (`ResearchTask` + `ResearchEvent` + `ResearchCheckpoint` + handoffs). It must not be silently replaced by assignment-local metadata, but it also should not be mistaken for live delegated-session authority.
- `AgentEvent`, runtime diagnostics bridge artifacts, run/team read models, and similar status summaries remain execution evidence or derived operator projections. They may summarize canonical authorities, but they must not become second authorities.
- `job` and durable `turn` are not yet first-class generic control-plane authorities. Future work may introduce typed seams or projections for them, but only by converging onto the existing run / delegated-execution / research-task families rather than creating a new parallel SSOT.

**Why**: The current orchestrator no longer suffers from a missing runtime substrate; it suffers from overlapping object language. Explicitly preserving one authority family per layer keeps later identity/session/read-model work from hardening today's string-convention seams into long-term architectural drift.

### [2026-04-07] Delegated runtime projection landed seam: record compact turn/session projection at source, not by synthetic backfill

**Decision**:
- `recordDelegatedRuntimeProjectionTurn(...)` is now the single internal builder for compact turn/session projection while `AgentRunner` still owns true dialogue/recovery boundaries; later consumers should reuse this seam rather than reprojecting turns from raw `AgentEvent[]`.
- Recovery pseudo-turns remain explicit sideband (`phase = 'recovery'`, `turn_count = 0`) so recovery stays auditable without pretending it is ordinary dialogue transcript authority.
- The landed projection enriches `executeDelegatedAgentRuntime(...)`, `runtime-diagnostics-bridge.ts`, and nullable real-session persistence on `TeamAssignmentSession.runtime_projection`, but it still does not widen current public host/team-view payloads or replace raw `AgentEvent[]` as low-level evidence.
- Vocabulary unification and operator-facing exposure of that projection remain later `CP-OBJ-01D` work rather than being pulled back into the projection slice itself.

**Why**: Raw `AgentEvent[]` lacked stable per-turn identity for tool-use turns, and the diagnostics bridge had been forced to rescan ad hoc markers after the fact. Landing one source-recorded compact projection seam fixes that specific gap without inventing another durable authority object and without transcript promotion.

### [2026-04-07] Unified operator read-model invariant: one shared interpreter across root/team/runtime, not a new public view object

**Decision**:
- `CP-OBJ-01D` is now landed around one internal shared interpreter seam, `packages/orchestrator/src/operator-read-model-summary.ts`, which owns bounded operator-facing vocabulary for runtime diagnostics summary, assignment approval attention, assignment -> task lifecycle/status projection, and ledger event -> root run status mapping.
- Root run read models remain rooted in root authority (`RunState` + `LedgerEvent` + pending approval). The shared interpreter may summarize ledger events, but it does not import team-local state or `runtime_projection` back into root authority.
- Team scoping/view and runtime diagnostics now reuse the same vocabulary family instead of maintaining parallel local interpreters, but this does not create a new durable control-plane object or widen current public host/team/run payloads.
- `status_*` ledger events remain an explicitly extensible operator sideband rather than a closed built-in enum, while the visible run-status filter now includes the concrete recovery/rejection states that the shared mapping can intentionally emit (`blocked`, `needs_recovery`, `rejected`).
- `CP-OBJ-01E` task bridge and `M-22` legacy cleanup remain separate follow-on work; `01D` does not authorize task-object promotion, transcript/job authority, or public view redesign.

**Why**: Once `CP-OBJ-01C` landed the runtime projection seam, the next real drift was interpretive: root run list, team live/background views, and runtime diagnostics were speaking adjacent but non-identical operator languages. Converging them onto one internal interpreter improves operator coherence and type soundness without hardening another authority family or reopening payload/UI debates.

### [2026-04-07] Research-task bridge invariant: internal task-ref registry first, not public team-payload widening

**Decision**:
- `CP-OBJ-01E` keeps canonical task authority in research-loop and bridges it into live delegated execution through one internal typed relation seam, `research_task_ref`, derived from the existing `ResearchTask` + delegated handoff pair.
- The bridge is established before launch by priming an internal task-ref sidecar registry (`primeDelegatedFollowupTeamState(...)`), then synchronizing that same canonical ref across assignment/session/checkpoint lineage inside team runtime, so pause/resume/recovery retain the canonical task relation even though the public `team` tool schema still only names `task_id` / `task_kind` / handoff ids.
- `live_status`, `replay`, `assignment_results`, and the public `team` payload remain unchanged; `TeamAssignmentSession.task_status` / `task_lifecycle_status` stay projections rather than becoming a second task authority.
- This bounded seam should remain the pattern for future control-plane convergence: persist canonical lineage in internal state first, then derive public/operator views separately if needed.

**Why**: The real gap was not missing public fields; it was that live delegated execution dropped the typed relation back to canonical task authority once follow-ups entered team runtime. Preserving that relation internally matches mature thread/session systems that keep canonical ids in durable history while projecting smaller operator summaries outward, and it closes the lineage hole without reopening payload/UI scope.

### [2026-04-07] Legacy Python lifecycle/workflow retirement invariant: generic authority stays on `autoresearch`, residue stays provider-local

**Decision**:
- Generic root lifecycle authority now lives only on the TS control plane: `autoresearch` / `packages/orchestrator` own `init`, `status`, `pause`, `resume`, `approve`, and `export`.
- `hep-autoresearch` / `hepar` must not regain direct public root lifecycle or approval-mutation authority. Any retained internal Python lifecycle surface is allowed only as a thin passthrough to canonical `autoresearch`, while the web surface is limited to read-only diagnostics.
- `research_workflow_v1` and `workflow-templates` are no longer live workflow authority. Recipe-based workflow authority now means `workflow_recipe_v1` + `packages/literature-workflows` + `meta/recipes`, and shared/generated exports must not imply a second graph-schema workflow substrate.
- Remaining `M-22` work is therefore bounded to residual provider-local non-computation `run` workflows and adjacent support surfaces, not generic lifecycle or workflow authority.

**Why**: This keeps the generic-first control plane from sliding back into dual authority through legacy Python shells or historical workflow graph residue. It also narrows future retirement work to the real remaining provider-local surface instead of reopening already-closed generic lifecycle/workflow questions.

### [2026-04-07] Projection-only surface invariant: bridge/web/fleet/legacy shells must not become second lifecycle or session authorities

**Decision**:
- Operator- or compatibility-facing surfaces such as legacy shells, diagnostics web views, runtime bridges, and fleet/status projections may summarize or forward canonical state, but they must not silently acquire their own lifecycle/session authority.
- When a legacy or provider-local command remains for maintainer/eval/regression coverage, it should be explicitly labeled as internal-only or compatibility-only in code and docs rather than implied to be part of the canonical public surface.
- Future guardrails should prefer an explicit command/surface inventory that classifies each entrypoint as canonical public, compatibility public, or internal-only, instead of relying only on scattered wording locks.
- After the 2026-04-08 shell retirement decision, this should be read operationally as canonical public vs internal-only for current live surfaces; any compatibility-public category is historical only unless a later checked-in decision explicitly reintroduces one.
- Approval/permission semantics should remain typed and scoped at the control-plane boundary (for example per-turn/per-session or per-run/per-project), while bridge/projection layers only carry the derived “blocked on what” context outward.

**Why**: Mature agent runtimes keep thread/session state, execution RPC, approval/permission decisions, and operator projections on separate seams. Preserving that separation in Autoresearch prevents `bridge`, `fleet`, diagnostics UIs, or legacy compatibility shells from hardening into a parallel control plane.

### [2026-04-07] Command/spec authority invariant: keep one exact source per live surface, and let overview docs stay summary-only

**Decision**:
- Command and tool inventories should be single-sourced per live authority surface rather than forced into one cross-language pseudo-registry.
- Top-level `autoresearch` public commands should live in the TS orchestrator source and directly drive parser/help behavior.
- The installable legacy `hepar` public shell is retired rather than preserved as a second public inventory. Any remaining Python parser residue must stay explicitly internal-only and separately classified from live public surfaces.
- Exact `orch_*` MCP tool listings belong only in the live spec surface that reads from the registry. Broader docs such as architecture overviews should summarize by tool family and link to that exact spec instead of carrying their own exact subsets.
- A future typed front-door authority map may generate docs/tests from a richer shared classification, but until that lands the invariant remains per-surface exact sources, not faux unification.

**Why**: A single cross-TS/Python "master command table" would create false shared authority and stale-doc drift. Mature runtimes instead keep one exact source per live boundary and let overview docs remain summary-level projections.

### [2026-04-08] Public `hepar` shell retirement boundary: installable aliases are removed from public authority

**Decision**:
- The installable public `hepar` / `hep-autoresearch` / `hep-autopilot` shell is retired outright; package metadata must no longer publish CLI aliases or npm bin wrappers for it.
- `packages/hep-autoresearch/src/hep_autoresearch/cli.py` and `python -m hep_autoresearch` now fail closed with a retirement message that points users back to the root `autoresearch` CLI.
- Former public support/operator verbs and workflow paths are internal full-parser coverage only for maintainer/eval/regression usage and must not be documented or tested as installable public entrypoints.
- The front-door authority map should no longer carry a `hepar_public_shell` surface id. It should classify only canonical public `autoresearch`, internal Python parser residue, and exact MCP tool spec surfaces.

**Why**: Even a "compatibility pointer" keeps the retired Python shell alive as a second branded front door and forces docs/tests/packaging to keep explaining it. Since the repo is still pre-release and does not carry backward-compatibility obligations, deleting the installable shell surface entirely is lower-risk and lower-maintenance than preserving a ceremonial wrapper.

### [2026-04-07] Legacy parser residue contraction invariant: delete wrappers, not underlying authority by accident

**Decision**:
- Retiring internal full-parser residue must distinguish parser wrappers from lower-level surviving authority. Deleting a legacy shell command is allowed and preferred when the shell itself is the residue, but that delete must not be misread as deleting still-live contracts, schemas, or state semantics underneath.
- Provider-local diagnostics/bridge wrappers such as `doctor` / `bridge` are delete-first candidates when they do not own generic control-plane authority.
- Commands that sit on top of still-live lower-level authority (for example run-card validation/normalization, branching state semantics, or revision-status reconciliation) require an explicit wrapper-vs-authority rebaseline before removal; do not keep the wrapper as a fallback, but do not delete the underlying authority blindly either.

**Why**: Delete-first retirement only stays safe if we remove the real residue rather than oscillating between two failure modes: preserving dead shells as fake compatibility authority, or over-deleting the lower-level contracts they happened to call. Making the wrapper/authority distinction explicit keeps the generic-first cleanup aggressive without turning it into accidental contract loss.

### [2026-04-07] Projection-only mutation guard invariant: delegated approval lists and fleet run lists must not become mutation authority

**Decision**:
- Delegated approval ownership stays on assignment-local canonical metadata (`approval_id`, `approval_packet_path`, `approval_requested_at`, `delegate_id`); `live_status.pending_approvals` is a derived view only and must neither persist nor gate `approve` interventions.
- Fleet enqueue must prove `run_id` existence from canonical project artifacts (`state.json`, `ledger.jsonl`, `artifacts/runs/<runId>`); `readRunListView()` remains observability/read-model output only and must not gate mutations.
- Projection surfaces may still expose helpful diagnostics, but those diagnostics cannot become the canonical source for workflow ownership, approval ownership, or mutation eligibility.

**Why**: Two different seams had drifted toward the same anti-pattern: a convenience projection (`pending_approvals`, run-list read model) was being treated like canonical state. Mature control planes keep mutation authority on durable typed facts and let projections stay read-time only; making that invariant explicit prevents similar drift from reappearing under new names.

### [2026-04-07] Idea host boundary invariant: installable `idea-mcp` is TS-only `idea-engine` host

**Decision**:
- The installable `idea-mcp` public host path is now the in-process TS `IdeaEngineRpcService`; legacy Python host selection/env knobs (`IDEA_MCP_BACKEND`, `IDEA_CORE_PATH`) are deleted from the public surface and must fail closed if provided.
- The public `idea-mcp` tool inventory is now a bounded exact-match surface with direct tool-level contract coverage: `campaign.init`, `campaign.status`, `search.step`, and `eval.run`. Unsupported lifecycle methods must be removed from the public inventory rather than advertised against a default backend that cannot serve them.
- Public `idea-mcp` and `idea-engine` now own the live host plus checked-in contract snapshots; retired Python/runtime package identities must not be reintroduced through transitional docs, asset paths, or contract filenames.

**Why**: The real drift was a split-brain host boundary: public `idea-mcp` still carried Python-side host semantics while TS `idea-engine` already owned the live active RPC path, and the public tool inventory still advertised methods the active host could not serve. Because this repo has no backward-compatibility requirement, preserving a public compatibility backend would only keep a second-rate authority path and ongoing maintenance burden alive. Deleting the fallback closes that boundary cleanly without over-claiming full retirement.

### [2026-04-07] Delegated runtime structural seam invariant: handle first, permission profile compile-first, transport delivery-only

**Decision**:
- The deeper delegated-runtime batch should land in the order `DelegatedRuntimeHandleV1 -> RuntimePermissionProfileV1 -> DelegatedRuntimeTransport`, even if earlier planning drafts listed transport before permission profile.
- `DelegatedRuntimeHandleV1` should stay an internal lineage/artifact seam over `project_run_id`, `assignment_id`, `session_id`, `runtime_run_id`, and delegated runtime artifact refs. It must not be promoted into public `team` payloads, `live_status`, `replay`, or transcript/history authority.
- `RuntimePermissionProfileV1` should become the typed compile source for tool visibility, execution policy, sandbox/filesystem/network allowances, approval scope/reviewer, and provenance/source context. Narrower runtime views such as `ToolPermissionView` should compile from it rather than remain the authority themselves.
- `DelegatedRuntimeTransport` should own delivery, liveness, interrupt/reconnect behavior only. It may carry handles and permission profiles, but it must not become canonical runtime/session state, fleet lease truth, or remote/UI session authority.

**Why**: Current orchestrator code still reconstructs delegated runtime identity across `execution-identity.ts`, `team-execution-scoping.ts`, `team-unified-runtime-support.ts`, and `delegated-agent-runtime.ts`, while permission semantics remain split across `team-execution-permissions.ts`, `tool-execution-policy.ts`, and host runtime inputs. Source audits of Codex and Claude Code converged on the same stable pattern: canonical state/lineage separate from transport, and typed permission surfaces separate from operator/UI rule stores.

### [2026-04-09] `hep-autoresearch/templates` retirement invariant: checked-in scaffold authority lives in `project-contracts`, not legacy provider-local prompt/template packs

**Decision**:
- `packages/hep-autoresearch/templates/` is retired from the checked-in public repo surface. The old human/agent prompt templates there are no longer live authority and should not be kept as dormant compatibility material.
- Scaffold markdown/template authority already lives in `packages/project-contracts/src/project_contracts/scaffold_templates/` and remains the only checked-in scaffold source consumed through the bridge loaders.
- Default approval-policy bootstrap for the Python orchestrator should stay embedded in code and the repo-local `.autoresearch/approval_policy.json` state path, rather than depending on a second checked-in template file under the legacy provider package.
- `knowledge_base/`, `references/`, and `specs/` must be audited separately from `templates/`: unlike the retired template pack, they still participate in package-local runtime/eval/schema authority and must not be deleted by association.

**Why**: Leaving the old template directory in place created a false impression that `hep-autoresearch` still owned a human-facing prompt/template surface, even though scaffold authority had already moved to the generic contracts package and the remaining JSON/prompt files had no live consumers. Removing the dead template pack reduces public drift without accidentally deleting still-live lower-level provider-local contracts.

### [2026-04-09] Plan schema checked-in source invariant: generic scaffold authority is rooted in `project-contracts`

**Decision**:
- The checked-in source for `plan.schema.json` is `packages/project-contracts/src/project_contracts/specs/plan.schema.json`.
- `packages/orchestrator/src/state-manager.ts` may keep an embedded copy for dependency isolation, but its provenance must point to `project-contracts`, not to `hep-autoresearch`.
- The duplicate `packages/hep-autoresearch/specs/plan.schema.json` is no longer the canonical generic scaffold source; any future retirement or consolidation work must treat it as provider-local residue or mirrored copy, not as front-door authority.

**Why**: `project-contracts` already owns new-project scaffold materialization and ships the plan schema in its install tree. Leaving generic comments or provenance notes pointed at `hep-autoresearch` would keep a false shared-authority story alive even after scaffold ownership moved to the generic contracts package.

### [2026-04-09] `hep-autoresearch` residual data/schemas bucket invariant: keep live provider-local fixtures, retire only dead public-looking residue

**Decision**:
- `packages/hep-autoresearch/templates/` is retired, but `packages/hep-autoresearch/specs/`, `packages/hep-autoresearch/knowledge_base/`, and `packages/hep-autoresearch/references/arxiv/` are not to be deleted by association.
- `packages/hep-autoresearch/specs/` currently remains provider-local runtime/eval/schema authority for Python computation/method-design/evals, except that generic `plan.schema.json` source authority has already moved to `project-contracts`.
- `packages/hep-autoresearch/knowledge_base/_index/` and `knowledge_base/_index/kb_profiles/*.json` remain live package-local KB seed fixtures consumed by `kb_profile` / context-pack / orchestrator regression coverage.
- `packages/hep-autoresearch/references/arxiv/*/metadata.json` remain package-local ingest/eval anchors, not generic public front-door truth.
- Generated hep-mcp inventory outputs must stay untracked under `.tmp/` rather than reappearing under tracked `references/` paths.

**Why**: The remaining `hep-autoresearch` residue is split: some files were truly dead public-looking template baggage, while others still anchor package-local schema validation, KB profile generation, regression fixtures, or ingest evals. Treating all residue as equally deletable would risk breaking still-live provider-local coverage; treating all of it as public authority would recreate the wrong generic-first story.

### [2026-04-09] Orchestrator alias retirement invariant: operator-facing filters and policy keys stay fail-closed and canonical

**Decision**:
- `packages/orchestrator` no longer accepts compatibility aliases for approval policy or run-status filters on its operator-facing tool surface.
- `handleOrchPolicyQuery()` reads only canonical `require_approval_for`; legacy `approval_required` keys are ignored rather than treated as an alternate policy shape.
- Approval filters accept only shared gate ids plus `all`; retired `A0` is not a valid filter.
- Fleet/run list status filters accept canonical `completed` only; `complete` is rejected at schema validation time.
- Cross-package host tests (for example `hep-mcp` contract coverage) must assert the same fail-closed behavior instead of preserving compatibility wording.

**Why**: The repository is still pre-release and explicitly carries no backward-compatibility burden. Keeping tiny aliases like `approval_required`, `A0`, or `complete` alive only creates more hidden support surface, more ambiguous docs/tests, and more future cleanup cost. Canonical operator/control-plane inputs should stay exact so drift is obvious and deletions are real.

### [2026-04-09] Internal runtime identity invariant: retired `hepar` branding must not survive as hidden runtime asset or A2A identity

**Decision**:
- `idea-engine` HEP search runtime records operator-template evidence URIs under `urn:idea-engine:operator-template:<version>`, not `urn:hepar:...`.
- Checked-in RPC golden fixtures for `idea-engine` must be regenerated against the live runtime after that rename so the fixture stays an anti-drift asset rather than a stale history packet.
- `hep-autoresearch` internal A2A / bound-agent error envelopes and MCP stdio client initialization use package-local `hep-autoresearch` identity strings, not `hepar` branding.

**Why**: Leaving `hepar` embedded in hidden runtime assets or internal transport envelopes would keep a second obsolete naming authority alive even after the public shell and docs were retired. Generic-first cleanup only really closes when active runtime artifacts, fixture goldens, and internal transport identities all stop reintroducing the old brand.

### [2026-04-09] Workspace freshness invariant: incremental TypeScript builds may leave emitted mtimes unchanged when output content is identical

**Decision**:
- Workspace freshness checks must not rely only on emitted `.js`/`.d.ts` mtimes to decide whether a package is stale.
- When TypeScript project builds are incremental/composite, `tsconfig.tsbuildinfo` may be the only file whose mtime advances after a valid no-op emit; freshness guards should treat that build info timestamp as evidence of a successful up-to-date build.
- Freshness guards must still fail when required emitted artifacts are missing; `tsbuildinfo` supplements artifact existence checks, it does not replace them.

**Why**: Type-only or declaration-neutral edits can legitimately trigger an incremental build that leaves generated files byte-identical and therefore untouched on disk. A freshness checker that only compares source mtimes to emitted artifact mtimes will then report false stale-dist failures and break downstream package builds even though the package was rebuilt successfully.
