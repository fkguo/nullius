# Architecture Overview

This document explains the current front-door architecture of the monorepo. It is intentionally capability-first and workflow-first: the root is a domain-neutral research substrate and control plane, while concrete provider families live in leaf packages. HEP is the current most mature provider family and the strongest end-to-end example, but not the root identity.

---

## 1. Current architecture in one sentence

Autoresearch Lab currently combines:

- a generic lifecycle/control-plane package (`@autoresearch/orchestrator`)
- a current most mature domain MCP front door with the strongest end-to-end workflow family today (`@autoresearch/hep-mcp`)
- additional provider packages (`openalex-mcp`, `arxiv-mcp`, `hepdata-mcp`, `pdg-mcp`, `zotero-mcp`)
- checked-in workflow recipes that can be consumed by generic workflow-plan consumers or agent clients

## 2. Design invariants

### 2.1 Domain-neutral root

- The root architecture is domain-neutral.
- Provider-specific worldview and workflow bias should stay in provider packages or workflow recipes.
- HEP belongs at the root only as the current most mature provider family and provider example.

### 2.2 Evidence-first I/O

- Large outputs are written to disk as artifacts.
- MCP tool results return compact summaries plus stable URIs.
- Clients read concrete payloads back through MCP resources such as `hep://runs/{run_id}/manifest`.

### 2.3 Local-first transport

- The current MCP front door is local stdio.
- There is no root HTTP transport/server surface for the current front door.
- Zotero integration is local-only (`http://127.0.0.1:23119`).

### 2.4 Fail-fast, fail-closed boundaries

- Missing or unauthorized writing citations fail hard at render time.
- Resource and artifact paths are constrained under their allowed roots.
- Binary artifacts are not inlined into MCP results by default.

## 3. Current front-door surfaces

### 3.1 Root capability map

```text
repo root
├── @autoresearch/orchestrator
│   └── generic lifecycle/control-plane + native TS computation package + `autoresearch` CLI
├── @autoresearch/hep-mcp
│   └── current most mature domain MCP front door and strongest end-to-end workflow family
├── provider packages
│   └── openalex-mcp / arxiv-mcp / hepdata-mcp / pdg-mcp / zotero-mcp
└── checked-in workflow recipes + consumers
    └── `literature_fetch.py workflow-plan` (lower-level consumer driven by `autoresearch workflow-plan`)
```

### 3.2 `@autoresearch/hep-mcp`

Current responsibilities:

- Project/Run creation and audited run manifests
- Evidence build/query/playback
- Writing/render/export/import flows
- Direct provider tool families (`inspire_*`, `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, `zotero_*`)
- `hep://...` and `pdg://...` MCP resource surfaces

Current registry authority is centered on:

- `packages/hep-mcp/src/tools/registry/shared.ts`
- `packages/hep-mcp/src/core/projects.ts`
- `packages/hep-mcp/src/core/runs.ts`
- `packages/hep-mcp/src/core/resources.ts`
- `packages/hep-mcp/src/core/paths.ts`

### 3.3 `@autoresearch/orchestrator`

Current responsibilities:

- generic lifecycle state and approval handling
- external project-root initialization via `autoresearch init`
- native TS computation manifest execution via `autoresearch run --workflow-id computation`
- status / pause / resume / export CLI flows
- full-surface orchestrator tool specs (`orch_*`) for host integrations

The current user-facing generic lifecycle + computation + workflow-plan entrypoint is the `autoresearch` CLI, not the root MCP server.

### 3.4 Launcher-backed workflow consumers

High-level literature workflows are meant to enter through the stateful launcher-backed `autoresearch workflow-plan`, which requires an initialized external project root and resolves checked-in workflow authority directly via `@autoresearch/literature-workflows`:

- `autoresearch workflow-plan` → native TS front door using `@autoresearch/literature-workflows`, persisting `.autoresearch/state.json#/plan` and deriving `.autoresearch/plan.md`
- `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` → lower-level checked-in consumer of the same workflow authority

These workflow-plan consumers are not the root identity of the repo; they are one layer above checked-in recipe authority.

## 4. Current workflow families

### 4.1 Project/Run evidence workflow

```text
hep_project_create
  -> hep_run_create
  -> evidence build/query
  -> hep_render_latex
  -> hep_export_project / hep_export_paper_scaffold / hep_import_paper_bundle
```

Representative tools:

- `hep_project_create`
- `hep_run_create`
- `hep_project_build_evidence`
- `hep_run_build_writing_evidence`
- `hep_project_query_evidence`
- `hep_project_playback_evidence`
- `hep_render_latex`
- `hep_export_project`

### 4.2 Literature and data navigation workflow

Representative tools:

- `inspire_search`, `inspire_literature`, `inspire_topic_analysis`, `inspire_network_analysis`, `inspire_find_connections`
- `openalex_search`, `openalex_get`, `openalex_references`
- `arxiv_search`, `arxiv_get_metadata`, `arxiv_paper_source`
- `hepdata_search`, `hepdata_get_record`, `hepdata_get_table`

These tools can often be called directly without a Project/Run. Project/Run becomes important when the workflow needs artifact persistence, evidence reuse, or writing/export.

### 4.3 Writing and export workflow

Representative tools:

- `hep_run_build_citation_mapping`
- `hep_run_build_measurements`
- `hep_project_compare_measurements`
- `hep_render_latex`
- `hep_export_project`
- `hep_export_paper_scaffold`
- `hep_import_paper_bundle`

### 4.4 Generic lifecycle + bounded computation execution

Current CLI path:

```bash
autoresearch init --project-root /abs/path/to/project
autoresearch run --workflow-id computation --run-id <run_id> [--manifest /abs/path/to/project/<run_id>/computation/manifest.json] --project-root /abs/path/to/project
autoresearch status --project-root /abs/path/to/project
autoresearch approve <approval_id> --project-root /abs/path/to/project
autoresearch pause --project-root /abs/path/to/project
autoresearch resume --project-root /abs/path/to/project
autoresearch export --project-root /abs/path/to/project
```

Current bounded computation note:

- `autoresearch run --workflow-id computation` is the native TS computation entrypoint in this slice.
- It requires an initialized external project root plus a prepared `computation/manifest.json`.
- Gate handling stays on `autoresearch status/approve`.
- Parser-level `run-card validate/render` wrappers are deleted; remaining run-card semantics live only in lower-level toolkit/computation paths.
- Residual non-computation Pipeline A `run` workflows remain internal-only compatibility surface and must not reclaim the front door.
- Front-door surface classification now lives in `meta/front_door_authority_map_v1.json`; exact inventories still remain owned by their source surfaces.

Current tool-surface families inside the package:

- run lifecycle / approvals / bounded agent runtime: `orch_run_*`
- policy inspection: `orch_policy_query`
- fleet queue / worker coordination: `orch_fleet_*`
- For the exact live `orch_*` inventory and semantics, read `meta/docs/orchestrator-mcp-tools-spec.md`.

## 5. State, artifacts, and resources

### 5.1 `HEP_DATA_DIR`

`packages/hep-mcp/src/data/dataDir.ts` resolves `HEP_DATA_DIR` to `~/.hep-mcp` by default.

```text
<HEP_DATA_DIR>/
  cache/
  downloads/
  projects/<project_id>/
    project.json
    artifacts/
    papers/<paper_id>/
      paper.json
      evidence/
  runs/<run_id>/
    manifest.json
    artifacts/
```

Important path helpers live in:

- `packages/hep-mcp/src/core/paths.ts`
- `packages/hep-mcp/src/core/projects.ts`
- `packages/hep-mcp/src/core/runs.ts`

### 5.2 `.autoresearch` external project roots

The generic lifecycle package writes to real external project roots:

```text
<project_root>/
  .autoresearch/
    state.json
    ledger.jsonl
    plan.md
    approval_policy.json
    fleet_queue.json
    fleet_workers.json
  artifacts/
    runs/<run_id>/
      approvals/<approval_id>/
        approval_packet_v1.json
```

Key files:

- `packages/orchestrator/src/state-manager.ts`
- `packages/orchestrator/src/ledger-writer.ts`
- `packages/orchestrator/src/orch-tools/run-read-model.ts`
- `packages/orchestrator/src/computation/approval.ts`

### 5.3 Resource schemes

Current resource schemes relevant to the front door:

| Scheme | Current truth |
| --- | --- |
| `hep://projects` | project index |
| `hep://runs` | run index |
| `hep://projects/{project_id}` | project manifest |
| `hep://projects/{project_id}/papers/{paper_id}/evidence/catalog` | project paper evidence catalog |
| `hep://runs/{run_id}/manifest` | run manifest |
| `hep://runs/{run_id}/artifact/{artifact_name}` | run artifact |
| `pdg://info` | PDG local info |
| `pdg://artifacts/{artifact_name}` | PDG artifact |
| `orch://runs/{run_id}/approvals/{approval_id}` | orchestrator approval read-model URI |

`packages/hep-mcp/src/core/resources.ts` intentionally keeps `resources/list` small (`hep://projects`, `hep://runs`) and relies on resource templates plus manifests for deeper discovery.

## 6. Code map for the current front door

| Path | Current responsibility |
| --- | --- |
| `packages/hep-mcp/src/tools/registry/shared.ts` | current tool exposure order and `standard`/`full` filtering |
| `packages/hep-mcp/src/core/projects.ts` | project creation and listing |
| `packages/hep-mcp/src/core/runs.ts` | run creation, manifest writes, run locking |
| `packages/hep-mcp/src/core/resources.ts` | `hep://...` resource list, templates, and reads |
| `packages/hep-mcp/src/core/paths.ts` | on-disk project/run path authority |
| `packages/hep-mcp/src/core/writing/*` | writing evidence and render path |
| `packages/hep-mcp/src/core/export/*` | export/import artifacts and paper bundle flows |
| `packages/hep-mcp/tests/core/*` | core front-door behavior tests |
| `packages/hep-mcp/tests/docs/docToolDrift.test.ts` | doc/tool-count/front-door drift guard |
| `packages/orchestrator/src/cli-help.ts` | current lifecycle CLI help and boundary wording |
| `packages/orchestrator/src/orch-tools/*` | generic lifecycle tool surfaces |

## 7. Connection model

### 7.1 MCP clients

Current MCP clients connect to:

```text
node /absolute/path/to/autoresearch-lab/packages/hep-mcp/dist/index.js
```

Expected environment knobs at the front door:

- `HEP_DATA_DIR`
- `HEP_TOOL_MODE`
- `ZOTERO_BASE_URL`
- `ZOTERO_DATA_DIR`
- `PDG_DB_PATH`

### 7.2 Agent/tool namespacing

Some clients expose namespaced tool names such as `mcp__<serverAlias>__<toolName>`. The correct authority is always the exact tool name shown by the client UI.

### 7.3 CLI users

Users who need generic lifecycle state should invoke `autoresearch` directly rather than expecting the root MCP server to own that surface today.

## 8. Related docs

- [`README.md`](../README.md)
- [`docs/README_zh.md`](./README_zh.md)
- [`docs/TESTING_GUIDE.md`](./TESTING_GUIDE.md)
- [`docs/PROJECT_STATUS.md`](./PROJECT_STATUS.md)
- [`docs/TOOL_CATEGORIES.md`](./TOOL_CATEGORIES.md)
- [`docs/URI_REGISTRY.md`](./URI_REGISTRY.md)
