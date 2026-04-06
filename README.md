# Autoresearch Lab

English | [中文](./docs/README_zh.md)

Autoresearch Lab is a domain-neutral, evidence-first research monorepo. Today it combines a generic lifecycle/control-plane package, local MCP provider packages, and checked-in workflow recipes that can be consumed by agent clients or shell entrypoints. HEP is the current most mature provider family and the strongest end-to-end workflow example in the repo, but it is not the root product identity.

## 1. What This Monorepo Can Do Today

- Run local-first MCP providers for literature, data, reference, and evidence workflows.
- Create audited Project/Run workspaces, persist artifacts on disk, and expose them through `hep://...` resources.
- Build evidence from LaTeX, PDFs, Zotero attachments, and bounded network providers, then query that evidence for writing and review.
- Export research packs and publication scaffolds, and round-trip finalized paper bundles back into run artifacts.
- Manage generic lifecycle state for real external project roots through `@autoresearch/orchestrator` and the `autoresearch` CLI.

## 2. What Are the Main Current Workflows

1. Project/Run evidence workflow
   - `hep_project_create` -> `hep_run_create` -> evidence build/query -> `hep_render_latex` -> export/import.
1. Literature and data navigation workflow
   - Direct provider tools such as `inspire_*`, `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, and `zotero_*`.
1. Launcher-backed literature workflow family
   - `autoresearch workflow-plan` is the recommended stateful launcher-backed front door for literature workflows on an initialized external project root; it resolves checked-in generic workflow recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md`. The checked-in `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` remains a lower-level consumer of the same workflow authority. The installable legacy `hepar` public shell no longer exposes `literature-gap`; any remaining `literature-gap` path is internal full-parser compatibility only.
1. Native TS computation workflow
   - `autoresearch run --workflow-id computation` executes a prepared `computation/manifest.json` on an initialized external project root; approval handling stays on `autoresearch status/approve`.
1. Generic lifecycle workflow
   - `autoresearch init/status/approve/pause/resume/export` for `.autoresearch/` project state outside the development repo.

## 3. What Are the Main Current Entrypoints

| Surface | Current entrypoint | What it is for |
| --- | --- | --- |
| Current most mature domain MCP front door | `node /absolute/path/to/autoresearch-lab/packages/hep-mcp/dist/index.js` | HEP domain MCP server for research/navigation/evidence/export workflows `(72 std / 101)` |
| Generic lifecycle + computation + workflow-plan front door | `autoresearch` | External project-root lifecycle state, approvals, bounded native TS `run --workflow-id computation`, and stateful workflow-plan persistence |
| High-level literature workflow plan entrypoint | `autoresearch workflow-plan` | Recommended stateful launcher-backed entrypoint for initialized external project roots; resolves recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, derives `.autoresearch/plan.md`; `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` is the lower-level parallel consumer, and the installable legacy `hepar` public shell no longer exposes `literature-gap` |
| Leaf provider packages | `@autoresearch/openalex-mcp`, `@autoresearch/arxiv-mcp`, `@autoresearch/hepdata-mcp`, `@autoresearch/pdg-mcp`, `@autoresearch/zotero-mcp` | Provider-specific capabilities that can be composed into client workflows |

Legacy compatibility note: the installable `hepar` public shell no longer exposes `literature-gap`; any remaining `literature-gap` path is internal full-parser compatibility only and is still headed toward retirement.

Tool counts: **72 tools in `standard` mode** (default, compact surface) and **101 tools in `full` mode** (adds advanced tools).

| Mode | Tools | Use when |
| --- | --- | --- |
| `standard` | 72 | Compact front door for everyday client use |
| `full` | 101 | Adds advanced and lifecycle-adjacent slices |

Current package map, grouped by capability rather than identity:

| Capability family | Current surface | Notes |
| --- | --- | --- |
| Generic lifecycle, computation, and approvals | `@autoresearch/orchestrator`, `autoresearch` | Lifecycle state, approvals, and the bounded native TS computation run slice at the current front door |
| Evidence-first Project/Run workflows | `@autoresearch/hep-mcp`, `hep_*`, `hep://...` | Current strongest end-to-end workflow family |
| Literature and data providers | `inspire_*`, `openalex_*`, `arxiv_*`, `hepdata_*` | Mix of direct search, download, export, and bounded analysis |
| Local reference providers | `zotero_*`, `pdg_*` | Optional local-only inputs and lookups |
| Workflow shells | `workflow-plan` | Checked-in generic workflow authority consumed directly by `autoresearch workflow-plan` and by the lower-level `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan`; no installable `hepar literature-gap` front door remains |

## 4. Where Do Artifacts, Resources, and State Live

### `hep-mcp` data root

`@autoresearch/hep-mcp` stores local state under `HEP_DATA_DIR`, which defaults to `~/.hep-mcp`.

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

- Project roots are created under `projects/<project_id>/...`.
- Run state lives under `runs/<run_id>/manifest.json` and `runs/<run_id>/artifacts/...`.
- `PDG_DATA_DIR` is the PDG-local companion root and commonly sits at `<HEP_DATA_DIR>/pdg`.
- Text artifacts are read directly through MCP resources; binary artifacts return metadata by default so the client does not inline large payloads.

### Current resource schemes

`@autoresearch/hep-mcp` currently exposes a small "iceberg" resource list plus templates:

- `hep://projects`
- `hep://runs`
- `hep://projects/{project_id}`
- `hep://projects/{project_id}/papers`
- `hep://projects/{project_id}/artifact/{artifact_name}`
- `hep://projects/{project_id}/papers/{paper_id}`
- `hep://projects/{project_id}/papers/{paper_id}/evidence/catalog`
- `hep://runs/{run_id}/manifest`
- `hep://runs/{run_id}/artifact/{artifact_name}`
- `pdg://info`
- `pdg://artifacts`
- `pdg://artifacts/{artifact_name}`

### Generic lifecycle state

`autoresearch init` bootstraps a real external project root and creates `.autoresearch/` there. The current lifecycle package reads and writes:

```text
<project_root>/
  .autoresearch/
    state.json
    ledger.jsonl
    plan.md
    approval_policy.json
    fleet_queue.json          # when fleet features are in use
    fleet_workers.json        # when fleet features are in use
  artifacts/
    runs/<run_id>/
      approvals/<approval_id>/
        approval_packet_v1.json
```

The orchestrator read model also surfaces approval packet URIs such as `orch://runs/{run_id}/approvals/{approval_id}`.

## 5. How Does a User Connect from MCP Clients / Agent Clients

The current MCP connection story is local stdio only. There is not yet a single generic root MCP server; today the most mature domain MCP entrypoint is `hep-mcp`, while the generic `autoresearch` surface remains CLI-first for lifecycle/control-plane work, native TS computation via `autoresearch run --workflow-id computation`, and stateful `workflow-plan`.

Universal MCP config pattern:

```json
{
  "mcpServers": {
    "hep-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/autoresearch-lab/packages/hep-mcp/dist/index.js"
      ],
      "env": {
        "HEP_DATA_DIR": "/absolute/path/to/hep-data",
        "HEP_TOOL_MODE": "standard",
        "ZOTERO_BASE_URL": "http://127.0.0.1:23119"
      }
    }
  }
}
```

Notes:

- Build first: `pnpm -r build`.
- GUI apps sometimes need an absolute Node path instead of bare `node`.
- Some clients namespace tool names as `mcp__<serverAlias>__<toolName>`. Always call the exact tool name shown by the client.
- Typical MCP-compatible clients include Cursor, Claude Desktop, Claude Code CLI, Chatbox, Cherry Studio, Continue, Cline, and Zed.
- The lifecycle CLI is separate from MCP client setup:

```bash
autoresearch init --project-root /absolute/path/to/external-project
autoresearch status --project-root /absolute/path/to/external-project
```

- For launcher-backed literature workflows, first initialize the target external project root with `autoresearch init`, then use `autoresearch workflow-plan` from that root or with `--project-root`. It resolves recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, derives `.autoresearch/plan.md`, and leaves the checked-in Python `workflow-plan` script as the lower-level parallel consumer. Do not treat any internal `literature-gap` compatibility path as a new front-door shell.

## 6. Where Are Deeper Architecture / Governance Docs

- [Architecture Overview](./docs/ARCHITECTURE.md)
- [Testing Guide](./docs/TESTING_GUIDE.md)
- [Project Status](./docs/PROJECT_STATUS.md)
- [Tool Categories](./docs/TOOL_CATEGORIES.md)
- [URI Registry](./docs/URI_REGISTRY.md)
- [Chinese README](./docs/README_zh.md)
- [Repo Governance](./AGENTS.md)
- [Redesign Plan](./meta/REDESIGN_PLAN.md)
- [Development Contract](./meta/ECOSYSTEM_DEV_CONTRACT.md)

## Quick Start

```bash
pnpm install
pnpm -r build
pnpm --filter @autoresearch/hep-mcp docs:tool-counts:check
```

After connecting your MCP client to `packages/hep-mcp/dist/index.js`, the smallest end-to-end smoke path is:

1. Call `hep_health`.
1. Call `hep_project_create`.
1. Call `hep_run_create`.
1. Read `hep://runs/{run_id}/manifest`.

If you want the current strongest end-to-end workflow family, continue with:

1. `hep_run_build_citation_mapping`
1. `hep_run_build_writing_evidence` or `hep_project_build_evidence`
1. `hep_render_latex`
1. `hep_export_project`

## Current HEP Framing

HEP belongs in the root docs today as:

- the current most mature provider family
- the current strongest end-to-end workflow family
- the current provider example for evidence-first Project/Run flows

HEP does not define the root docs as:

- the only intended domain
- the only meaningful way to understand the repo
- the root product identity

## Documentation

- [Feature Testing Guide](./docs/TESTING_GUIDE.md)
- [Project Status](./docs/PROJECT_STATUS.md)
- [Architecture Overview](./docs/ARCHITECTURE.md)
- [pdg-mcp Docs](./packages/pdg-mcp/README.md)

## Development

For front-door drift, start with:

- `packages/hep-mcp/tests/docs/docToolDrift.test.ts`
- `pnpm --filter @autoresearch/hep-mcp docs:tool-counts:check`
- `pnpm --filter @autoresearch/hep-mcp test -- tests/docs/docToolDrift.test.ts`

## License

MIT
