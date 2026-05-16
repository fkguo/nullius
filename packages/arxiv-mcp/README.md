# @autoresearch/arxiv-mcp

Domain-agnostic arXiv MCP server: paper search, metadata lookup, and source/PDF content access over local stdio.

## Layer

Atomic provider operator. Bounded schema-driven MCP atom — stays MCP-first, does not own workflow state. See root [README.md](../../README.md) §3 Layer Model.

## Run

```bash
pnpm -r build
node packages/arxiv-mcp/bin/arxiv-mcp.js
```

Or wire into an MCP client:

```json
{
  "mcpServers": {
    "arxiv-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/autoresearch-lab/packages/arxiv-mcp/dist/index.js"]
    }
  }
}
```

## Composition

`@autoresearch/hep-mcp` aggregates arxiv-mcp's tools via `packages/hep-mcp/src/tools/registry/projectExtensions.ts` so they appear in the HEP MCP tool list when the HEP server runs. There is no per-provider opt-out env var for arxiv aggregation — it is always present in the HEP composition.

## Build & test

```bash
pnpm -C packages/arxiv-mcp build
pnpm -C packages/arxiv-mcp test
```

## See also

- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §4 Why provider MCP stays MCP
