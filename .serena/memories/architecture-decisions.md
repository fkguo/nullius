## Cross-Component Architecture Decisions

> This tracked Serena memory stores only stable, cross-session architecture decisions.
> Detailed closeout evidence, review rounds, exact validation commands, and item history live in `meta/remediation_tracker_v1.json` and the linked checked-in prompt/docs.

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
- The canonical minimal project-root surface is `project_charter.md`, `project_index.md`, `research_plan.md`, `research_notebook.md`, `research_contract.md`, and `.mcp.json.example`.
- Shared scaffold authority is complete only when every user-readable output is backed by a checked-in template inventory with bidirectional anti-drift checks.
- Host/provider extras remain optional, and provider bundles stay opt-in; generic scaffold examples must remain provider-neutral by default.

**Why**: A stable host-agnostic root surface prevents later control-plane drift and stops provider-specific defaults from becoming de facto core authority.

### [2026-03-23] External-root invariant: real projects stay outside the dev repo, maintainer fixtures stay explicit

**Decision**:
- Shared scaffold / contract authority now lives in the neutral Python package `packages/project-contracts/`; `research-team` public scaffold/contract-refresh entrypoints and `hep-autoresearch init` are consumers, not independent authorities.
- Public `real_project` flows must fail closed when the project root or real-project intermediate outputs resolve anywhere under `/home/user/Coding/Agents/autoresearch-lab`.
- Repo-internal workspaces are allowed only as explicit `maintainer_fixture` directories (for example `skills/research-team/skilldev` and `skills/research-team/.tmp/`) and must never become real-project authority or a hidden fallback mode.
- This slice is authority extraction plus isolation only; it does not repoint the generic control plane yet and does not preserve future `hepar` / `hep-autoresearch` aliases by default.

**Why**: The shared scaffold contract cannot remain credible while public research flows can still create or route real work back into the development monorepo. The explicit real-project vs maintainer-fixture split closes that hole without expanding into a full Pipeline A repoint.

### [2026-03-21] Pipeline A lifecycle invariant: `hep-autoresearch` and `hepar` move together

**Decision**:
- `hep-autoresearch` and its installable alias `hepar` are the same Pipeline A Python control-plane surface; they must not be governed as if one were retired while the other remained the default long-term authority.
- Current docs may still describe `hep-autoresearch` / `hepar` as usable transitional entrypoints, but long-term retirement semantics are shared unless a later design decision explicitly repoints one of those names onto the TS orchestrator surface.
- When a batch changes lifecycle status for a package / CLI / pipeline surface (`current`, `transitional`, `retired`, `repointed`), the checked-in governance/docs set must distinguish present usability from target architecture so user docs do not silently contradict `REDESIGN_PLAN`.

**Why**: The repository now has both a still-usable Python Pipeline A and a target TS control plane. Without an explicit invariant tying `hep-autoresearch` and `hepar` together and forcing current-vs-target wording, docs drift into contradictory states where one source says “retired” and another still presents the same surface as the default authority.

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

### [2026-03-24] Literature workflow authority invariant: executable authority lives in a leaf launcher, not in MCP facades

**Decision**:
- Checked-in executable literature workflow authority lives in the leaf workspace package `packages/literature-workflows/`, which is the only recipe reader / validator / resolver for literature workflow recipes.
- `packages/hep-autoresearch` (`hepar literature-gap`) and `skills/research-team` (`literature_fetch.py workflow-plan`) are consumers of that launcher authority; they must not re-own recipe semantics.
- Provider-specific MCP tools remain bounded atomic operators underneath the workflow layer. Generic workflow authority must not move back into `packages/hep-mcp/` or `packages/shared/`.
- Workflow-like public literature MCP tools are pruned directly from both `standard` and `full`; they do not get a transitional `full` holding area. The retained public literature surface is bounded atomic analysis/operator tools only.

**Why**: Governance-only recipe registration was not enough; without a checked-in executable launcher and consumer repoints, the repo kept two competing high-level front doors. Putting executable authority in a leaf launcher preserves a single workflow authority while keeping provider MCP packages atomic and reusable.

### [2026-03-25] EVO-11 distributor boundary invariant: TS live seam stays family-neutral, slice-1 policy stays fixed

**Decision**:
- Live distributor authority remains on the TS `packages/idea-engine/` `campaign.init` + `search.step` path; do not reopen Python `idea-core` as bandit runtime authority.
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

### [2026-03-26] Shell-boundary anti-drift invariant: enforce boundary truth before any future leaf shell

**Decision**:
- Boundary enforcement anti-drift must land before any future shell/gateway/frontend implementation work.
- The repo root remains the ecosystem/workbench/governance surface, not a product shell.
- Any packaged end-user agent remains a later leaf package after `P5A` closure rather than a root/orchestrator/provider promotion.
- `packages/shared` must not depend on provider-owned authority.
- `packages/orchestrator` must not depend on provider UX, shell, or app-layer authority.
- Host adapters must consume shared/orchestrator exports instead of re-defining generic authority locally.
- DeerFlow is borrowed here only for the boundary-test anti-drift pattern; DeerFlow gateway/frontend/workspace shell remain later adaptation work rather than current authority.

**Why**: The architectural boundary is already decided in ADRs and prior closeouts. The missing gap is continuously enforced packaging truth that keeps future shell/product work from drifting back into root/shared/orchestrator/provider authority confusion.
