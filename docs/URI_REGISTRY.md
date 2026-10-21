# URI Registry

This document is the centralized registry for URI-like identifiers that are emitted or resolved by checked-in code today. It does not redefine runtime semantics, introduce new schemes, or act as a future resolver/artifact-ref redesign spec. It is not an MCP resources contract; current MCP servers expose tools only.

It also does not elevate optional project-root support files into URI authority. Surfaces such as `prompts/`, `team/`, `research_team_config.json`, `.mcp.template.json`, and root `specs/plan.schema.json` are created later by explicit project need or host-specific tooling, while reconnect truth stays with project-local durable memory plus `.nullius/` state.

[`project-mcp`](../packages/project-mcp/README.md) and the [personal plugin](../packages/skills-market/docs/PERSONAL_PLUGIN.md) add no URI scheme or MCP resource surface. `nullius runtime path` and host-private runtime configuration resolve local installation paths only; they add no URI authority. `project_file_read` reads permitted real files under `NULLIUS_PROJECT_ROOT` in bounded chunks; it is not a resolver for the schemes below. Provider caches outside the bound project are not exposed through that file API. A delivery ID identifies a transport response in the existing run-manifest machinery, not a new research artifact namespace.

Notebook content-review evidence uses existing `ArtifactRef` references for its
verification subject, check-run, verdict and coverage records; it introduces no
URI scheme. The reviewed complete UTF-8 notebook (automatic block included) and
required declared dependencies are pinned by SHA-256 of their actual bytes,
including uncommitted edits. A URI or commit alone cannot establish current
content acceptance. See [human notebook integration](../packages/orchestrator/README.md#human-notebook-integration)
for the full-text review contract.

Automatically linked binary or invalid UTF-8 sources appear as immutable
`opaque_links` snapshots and SHA-256 locators without embedding or reading
their content. Single-call review includes the original locators in the review
manifest's freshness checks. Batched review binds their hashes in the joint
inventory and streams the original bytes for full-material freshness before
dispatch and at current acceptance. `opaque_sources` assesses each
path/hash/`required_for_reasoning`; missing assessments and necessary unread
sources cannot grant content acceptance. A hash locator proves identity only. Large valid text stays in the recursively
discovered text closure. Batch plans, original interval receipts and a full-original
joint audit use these same ArtifactRefs. A resumed run references the original
receipt under its original run ID; it never relocates or rewrites that evidence.

## Covered Schemes

The current emitted/resolved URI schemes covered by this registry are `pdg://`, `orch://`, `rep://`, `hepdata://`, `openalex://`, `zotero://`, `file://`, and `project://`. `hep://` identifiers are historical only: no current tool emits or resolves them (see Historical `hep://runs` references and Historical `hep://projects` references below).

| Scheme | Owner | Live authority | Surface type | Live patterns | Scope boundary |
|---|---|---|---|---|---|
| `pdg://` | `@nullius/pdg-mcp` | `packages/pdg-mcp/src/artifacts.ts`; `packages/pdg-mcp/src/tools/registry.ts` | Tool-return/local artifact identifiers, not MCP resources | `pdg://artifacts/{artifact_name}` | PDG local artifact cache identifiers only. Full artifacts live under `PDG_DATA_DIR/artifacts`; the server does not expose MCP resources. |
| `orch://` | `@nullius/orchestrator` | `packages/orchestrator/src/orch-tools/{approval,control,create-status-list,run-read-model}.ts`; `packages/orchestrator/src/workflow-runtime.ts`; `packages/orchestrator/src/cli-run.ts` | Tool-return lifecycle/read-model/artifact identifiers | `orch://runs/{run_id}`; `orch://runs/{run_id}/approvals/{approval_dir}`; `orch://runs/{run_id}/artifact/{artifact_path}`; `orch://runs/export` | Orchestrator lifecycle/read-model/export summaries and orchestrator-owned workflow/result artifacts only. It does not own HEP research artifact payloads. |
| `rep://` | `@nullius/orchestrator`, `@nullius/rep-sdk`, shared generated schemas | `packages/orchestrator/src/orch-tools/index.ts`; `packages/orchestrator/src/orch-tools/{bridge-tools,final-conclusions}.ts`; `packages/orchestrator/src/computation/review-followup-gate.ts`; `packages/rep-sdk/schemas/artifact_ref_v1.schema.json`; `meta/schemas/artifact_ref_v1.schema.json` | Local artifact-ref identifiers, not MCP resources | `rep://runs/{run_id}/artifact/{artifact_path}` is the canonical form that current orchestrator code emits and validates. The live `artifact_ref_v1` schema `uri` description still shows the simplified `rep://{run_id}/{artifact_path}` example, and older test fixtures may contain `rep://{run_id}/{artifact_path}` or `rep://run-1/...`; treat the 4-segment `rep://runs/.../artifact/...` form as authoritative. | Local computation/staging/verification artifact references only. It is not a remote REP publishing surface in this lane. |
| `hepdata://` | `@nullius/hepdata-mcp` | `packages/hepdata-mcp/src/tools/registry.ts` | Tool-return artifact identifier, not MCP resources | `hepdata://artifacts/submissions/{hepdata_id}/hepdata_submission.zip` (format=`original`); `hepdata://artifacts/submissions/{hepdata_id}/hepdata_submission.json` (format=`json`); `hepdata://artifacts/submissions/{hepdata_id}/hepdata_submission_{format}.tar.gz` (science formats `csv`/`root`/`yaml`/`yoda`/`yoda1`/`yoda_h5`) | Local HEPData download artifact pointer only. The per-format filename keeps `hepdata_download` formats from overwriting each other. The server remains tool-only and does not expose `hepdata://` resources. |
| `openalex://` | `@nullius/openalex-mcp`, shared artifact-ref validators | `packages/openalex-mcp/src/api/contentDownload.ts`; `packages/shared/src/artifact-ref.ts` | Tool-return content/artifact identifier, not MCP resources | `openalex://content/{work_id}/{file_name}`; shared validators accept scoped artifact refs such as `openalex://works/{work_id}/artifact/{artifact_path}` | OpenAlex content/download artifact references only. The server remains tool-only and does not expose `openalex://` resources. |
| `zotero://` | `@nullius/zotero-mcp` | `packages/zotero-mcp/src/zotero/tools.ts` | Tool-return Zotero select URI, not MCP resources | `zotero://select/library/items/{item_key}` | Local Zotero item selection/deep-link pointer only. `@nullius/zotero-mcp` does not advertise MCP resources. |
| `file://` | `@nullius/idea-engine`, `@nullius/orchestrator` | `packages/idea-engine/src/store/engine-store.ts` returns local file URLs from `writeArtifact`; `packages/orchestrator/src/computation/idea-engine-feedback.ts` accepts a local file URL or bare path as its handoff input | Local file artifact identifiers and accepted local handoff inputs, not MCP resources | `file://<absolute-artifact-path>` | `node.promote` and `rank.compute` return `project://` refs, not the file URL returned by the lower-level writer. Computation feedback accepts local file URLs or bare paths; it does not resolve `project://` refs and does not consume ranking refs. |
| `project://` | `@nullius/idea-engine`, `skills/idea-posterior`, `skills/research-team` | Handoff and ranking refs emitted by `packages/idea-engine/src/service/{node-promote-executor,rank-compute-executor}.ts` through `store.portableArtifactRef`; generation pack refs emitted and resolved by `packages/idea-engine/src/{store/engine-store.ts,service/import-generated-executor.ts,service/import-generated-recovery.ts}`; Gaia package refs emitted by `skills/idea-posterior/scripts/run_infer_and_extract.py`; Gaia and bound literature-ledger refs validated by `skills/idea-posterior/scripts/posterior_writeback.py`; raw bibliography and canonical-metadata provenance refs validated by `skills/research-team/scripts/gates/check_literature_trace.py` | Machine-portable project-relative content-pinned references stored in idea-store nodes/posteriors or literature coverage receipts, not MCP resources | `project://<percent-encoded project-relative path>#sha256:<64 lowercase hex>` for idea-engine handoff, ranking, and generated-pack artifacts; `project://<percent-encoded project-relative path>#sha256:<exact_ir_json_hash>` for `gaia_package_ref`; `project://<project-relative path>#sha256:<exact_artifact_hash>` for combined literature ledgers, raw bibliography manifests, and archived provider metadata/triangulation blocks | Resolves against the enclosing project root (explicit project root when provided; otherwise the owning tool's project-root inference). The path must stay inside the project root (and, for idea-engine pack artifacts, inside the engine store root), with no empty or `..` segments. Hash semantics are producer-specific: `node.promote` and `rank.compute` hash canonical JSON payloads, not the stored JSON file's exact bytes. The ordinary idea-store loader validates hash syntax and path containment but does not recompute the digest. Literature survey bibliography and method summaries must reference the same combined ledger; writeback resolves it and recomputes provider accounting, candidate/core closure, bibliography, method, and graph status before storage. The current orchestrator computation-feedback path does not resolve these portable handoff refs; this producer/consumer limitation remains open. Deliberately relative: research projects sync across machines, so machine-absolute forms go stale. |

## Boundary Rules

1. `hep://` and `orch://` are separate owned namespaces.
   `hep://` identifiers are historical only: earlier `@nullius/hep-mcp` versions named their own runs and paper/evidence projects with them. hep-mcp now keeps neither, and files its tools produce are returned as project-relative paths inside a caller-chosen `output_dir`.
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
| `hep://corpora` | Removed | Do not treat it as a live entry point. Current HEP tools return project-relative output paths. |
| `hep://projects`, `hep://projects/{project_id}`, `hep://projects/{project_id}/artifact/{artifact_name}`, `hep://projects/{project_id}/papers`, `hep://projects/{project_id}/papers/{paper_id}`, `hep://projects/{project_id}/papers/{paper_id}/evidence/catalog` | Historical only; no longer created | Resolve historical references by hand or script with the rule in Historical `hep://projects` references. |
| `hep://runs`, `hep://runs/{run_id}`, `hep://runs/{run_id}/manifest`, `hep://runs/{run_id}/artifact/{artifact_name}` | Historical only; no longer created | Resolve historical references by hand or script with the rule in Historical `hep://runs` references. |
| `orch://runs/{run_id}/state` and `orch://runs/{run_id}/ledger` | Older design examples, not current live emitted URIs | Current checked-in tool surfaces emit `orch://runs/{run_id}`, `orch://runs/{run_id}/approvals/{approval_dir}`, and `orch://runs/export`. |
| Remote Streamable HTTP/OAuth MCP endpoint URIs | Not implemented in this lane | Current MCP connection truth is local stdio. Remote MCP deployment is a separate future surface. |

## Historical `hep://runs` references

Earlier hep-mcp versions kept their own runs and returned `hep://runs/...` identifiers. Research projects and notes may still cite them, by file path or by URI. hep-mcp no longer creates these runs or identifiers, and no current tool resolves them; they map to files by this rule:

| Historical reference | File |
|---|---|
| `hep://runs/<run_id>/artifact/<name>` | `<HEP data root>/runs/<run_id>/artifacts/<name>` |
| `hep://runs/<run_id>/manifest` | `<HEP data root>/runs/<run_id>/manifest.json` |
| `hep://runs` | No file: it named a listing produced on read from the run manifests; read the directory `<HEP data root>/runs/` instead |
| `hep://runs/<run_id>` | Never emitted or resolved by a tool; if cited, it can only mean the run directory `<HEP data root>/runs/<run_id>/`, described by its `manifest.json` |

`<HEP data root>` is the one in force when the reference was written: `<project_root>/artifacts/hep-mcp` when the call named a project root; otherwise `$HEP_DATA_DIR` as configured at that time; otherwise the scratch default of the version that wrote it: `~/.hep-research-mcp` until 2026-02-26, `~/.hep-mcp` from 2026-02-26 until 2026-05-16, `~/.autoresearch/hep-mcp` from 2026-05-16 until 2026-07-05, and `~/.nullius/hep-mcp` since 2026-07-05. The run manifest's `created_at` dates a run; around a changeover date, look in both candidate directories. `<run_id>` and `<name>` are the percent-decoded URI path segments.

These directories are historical evidence: read them in place, and never rewrite, move, or delete them.

## Historical `hep://projects` references

Earlier hep-mcp versions also kept paper/evidence projects (with an evidence catalog per paper) and returned `hep://projects/...` identifiers. hep-mcp no longer creates these projects, catalogs or identifiers, and no current tool resolves them; they map to files by this rule:

| Historical reference | File |
|---|---|
| `hep://projects/<project_id>` | `<HEP data root>/projects/<project_id>/project.json` |
| `hep://projects/<project_id>/artifact/<name>` | `<HEP data root>/projects/<project_id>/artifacts/<name>` |
| `hep://projects/<project_id>/papers/<paper_id>` | `<HEP data root>/projects/<project_id>/papers/<paper_id>/paper.json` |
| `hep://projects/<project_id>/papers/<paper_id>/evidence/catalog` | `<HEP data root>/projects/<project_id>/papers/<paper_id>/evidence/catalog.jsonl` |
| `hep://projects` | No single file: a JSON listing built on read, `{"projects": [...]}`, with one row per readable `<HEP data root>/projects/<project_id>/project.json` (`project_id`, `name`, `description`, `created_at`, `updated_at`, and `uri` = `hep://projects/<project_id>`), most recently updated (`updated_at`) first; a directory without a readable `project.json` was skipped |
| `hep://projects/<project_id>/papers` | No single file: a JSON listing built on read, `{"project_id": ..., "papers": [...]}`, with one row per readable `<HEP data root>/projects/<project_id>/papers/<paper_id>/paper.json` (`paper_id`, `updated_at`, `uri` = `hep://projects/<project_id>/papers/<paper_id>`, and `evidence_catalog_uri` = the paper's `artifacts.evidence_catalog.uri`, absent when the paper has no catalog), most recently updated first; a directory without a readable `paper.json` was skipped |

`<HEP data root>` follows the same rule as for historical runs above. `<project_id>`, `<paper_id>` and `<name>` are the percent-decoded URI path segments. These two listings were served as MCP resources until 2026-05-16, when hep-mcp became tool-only; after that no tool emitted these two `hep://` index forms (`hep_project_list` returned its own project summaries until this removal). The `uri` values in them are built from percent-encoded ids. When that resource reader served `hep://projects/<project_id>/artifact/<name>`, it returned the file's text for a `.json`, `.jsonl`, `.txt`, `.md`, `.tex` or `.bib` artifact and, for any other file, a JSON description (`file_path`, `size`, `sha256`, `mimeType`) in its place; the file itself is the one in the table.

An evidence catalog is a JSON Lines file, one item per line. The item format is the `evidence_catalog_item_v1` schema, which no longer exists in the live tree; read it with `git show 90c3979b:meta/schemas/evidence_catalog_item_v1.schema.json`. A LaTeX item's `locator.file` is relative to the paper's `sources/latex/extracted/` directory, and its offsets, lines and columns refer to that original file. `sources/latex/merged.tex` and `sources/latex/sourceMap.json` beside it are the merged source and its map back to the original files; a paper directory may hold these two files without a catalog when a build failed after writing them, and they are not a catalog.

These directories are historical evidence: read them in place, and never rewrite, move, or delete them.

## Audit Basis

- `docs/ARCHITECTURE.md`
- `docs/README_zh.md`
- `docs/TESTING_GUIDE.md`
- `meta/docs/orchestrator-mcp-tools-spec.md`
- `packages/hep-mcp/src/core/outputDir.ts`
- `packages/pdg-mcp/src/artifacts.ts`
- `packages/orchestrator/src/orch-tools/*.ts`
- `packages/idea-engine/src/service/*.ts`

When another document needs to describe URI truth at a cross-package level, it should point back to this registry instead of creating a second authority list.

Run artifact URIs resolve through Nullius to the original readable run location, including historical `team/runs`. A bare run ID shared by both roots is ambiguous and cannot silently select a payload. File exports preserve project-relative paths; `--run-root` explicitly selects the export location. Historical URI reads do not grant write or execution authority.

Capacity evidence requires an adjacent runtime observation of the actual successful invocation, including requests that fit the conservative byte bound. The local runtime binds the complete original request, actual report locator, working directory and captured bytes using its host authority; recalculating project artifact hashes cannot create that observation. Verification trusts the runtime and owning OS account, and does not authenticate provider truth or scientific correctness. Historical unsigned records remain readable, but cannot supply new capacity acceptance; they are never retrospectively signed.

Interrupted notebook reviews resume in a fresh run from immutable intake and batch checkpoints, retaining original bytes and rechecking current material. Only completed, fresh, runtime-observed primary interval receipts can be reused; the complete-original joint audit is always executed again. Missing closure, stale sources or incomplete operations remain unavailable or incomplete. Member reproduction evidence requires an authenticated actual producer episode and the complete source/data inputs bound to the executed command; declared inputs and bounded static discovery do not prove arbitrary filesystem activity.

Runtime observations bind the actual report location, so copying signed capture bytes cannot authenticate a new invocation elsewhere. Member episodes freeze every observed file into durable original storage before publication; successful workspace cleanup preserves subsequent verification. Records lacking these bindings remain readable and unavailable for new acceptance.

Member origin trusts the configured runner and owning host runtime: the complete runner bytes are recorded, but no runner allowlist or provider attestation is claimed. Offline or injected host execution establishes a local process/callable observation; actual provider capacity evidence requires the corresponding CLI capture. The canonical team cycle performs a postflight source assessment and a separate fresh assessment at the final consumer; both use the configured assessor request/execution budgets.

The owning account can read the authority key, including code executed by a member under that account; this authenticates against non-executing artifact tampering, not hostile same-account code. No OS sandbox or provider attestation is supplied.

The configured token window is frozen before the original reviewer subprocess starts and bound into its authenticated runtime observation. Changing historical window metadata cannot admit that receipt. Older observations without this policy remain readable and require a fresh execution for capacity acceptance.

Local directory links leave notebook dependency closure pending and prevent acceptance. The complete-original joint audit requires exact substantive original-byte anchors for every interval; a reasoning checkbox alone cannot supply coverage.

[Research output storage](RUN_STORAGE.md) uses project-relative paths and SHA-256 manifests; the shared local content store is not a new URI namespace and is not transferred by Git clone or push. Ref inventory does not grant authority to rewrite host refs or recovery history.

Workflow evidence acceptance introduces no URI scheme. Its state pointer contains a project-relative path and SHA-256 for an immutable receipt under `artifacts/runs/<run_id>/workflow_acceptance/<attempt>/receipt.json`. `run` and `status` expose the same acceptance view; existing `orch://` lifecycle identifiers retain their scope.

Task briefs use ordinary project-relative file paths under
`artifacts/runs/<run-id>/`, not a new URI scheme or MCP resource. Their embedded
SHA-256 source records are byte-freshness checks rather than lifecycle or
scientific approval identifiers.
