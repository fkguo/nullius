# Architecture Overview

This document explains the current front-door architecture of the monorepo. It is intentionally capability-first and workflow-first: the root is a domain-neutral research substrate and control plane, while concrete provider families live in leaf packages. HEP is the current most mature provider family and the strongest end-to-end example, but not the root identity.

---

## 1. Stable Layer Model

| Layer | Current authority | Boundary |
| --- | --- | --- |
| Workflow authority | checked-in recipes consumed by `autoresearch workflow-plan` | High-level workflow meaning stays above provider packs |
| Stateful control plane | `autoresearch` plus `orch_*` | One shared authority for lifecycle state, approvals, bounded execution, verification, proposal decisions, and read models |
| Agent project harness | `research-harness` skill | Thin host-client entrypoint for recovery, routing, verification, and handoff in external research project roots |
| Experimental runtime bridge | `@autoresearch/idea-engine`, `@autoresearch/idea-mcp` | Explicit runtime bridge, narrower than the full engine contract, phase closed, not a root front door |
| Domain workflow pack | `@autoresearch/hep-mcp`, `hep_*` | Current strongest end-to-end example without becoming the root identity |
| Atomic provider operators | `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, `zotero_*` | Bounded schema-driven MCP atoms that stay MCP-first |
| Project-local reconnect truth | `.autoresearch/` plus durable memory files | The external project root, not the development repo, holds the long-lived truth |

## 2. Design Invariants

- The root architecture is domain-neutral. Provider-specific worldview and workflow bias stay in provider packages or workflow recipes.
- `autoresearch` remains the stateful CLI front door. `orch_*` remains the MCP/operator counterpart of that same control plane.
- `research-harness` is the agent-client skill entrypoint for Codex / Claude Code / OpenCode project continuation. It does not own state or execution; it restores `.autoresearch/` plus durable project files, routes milestone work to `research-team`, routes Markdown note cleanup to `markdown-hygiene`, routes HEP evidence work to `hep-mcp`, and folds results back into `research_contract.md`, `research_plan.md#Current Status`, and `artifacts/runs/<run_id>/`.
- `autoresearch init` writes `.autoresearch/HARNESS` as the machine-readable project handshake. Agents should treat its presence as a mandatory `autoresearch status --json` receipt trigger before new work, milestone execution, closeout, or handoff. `autoresearch init --refresh` re-applies the managed scaffold doc (`AGENTS.md`) into an already-initialized project, backing up any changed file under `.autoresearch/backups/` and never rewriting the user-owned seed files.
- Provider MCP surfaces stay MCP-first. We do not mass-convert provider MCP into CLI because those surfaces are bounded atoms, not stateful workflow shells.
- `idea-mcp` remains experimental and must not reclaim root workflow authority; the current idea-engine phase is closed rather than a default capability-expansion lane.
- `research_brainstorm` is a lightweight planning-only durable harness recipe under `autoresearch workflow-plan`: it persists a brainstorm-to-handoff plan and emits a `next_contract` for optional heavier recipes, but it does not provide built-in runtime tools or invoke host-native thinking process, idea-engine, full research-team, broad retrieval, memory graph expansion, or a new front door.
- Large outputs are written to disk as artifacts; MCP results return compact summaries plus file or artifact pointers.
- Missing or unauthorized writing citations fail hard at render time; source and artifact paths stay constrained under allowed roots.
- For initialized external project roots, `.autoresearch/HARNESS`, `.autoresearch/` state, and project-local durable memory such as `research_plan.md`, `research_contract.md`, and substantive `research_notebook.md` remain the enduring reconnect truth.
- `research_plan.md#Current Status` is the human status entry for final target, current phase, completion state, blocker, next step, stop condition, and evidence pointers before the longer task board and log.
- `research_notebook.md` is the human-facing logical narrative, organized by problem, derivation, claims, and uncertainty rather than by run date or status tracking; important literature notes require full-text/source-first reading, auditable section/page/equation/figure coverage, and LaTeX math notation, while raw dated run logs and tool-use traces belong in `research_plan.md` or `artifacts/runs/<run_id>/`.
- Project-local `run_id` values are human-facing research identities, not provider UUIDs: prefer safe, sortable, readable names such as `20260502T023000Z-m3-branch-scan-r1`. `team/runs/<tag>/` remains a host-local reviewer packet/log surface unless explicitly mirrored or summarized under `artifacts/runs/<run_id>/research_team/`.
- Optional support surfaces such as `prompts/`, `team/`, `research_team_config.json`, `.mcp.template.json`, and root `specs/plan.schema.json` are created later by explicit project need or host-specific tooling rather than by the canonical generic scaffold.

## 3. Current Public Surfaces

| Surface | Current authority | Notes |
| --- | --- | --- |
| Stateful CLI front door | `autoresearch` | Generic lifecycle state, `workflow-plan`, bounded native TS computation, verification, higher-conclusion gating, and proposal decisions |
| Control-plane MCP/operator surface | `orch_*` | Canonical public MCP/operator counterpart of the same control plane |
| Stateful literature planning | `autoresearch workflow-plan` | Checked-in workflow authority resolved via `@autoresearch/literature-workflows`; persists `.autoresearch/state.json#/plan` and derives `.autoresearch/plan.md`. `research_brainstorm` is the lightweight planning-only recipe variant that emits a `next_contract` handoff without starting heavier workflows |
| Agent project harness skill | `research-harness` | Market-listed thin skill for Codex / Claude Code / OpenCode to recover project truth, route execution to `autoresearch` / `research-team` / `markdown-hygiene` / `hep-mcp`, and close out verification or handoff |
| Experimental runtime bridge | `idea_mcp` | `idea_campaign_*`, `idea_search_step`, and `idea_eval_run` on explicit external data roots; post-search `rank.compute` / `node.promote` and bounded negative failure-library reflection stay inside the `idea-engine` runtime contract |
| Current most mature domain MCP front door | `@autoresearch/hep-mcp` | Project/Run, evidence, writing/export, and provider-local composition |
| Provider-local atoms | `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, `zotero_*` | Bounded provider operators that remain MCP-first |

Front-door surface classification lives in `meta/front_door_authority_map_v1.json`; exact inventories remain owned by their source surfaces.

## 4. Why Provider MCP Stays MCP

- Provider surfaces are naturally schema-driven and agent-composable.
- Many provider calls produce structured local artifact output instead of becoming separate workflow front doors.
- A provider-local CLI mirror would add another surface to document and test without clarifying where workflow authority lives.
- Stateful workflow entry remains above provider packs: `autoresearch workflow-plan` owns checked-in workflow authority, and `autoresearch run` remains the only execution front door.
- This is also why HEP can stay the strongest end-to-end example without being rewritten into the root product identity.

## 5. State, files, and artifacts

### 5.1 `HEP_DATA_DIR`

`packages/hep-mcp/src/data/dataDir.ts` resolves the HEP data root in this order: explicit tool-call `project_root` for an initialized autoresearch project (`<project_root>/artifacts/hep-mcp`), then `HEP_DATA_DIR`, then scratch fallback `~/.autoresearch/hep-mcp`.

```text
<resolved HEP data root>/
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
    HARNESS
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

### 5.3 Research material placement

Paper originals, extracted text, arXiv source tarballs, and source trees are filesystem materials, not product-level protocol surfaces.

- If a source is only needed for the current check, keep it in a local temporary directory.
- If future verification, review, or continuation needs it, write it under the external project root in a suitable project/run artifact subdirectory.
- README and quickstart flows should stay centered on tools, external project roots, durable files, and manifests rather than URI schemes.
- `docs/URI_REGISTRY.md` is implementation/debug bookkeeping for emitted identifiers, not workflow guidance for where research materials should live.

## 6. Code map for the current front door

| Path | Current responsibility |
| --- | --- |
| `packages/hep-mcp/src/tools/registry/shared.ts` | current tool exposure order and `standard`/`full` filtering |
| `packages/hep-mcp/src/core/projects.ts` | project creation and listing |
| `packages/hep-mcp/src/core/runs.ts` | run creation, manifest writes, run locking |
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

The current public MCP contract is intentionally narrow: local stdio process launch, tool `inputSchema`, compact JSON/text tool results, and no prompts. Research material placement remains filesystem-first: temporary files for one-off checks, project/run artifacts for durable verification and continuation. Remote MCP transports, OAuth, registry publishing, and a separately packaged generic root MCP server are future deployment surfaces, not current architecture. `orch_*` is the orchestrator-owned operator/tool inventory for the control plane rather than an independent root MCP server process.

Expected environment knobs at the front door:

- `project_root` tool argument for project-local durable artifacts
- `HEP_DATA_DIR`
- `HEP_TOOL_MODE`
- `ZOTERO_BASE_URL`
- `ZOTERO_DATA_DIR`
- `PDG_DB_PATH`

These path-like knobs configure local filesystem roots and caches, not URI/protocol authority. Keep durable research inputs and artifacts under the external project root by passing `project_root` to HEP tools; use `HEP_DATA_DIR` / local temp roots only for one-off checks, CI, migrations, or source files that are not needed later.

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
