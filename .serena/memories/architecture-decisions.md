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
