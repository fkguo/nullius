# ADR: Root Ecosystem Boundary and Future Agent Packaging

- Status: Proposed
- Date: 2026-03-09
- Scope: monorepo root, orchestrator runtime, provider packaging, future product entrypoint

## Context

`autoresearch-lab` is already a monorepo, but its root entry still presents the repository as if it were only `hep-mcp`.
At the same time, the project SSOT defines a different long-term target:

- the core must remain domain-neutral;
- HEP is the first high-priority domain pack / provider, not the scope boundary;
- compute is capability-first / task-first, not package-first;
- the near/mid-term product is a single-user / single-project research system;
- community, publication, and research-evolution layers remain outer layers.

Recent progress strengthens this direction:

- `NEW-LOOP-01` established a single-user / single-project research-loop substrate in `packages/orchestrator/`;
- host-side MCP sampling routing and shared discovery authority are now present;
- `packages/orchestrator/` is becoming the runtime/control-plane nucleus;
- `packages/idea-engine/` exists as the future TypeScript home of idea evaluation logic, but is still mostly a placeholder.

The main remaining risk is not missing new features. It is boundary drift:

- root metadata still frames the whole repo as HEP-specific;
- some generic/core paths still embed HEP defaults or HEP-specific heuristics;
- a premature push toward a root-level “single true agent” would likely freeze those leaks into long-lived abstractions.

## Decision

### 1. Root is the ecosystem entrypoint, not the product agent

The repository root should represent the ecosystem/workbench and governance surface:

- monorepo entry documentation;
- stable project-level profiles/configuration;
- package discovery for local development and composition;
- governance SSOT and redesign planning.

The root should not become:

- a giant super-MCP;
- a root-level super-agent runtime;
- the place where domain logic or provider-specific execution semantics are unified.

### 2. `@autoresearch/orchestrator` is the runtime/control-plane nucleus

`packages/orchestrator/` is the primary home for:

- run/workspace/task/event graph runtime;
- approval/policy and auditable execution boundaries;
- routing and sampling control-plane logic;
- checkpoint/recovery and team-local execution state.

It should not absorb:

- domain-pack content;
- provider-specific scientific heuristics;
- community/fleet orchestration concerns before P5A closure.

Current orchestrator drift should be treated as re-baseline work, not as precedent:

- domain-specific environment names such as `HEP_AUTORESEARCH_DIR` should be renamed to domain-neutral control-plane names;
- embedded schema/comments that point to a domain package as the long-term authority should be generalized before more runtime features are layered on top.

### 3. Provider packages remain independently composable

Capability packages such as `*-mcp` should remain separate packages with clean boundaries.
The monorepo should prefer composition over aggregation:

- providers expose capabilities;
- orchestrator coordinates execution;
- shared contracts define typed seams;
- domain packs select or configure providers without redefining the core.

### 3a. `@autoresearch/shared` stays contract-level, not domain-authority

`packages/shared/` may define stable typed seams, but it should not become the place where one domain’s tool names, URI schemes, or runtime identities are treated as ecosystem-wide authority.

Near-term implications:

- domain-specific tool-name enumerations and risk maps should not hard-code one provider family as the generic baseline;
- provider URI schemes such as `hep://`, `pdg://`, or future domain/provider schemes are allowed, but shared URI parsing/validation should be scheme-aware or registry-driven rather than single-scheme hard-coded.

### 4. A future productized agent belongs in its own leaf package

If and when the ecosystem needs a single packaged end-user agent, it should be introduced as a dedicated leaf package rather than by promoting the repo root or a domain-specific CLI into the generic product entry.

The final package name is intentionally left open for now. Plausible shapes include:

- `packages/agent/`
- `packages/autoresearch-agent/`

That package would assemble:

- `@autoresearch/orchestrator`
- root-level profiles/catalog metadata
- a selected provider set
- a user-facing CLI / app entrypoint

It should consume the ecosystem. It should not redefine it.
No placeholder package should be created before P5A execution semantics and provider boundaries are materially more stable.
Legal trigger for creating that leaf package:

- `P5A` closeout is marked complete in the tracker;
- at least two non-HEP provider/domain-pack seams exist in the monorepo;
- root / shared / orchestrator boundaries have already been re-baselined as provider-agnostic.

### 5. Near-term root composition should stay minimal

Before P5A closure, the root may add only a thin, checked-in composition layer:

- simple profile files;
- lightweight package catalog metadata;
- minimal developer-facing assembly docs.

Do not introduce a heavy dynamic registry/materializer platform yet.
That abstraction should wait until:

- P5A execution semantics are stable;
- provider classes and package boundaries are cleaner;
- the shared fields required by a registry are demonstrated, not guessed.

## Consequences

### Immediate implications

- root README/package metadata should be de-HEP-ized into ecosystem language;
- generic/core HEP leakage must be removed before `NEW-05a Stage 3` calcifies it into `idea-engine`;
- shared-layer HEP leakage must be removed before `NEW-05a Stage 3` turns current constants/URI assumptions into long-lived TS authority;
- provider-local fallback paths such as `~/.hep-mcp/openalex` should be replaced with domain-neutral defaults or explicit provider config;
- `EVO-13` remains valid, but must stay scoped to single-project / team-local runtime unification;
- `P5A` remains the primary forcing function; `P5B` remains outer-layer work.

### Explicit non-goals for now

- no root-level super-agent;
- no root-level super-MCP;
- no early cross-instance/fleet orchestration layer;
- no premature dynamic registry/materializer platform.

## Required re-baselines

1. Reframe root entry/docs/metadata as monorepo ecosystem entry, with HEP as first provider family rather than root identity.
2. Extract HEP-specific compute rubric/default-pack assumptions out of generic/core paths before TypeScript porting.
3. Amend `NEW-05a Stage 3` acceptance so that generic `idea-engine` cannot carry domain-specific symbols except through domain-pack/provider seams.
4. Keep `EVO-13` scoped to team-local, single-project runtime unification; do not let it absorb community/fleet semantics.
5. Introduce only a minimal root profile/catalog layer before P5A closure; defer heavy registry/materializer design.
6. Remove domain-specific tool-name and tool-risk authority from `packages/shared/`; keep shared contract-level and provider/domain registration separate.
7. Replace orchestrator’s domain-specific environment names and comments that anchor long-term authority to a domain package.
8. Replace single-scheme artifact URI helpers in shared with scheme-aware or registry-driven helpers so provider-specific schemes do not define the generic layer.

## Review questions

1. Is the root/ecosystem vs product-agent boundary stated clearly enough?
2. Is the recommendation to defer heavy registry/materializer work until after cleaner P5A closure correct?
3. Is `packages/autoresearch-agent/` the right future location for a packaged end-user agent?
4. Are any remaining redesign items structurally wrong, or do they only require re-baselining?
