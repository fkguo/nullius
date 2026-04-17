# Architecture Overview

This document explains the current front-door architecture of the monorepo. It is intentionally capability-first and workflow-first: the root is a domain-neutral research substrate and control plane, while concrete provider families live in leaf packages. HEP is the current most mature provider family and the strongest end-to-end example, but not the root identity.

---

## 1. Stable Layer Model

| Layer | Current authority | Boundary |
| --- | --- | --- |
| Workflow authority | checked-in recipes consumed by `autoresearch workflow-plan` | High-level workflow meaning stays above provider packs |
| Stateful control plane | `autoresearch` plus `orch_*` | One shared authority for lifecycle state, approvals, bounded execution, verification, proposal decisions, and read models |
| Experimental runtime bridge | `@autoresearch/idea-engine`, `@autoresearch/idea-mcp` | Explicit runtime bridge, narrower than the full engine contract, not a root front door |
| Domain workflow pack | `@autoresearch/hep-mcp`, `hep_*`, `hep://...` | Current strongest end-to-end example without becoming the root identity |
| Atomic provider operators | `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, `zotero_*` | Bounded schema-driven MCP atoms that stay MCP-first |
| Project-local reconnect truth | `.autoresearch/` plus durable memory files | The external project root, not the development repo, holds the long-lived truth |

## 2. Design Invariants

- The root architecture is domain-neutral. Provider-specific worldview and workflow bias stay in provider packages or workflow recipes.
- `autoresearch` remains the stateful CLI front door. `orch_*` remains the MCP/operator counterpart of that same control plane.
- Provider MCP surfaces stay MCP-first. We do not mass-convert provider MCP into CLI because those surfaces are bounded atoms, not stateful workflow shells.
- `idea-mcp` remains experimental and must not reclaim root workflow authority.
- Large outputs are written to disk as artifacts; MCP results return compact summaries plus stable URIs.
- Missing or unauthorized writing citations fail hard at render time; resource and artifact paths stay constrained under allowed roots.
- For initialized external project roots, `.autoresearch/` state plus project-local durable memory such as `research_plan.md`, `research_contract.md`, and substantive `research_notebook.md` remain the enduring reconnect truth.
- Optional support surfaces such as `prompts/`, `team/`, `research_team_config.json`, `.mcp.template.json`, and root `specs/plan.schema.json` remain opt-in layers rather than the default front door.

## 3. Current Public Surfaces

| Surface | Current authority | Notes |
| --- | --- | --- |
| Stateful CLI front door | `autoresearch` | Generic lifecycle state, `workflow-plan`, bounded native TS computation, verification, higher-conclusion gating, and proposal decisions |
| Control-plane MCP/operator surface | `orch_*` | Canonical public MCP/operator counterpart of the same control plane |
| Experimental runtime bridge | `idea_mcp` | `idea_campaign_*`, `idea_search_step`, and `idea_eval_run` on explicit external data roots |
| Current most mature domain MCP front door | `@autoresearch/hep-mcp` | Project/Run, evidence, writing/export, provider-local composition, `hep://...` and `pdg://...` resources |
| Provider-local atoms | `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, `zotero_*` | Bounded provider operators that remain MCP-first |

Front-door surface classification lives in `meta/front_door_authority_map_v1.json`; exact inventories remain owned by their source surfaces.

## 4. Why Provider MCP Stays MCP

- Provider surfaces are naturally schema-driven and agent-composable.
- Many provider calls pair with stable resource readback or structured artifact output.
- A provider-local CLI mirror would add another surface to document and test without clarifying where workflow authority lives.
- Stateful workflow entry remains above provider packs: `autoresearch workflow-plan` owns checked-in workflow authority, and `autoresearch run` remains the only execution front door.
- This is also why HEP can stay the strongest end-to-end example without being rewritten into the root product identity.

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
