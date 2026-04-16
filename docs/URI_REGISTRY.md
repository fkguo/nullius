# URI Registry

This document is the centralized registry for URI schemes that are live in the current monorepo. It only records schemes that are emitted or resolved by checked-in code today. It does not redefine runtime semantics, introduce new schemes, or act as a future resolver/artifact-ref redesign spec.

It also does not elevate optional project-root support files into URI authority. Surfaces such as `prompts/`, `team/`, `research_team_config.json`, `.mcp.template.json`, and root `specs/plan.schema.json` remain opt-in support layers, while reconnect truth stays with project-local durable memory plus `.autoresearch/` state.

## Live Schemes

Live scheme set for this monorepo is exactly `hep://`, `pdg://`, and `orch://`.

| Scheme | Owner | Live authority | Surface type | Live patterns | Scope boundary |
|---|---|---|---|---|---|
| `hep://` | `@autoresearch/hep-mcp` | `packages/hep-mcp/src/core/resources.ts` | MCP `resources/list`, `resources/templates/list`, `resources/read` | `hep://projects`; `hep://runs`; `hep://projects/{project_id}`; `hep://projects/{project_id}/papers`; `hep://projects/{project_id}/artifact/{artifact_name}`; `hep://projects/{project_id}/papers/{paper_id}`; `hep://projects/{project_id}/papers/{paper_id}/evidence/catalog`; `hep://runs/{run_id}/manifest`; `hep://runs/{run_id}/artifact/{artifact_name}` | HEP project/run manifests and research artifacts only. It does not own orchestrator lifecycle/read-model state. |
| `pdg://` | `@autoresearch/pdg-mcp` | `packages/pdg-mcp/src/resources.ts` | MCP `resources/list`, `resources/templates/list`, `resources/read` | `pdg://info`; `pdg://artifacts`; `pdg://artifacts/{artifact_name}` | PDG server metadata and local PDG artifact cache only. It does not expose HEP project/run manifests. |
| `orch://` | `@autoresearch/orchestrator` | `packages/orchestrator/src/orch-tools/{approval,control,create-status-list,run-read-model}.ts` | Tool-return lifecycle/read-model identifiers | `orch://runs/{run_id}`; `orch://runs/{run_id}/approvals/{approval_dir}`; `orch://runs/export` | Orchestrator lifecycle/read-model/export summaries only. This is not the current MCP `resources/list` authority and it does not own research artifact payloads. |

## Boundary Rules

1. `hep://` and `orch://` are separate owned namespaces.
   `hep://runs/{run_id}/manifest` and `hep://runs/{run_id}/artifact/{artifact_name}` are the research-artifact views owned by `@autoresearch/hep-mcp`.
   `orch://runs/{run_id}` and `orch://runs/{run_id}/approvals/{approval_dir}` are the lifecycle/read-model views owned by `@autoresearch/orchestrator`.
   The current codebase does not expose a shared cross-scheme resolver or alias between the two schemes.
   There is no implicit `hep://` <-> `orch://` aliasing layer in live authority.
2. `pdg://` is intentionally separate from `hep://`.
   It models PDG server metadata plus the local PDG artifact cache and should not be used as a project/run namespace.
3. Scheme ownership stays package-local.
   New live patterns must be added in the owner package first and only then registered here.

## Non-Live Or Removed References

| Reference | Status | Replacement / note |
|---|---|---|
| `autoresearch-meta/docs/uri_registry.md` | Stale path | The current monorepo registry lives at `docs/URI_REGISTRY.md`. |
| `hep://corpora` | Removed | Do not treat it as a live resource entry point. The current live HEP entry points are `hep://projects` and `hep://runs`. |
| Bare `hep://runs/{run_id}` | Not a current live hep resource | Use `hep://runs/{run_id}/manifest` for the manifest view or `hep://runs/{run_id}/artifact/{artifact_name}` for artifact content. |
| `orch://runs/{run_id}/state` and `orch://runs/{run_id}/ledger` | Older design examples, not current live emitted URIs | Current checked-in tool surfaces emit `orch://runs/{run_id}`, `orch://runs/{run_id}/approvals/{approval_dir}`, and `orch://runs/export`. |

## Audit Basis

- `docs/ARCHITECTURE.md`
- `docs/README_zh.md`
- `docs/TESTING_GUIDE.md`
- `docs/SKILL_MCP_BRIDGE.md`
- `meta/docs/orchestrator-mcp-tools-spec.md`
- `packages/hep-mcp/src/core/resources.ts`
- `packages/pdg-mcp/src/resources.ts`
- `packages/orchestrator/src/orch-tools/*.ts`

When another document needs to describe URI truth at a cross-package level, it should point back to this registry instead of creating a second authority list.
