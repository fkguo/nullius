# URI Registry

This document is the centralized registry for URI-like identifiers that are emitted or resolved by checked-in code today. It does not redefine runtime semantics, introduce new schemes, or act as a future resolver/artifact-ref redesign spec. It is not an MCP resources contract; current MCP servers expose tools only.

It also does not elevate optional project-root support files into URI authority. Surfaces such as `prompts/`, `team/`, `research_team_config.json`, `.mcp.template.json`, and root `specs/plan.schema.json` are created later by explicit project need or host-specific tooling, while reconnect truth stays with project-local durable memory plus `.nullius/` state.

## Covered Schemes

The current emitted/resolved URI schemes covered by this registry are `hep://`, `pdg://`, `orch://`, `rep://`, `hepdata://`, `openalex://`, `zotero://`, `file://`, and `project://`.

| Scheme | Owner | Live authority | Surface type | Live patterns | Scope boundary |
|---|---|---|---|---|---|
| `hep://` | `@nullius/hep-mcp` | `packages/hep-mcp/src/core/runArtifactUri.ts`; `packages/hep-mcp/src/core/uriReader.ts` | Tool-return/local artifact identifiers, not MCP resources | `hep://projects`; `hep://runs`; `hep://projects/{project_id}`; `hep://projects/{project_id}/papers`; `hep://projects/{project_id}/artifact/{artifact_name}`; `hep://projects/{project_id}/papers/{paper_id}`; `hep://projects/{project_id}/papers/{paper_id}/evidence/catalog`; `hep://runs/{run_id}/manifest`; `hep://runs/{run_id}/artifact/{artifact_name}` | HEP project/run manifests and research artifacts only. It does not own orchestrator lifecycle/read-model state. |
| `pdg://` | `@nullius/pdg-mcp` | `packages/pdg-mcp/src/artifacts.ts`; `packages/pdg-mcp/src/tools/registry.ts` | Tool-return/local artifact identifiers, not MCP resources | `pdg://artifacts/{artifact_name}` | PDG local artifact cache identifiers only. Full artifacts live under `PDG_DATA_DIR/artifacts`; the server does not expose MCP resources. |
| `orch://` | `@nullius/orchestrator` | `packages/orchestrator/src/orch-tools/{approval,control,create-status-list,run-read-model}.ts`; `packages/orchestrator/src/workflow-runtime.ts`; `packages/orchestrator/src/cli-run.ts` | Tool-return lifecycle/read-model/artifact identifiers | `orch://runs/{run_id}`; `orch://runs/{run_id}/approvals/{approval_dir}`; `orch://runs/{run_id}/artifact/{artifact_path}`; `orch://runs/export` | Orchestrator lifecycle/read-model/export summaries and orchestrator-owned workflow/result artifacts only. It does not own HEP research artifact payloads. |
| `rep://` | `@nullius/orchestrator`, `@nullius/rep-sdk`, shared generated schemas | `packages/orchestrator/src/orch-tools/index.ts`; `packages/orchestrator/src/orch-tools/{bridge-tools,final-conclusions}.ts`; `packages/orchestrator/src/computation/review-followup-gate.ts`; `packages/rep-sdk/schemas/artifact_ref_v1.schema.json`; `meta/schemas/artifact_ref_v1.schema.json` | Local artifact-ref identifiers, not MCP resources | `rep://runs/{run_id}/artifact/{artifact_path}` is the canonical form that current orchestrator code emits and validates. The live `artifact_ref_v1` schema `uri` description still shows the simplified `rep://{run_id}/{artifact_path}` example, and older test fixtures may contain `rep://{run_id}/{artifact_path}` or `rep://run-1/...`; treat the 4-segment `rep://runs/.../artifact/...` form as authoritative. | Local computation/staging/verification artifact references only. It is not a remote REP publishing surface in this lane. |
| `hepdata://` | `@nullius/hepdata-mcp` | `packages/hepdata-mcp/src/tools/registry.ts` | Tool-return artifact identifier, not MCP resources | `hepdata://artifacts/submissions/{hepdata_id}/hepdata_submission.zip` (format=`original`); `hepdata://artifacts/submissions/{hepdata_id}/hepdata_submission.json` (format=`json`); `hepdata://artifacts/submissions/{hepdata_id}/hepdata_submission_{format}.tar.gz` (science formats `csv`/`root`/`yaml`/`yoda`/`yoda1`/`yoda_h5`) | Local HEPData download artifact pointer only. The per-format filename keeps `hepdata_download` formats from overwriting each other. The server remains tool-only and does not expose `hepdata://` resources. |
| `openalex://` | `@nullius/openalex-mcp`, shared artifact-ref validators | `packages/openalex-mcp/src/api/contentDownload.ts`; `packages/shared/src/artifact-ref.ts` | Tool-return content/artifact identifier, not MCP resources | `openalex://content/{work_id}/{file_name}`; shared validators accept scoped artifact refs such as `openalex://works/{work_id}/artifact/{artifact_path}` | OpenAlex content/download artifact references only. The server remains tool-only and does not expose `openalex://` resources. |
| `zotero://` | `@nullius/zotero-mcp` | `packages/zotero-mcp/src/zotero/tools.ts` | Tool-return Zotero select URI, not MCP resources | `zotero://select/library/items/{item_key}` | Local Zotero item selection/deep-link pointer only. `@nullius/zotero-mcp` does not advertise MCP resources. |
| `file://` | `@nullius/idea-engine` | `packages/idea-engine/src/service/{node-promote-executor,rank-compute-executor,import-generated-executor}.ts` emit via `pathToFileURL(...).href`; `handoff`/`ranking` refs are resolved by `packages/orchestrator/src/computation/idea-engine-feedback.ts` and `packages/hep-mcp/src/tools/idea-staging.ts` | Tool-return/cross-package artifact-ref handoff identifiers, not MCP resources | `file://<absolute-artifact-path>` for idea-engine `handoff` / `ranking` / `generation` (pack) artifact refs | Standard local file URL of an idea-engine artifact path. `handoff`/`ranking` refs are consumed by the orchestrator/HEP idea-staging bridge; `generation` pack refs are engine-archived audit units (recorded on imported nodes' traces and read back by the engine's own crash recovery), with no bridge consumer. It is not an owned project/run namespace and not an MCP resource. |
| `project://` | `skills/idea-posterior` | Emitted by `skills/idea-posterior/scripts/run_infer_and_extract.py`; validated and resolved by `skills/idea-posterior/scripts/posterior_writeback.py` | Machine-portable project-relative package reference stored in idea-store posteriors, not an MCP resource | `project://<percent-encoded project-relative path>#sha256:<ir_hash>` as the `gaia_package_ref` of `node.set_posterior` payloads | Resolves against the enclosing project root (the nearest ancestor directory containing `.nullius/`); the path must stay inside that root (no empty or `..` segments), and the fragment pins the package's compiled-graph state. Deliberately relative: research projects sync across machines, so machine-absolute forms go stale. The idea-engine stores the value opaquely under its `format: "uri"` typing and never resolves it. |

## Boundary Rules

1. `hep://` and `orch://` are separate owned namespaces.
   `hep://runs/{run_id}/manifest` and `hep://runs/{run_id}/artifact/{artifact_name}` are the research-artifact views owned by `@nullius/hep-mcp`.
   `orch://runs/{run_id}` and `orch://runs/{run_id}/approvals/{approval_dir}` are the lifecycle/read-model views owned by `@nullius/orchestrator`.
   The current codebase does not expose a shared cross-scheme resolver or alias between the two schemes.
   There is no implicit `hep://` <-> `orch://` aliasing layer in live authority.
2. `pdg://` is intentionally separate from `hep://`.
   It models PDG server metadata plus the local PDG artifact cache and should not be used as a project/run namespace.
3. Scheme ownership stays package-local.
   New live patterns must be added in the owner package first and only then registered here.
4. Tool-return URI identifiers are not automatically MCP resources.
   Registered identifiers are local pointers or owner-package resolver inputs. They do not imply a package-level MCP resources surface.

## Non-Live Or Removed References

| Reference | Status | Replacement / note |
|---|---|---|
| `autoresearch-meta/docs/uri_registry.md` | Stale path | The current monorepo registry lives at `docs/URI_REGISTRY.md`. |
| `hep://corpora` | Removed | Do not treat it as a live entry point. Current HEP tools return project/run ids and local artifact identifiers. |
| Bare `hep://runs/{run_id}` | Not a current live HEP artifact identifier | Use the manifest file path from the job envelope or `hep://runs/{run_id}/artifact/{artifact_name}` when code explicitly returns that identifier. |
| `orch://runs/{run_id}/state` and `orch://runs/{run_id}/ledger` | Older design examples, not current live emitted URIs | Current checked-in tool surfaces emit `orch://runs/{run_id}`, `orch://runs/{run_id}/approvals/{approval_dir}`, and `orch://runs/export`. |
| Remote Streamable HTTP/OAuth MCP endpoint URIs | Not implemented in this lane | Current MCP connection truth is local stdio. Remote MCP deployment is a separate future surface. |

## Audit Basis

- `docs/ARCHITECTURE.md`
- `docs/README_zh.md`
- `docs/TESTING_GUIDE.md`
- `docs/SKILL_MCP_BRIDGE.md`
- `meta/docs/orchestrator-mcp-tools-spec.md`
- `packages/hep-mcp/src/core/runArtifactUri.ts`
- `packages/hep-mcp/src/core/uriReader.ts`
- `packages/pdg-mcp/src/artifacts.ts`
- `packages/orchestrator/src/orch-tools/*.ts`
- `packages/idea-engine/src/service/*.ts`

When another document needs to describe URI truth at a cross-package level, it should point back to this registry instead of creating a second authority list.
