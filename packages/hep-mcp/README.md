# @autoresearch/hep-mcp

Current most mature HEP domain pack and end-to-end workflow example. Local stdio MCP server exposing `hep_*` tools for projects, runs, evidence, writing, export, and provider-local composition.

## Layer

Domain workflow pack. The strongest end-to-end example in the repo, but **not the root product identity** — generic lifecycle and contracts live in `@autoresearch/orchestrator` and `@autoresearch/shared`. See root [README.md](../../README.md) §3 Layer Model.

## Aggregated providers

`hep-mcp` re-exposes a curated subset of the bounded provider MCP atoms (`arxiv-mcp`, `openalex-mcp`, `hepdata-mcp`, `pdg-mcp`, `zotero-mcp`) under `hep_*` namespaces. Zotero aggregation is gated by `HEP_ENABLE_ZOTERO` (set to `0` to hide `hep_import_from_zotero` and friends); the other providers are always included when present.

The live tool inventory is code-owned and mode-filtered by `HEP_TOOL_MODE` (`standard`, `full`). Exact counts live in the generated category and status docs, not in this README — see the drift lock below.

## Data root

Resolved per tool call, in this order:

1. `project_root` argument (for an initialized autoresearch project) → `<project_root>/artifacts/hep-mcp/`
2. `HEP_DATA_DIR` env when set
3. `~/.autoresearch/hep-mcp/` (scratch fallback)

`PDG_DATA_DIR` follows the resolved root by default at `<resolved root>/pdg`.

## Build & run

```bash
pnpm -r build
node packages/hep-mcp/dist/index.js
```

Wire into an MCP client (Cursor / Claude Desktop / Claude Code / Codex / OpenCode / etc.):

```json
{
  "mcpServers": {
    "hep-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/autoresearch-lab/packages/hep-mcp/dist/index.js"],
      "env": {
        "HEP_DATA_DIR": "~/.autoresearch/hep-mcp",
        "HEP_TOOL_MODE": "standard"
      }
    }
  }
}
```

## Front-door drift lock

The tool inventory, doc tables, and category counts are tied together by:

```bash
pnpm --filter @autoresearch/hep-mcp docs:tool-counts:check
pnpm --filter @autoresearch/hep-mcp test -- tests/docs/docToolDrift.test.ts
```

These fail closed when `docs/TOOL_CATEGORIES.md` or `meta/docs/orchestrator-mcp-tools-spec.md` drift from the live registry.

## Build & test

```bash
pnpm -C packages/hep-mcp build
pnpm -C packages/hep-mcp test
```

## See also

- Root [README.md](../../README.md) — surface policy and end-to-end smoke path
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §5.1 — `HEP_DATA_DIR` resolution
- [docs/TOOL_CATEGORIES.md](../../docs/TOOL_CATEGORIES.md) — live tool taxonomy
