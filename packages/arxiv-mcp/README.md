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

`@autoresearch/hep-mcp` aggregates arxiv-mcp's tools under `hep_*` namespaces by default. Set `HEP_ENABLE_ARXIV=0` in the HEP server env to hide them.

## Build & test

```bash
pnpm -C packages/arxiv-mcp build
pnpm -C packages/arxiv-mcp test
```

## See also

- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §4 Why provider MCP stays MCP
