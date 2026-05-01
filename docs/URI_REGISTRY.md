# URI Registry

This document is the centralized registry for URI schemes that are live in the current monorepo. It only records schemes that are emitted or resolved by checked-in code today. It does not redefine runtime semantics, introduce new schemes, or act as a future resolver/artifact-ref redesign spec.

It also does not elevate optional project-root support files into URI authority. Surfaces such as `prompts/`, `team/`, `research_team_config.json`, `.mcp.template.json`, and root `specs/plan.schema.json` are created later by explicit project need or host-specific tooling, while reconnect truth stays with project-local durable memory plus `.autoresearch/` state.

## Covered Schemes

The current emitted/resolved URI schemes covered by this registry are `hep://`, `pdg://`, `orch://`, `rep://`, `hepdata://`, `openalex://`, and `zotero://`.

| Scheme | Owner | Live authority | Surface type | Live patterns | Scope boundary |
|---|---|---|---|---|---|
| `hep://` | `@autoresearch/hep-mcp` | `packages/hep-mcp/src/core/resources.ts` | MCP `resources/list`, `resources/templates/list`, `resources/read` | `hep://projects`; `hep://runs`; `hep://projects/{project_id}`; `hep://projects/{project_id}/papers`; `hep://projects/{project_id}/artifact/{artifact_name}`; `hep://projects/{project_id}/papers/{paper_id}`; `hep://projects/{project_id}/papers/{paper_id}/evidence/catalog`; `hep://runs/{run_id}/manifest`; `hep://runs/{run_id}/artifact/{artifact_name}` | HEP project/run manifests and research artifacts only. It does not own orchestrator lifecycle/read-model state. |
| `pdg://` | `@autoresearch/pdg-mcp` | `packages/pdg-mcp/src/resources.ts` | MCP `resources/list`, `resources/templates/list`, `resources/read` | `pdg://info`; `pdg://artifacts`; `pdg://artifacts/{artifact_name}` | PDG server metadata and local PDG artifact cache only. It does not expose HEP project/run manifests. |
| `orch://` | `@autoresearch/orchestrator` | `packages/orchestrator/src/orch-tools/{approval,control,create-status-list,run-read-model}.ts`; `packages/orchestrator/src/workflow-runtime.ts`; `packages/orchestrator/src/cli-run.ts` | Tool-return lifecycle/read-model/artifact identifiers | `orch://runs/{run_id}`; `orch://runs/{run_id}/approvals/{approval_dir}`; `orch://runs/{run_id}/artifact/{artifact_path}`; `orch://runs/export` | Orchestrator lifecycle/read-model/export summaries and orchestrator-owned workflow/result artifacts only. This is not the current MCP `resources/list` authority and it does not own HEP research artifact payloads. |
| `rep://` | `@autoresearch/orchestrator`, `@autoresearch/rep-sdk`, shared generated schemas | `packages/orchestrator/src/orch-tools/index.ts`; `packages/orchestrator/src/orch-tools/{bridge-tools,final-conclusions}.ts`; `packages/orchestrator/src/computation/review-followup-gate.ts`; `packages/rep-sdk/schemas/artifact_ref_v1.schema.json`; `meta/schemas/artifact_ref_v1.schema.json` | Local artifact-ref identifiers, not MCP resources | `rep://runs/{run_id}/artifact/{artifact_path}`; older schema/test fixtures may also contain `rep://{run_id}/{artifact_path}` or `rep://run-1/...` examples | Local computation/staging/verification artifact references only. It is not a remote REP publishing surface in this lane. |
| `hepdata://` | `@autoresearch/hepdata-mcp` | `packages/hepdata-mcp/src/tools/registry.ts` | Tool-return artifact identifier, not MCP resources | `hepdata://artifacts/submissions/{hepdata_id}/hepdata_submission.zip` | Local HEPData download artifact pointer only. The server remains tool-only and does not expose `hepdata://` resources. |
| `openalex://` | `@autoresearch/openalex-mcp`, shared artifact-ref validators | `packages/openalex-mcp/src/api/contentDownload.ts`; `packages/shared/src/artifact-ref.ts` | Tool-return content/artifact identifier, not MCP resources | `openalex://content/{work_id}/{file_name}`; shared validators accept scoped artifact refs such as `openalex://works/{work_id}/artifact/{artifact_path}` | OpenAlex content/download artifact references only. The server remains tool-only and does not expose `openalex://` resources. |
| `zotero://` | `@autoresearch/zotero-mcp` | `packages/zotero-mcp/src/zotero/tools.ts` | Tool-return Zotero select URI, not MCP resources | `zotero://select/library/items/{item_key}` | Local Zotero item selection/deep-link pointer only. `@autoresearch/zotero-mcp` does not advertise MCP resources. |

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
4. Tool-return URI identifiers are not automatically MCP resources.
   `rep://`, `hepdata://`, `openalex://`, `zotero://`, and `orch://runs/{run_id}/artifact/{artifact_path}` are registered because checked-in code emits or resolves them, but they do not imply a package-level `resources/list` surface unless the owner package explicitly implements one.

## Non-Live Or Removed References

| Reference | Status | Replacement / note |
|---|---|---|
| `autoresearch-meta/docs/uri_registry.md` | Stale path | The current monorepo registry lives at `docs/URI_REGISTRY.md`. |
| `hep://corpora` | Removed | Do not treat it as a live resource entry point. The current live HEP entry points are `hep://projects` and `hep://runs`. |
| Bare `hep://runs/{run_id}` | Not a current live hep resource | Use `hep://runs/{run_id}/manifest` for the manifest view or `hep://runs/{run_id}/artifact/{artifact_name}` for artifact content. |
| `orch://runs/{run_id}/state` and `orch://runs/{run_id}/ledger` | Older design examples, not current live emitted URIs | Current checked-in tool surfaces emit `orch://runs/{run_id}`, `orch://runs/{run_id}/approvals/{approval_dir}`, and `orch://runs/export`. |
| Remote Streamable HTTP/OAuth MCP endpoint URIs | Not implemented in this lane | Current MCP connection truth is local stdio. Remote MCP deployment is a separate future surface. |

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
