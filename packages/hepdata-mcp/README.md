# @autoresearch/hepdata-mcp

HEPData MCP server for experimental HEP measurement data — submission discovery, table retrieval, and measurement extraction over local stdio.

## Layer

Atomic provider operator. Bounded schema-driven MCP atom — narrower than `@autoresearch/hep-mcp`, focused on HEPData as a data source. See root [README.md](../../README.md) §3 Layer Model.

## Run

```bash
pnpm -r build
node packages/hepdata-mcp/bin/hepdata-mcp.js
```

Or wire into an MCP client:

```json
{
  "mcpServers": {
    "hepdata-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/autoresearch-lab/packages/hepdata-mcp/dist/index.js"]
    }
  }
}
```

## Composition

`@autoresearch/hep-mcp` aggregates hepdata-mcp's tools via `packages/hep-mcp/src/tools/registry/projectExtensions.ts` so they appear in the HEP MCP tool list when the HEP server runs. There is no per-provider opt-out env var for hepdata aggregation — it is always present in the HEP composition.

## Build & test

```bash
pnpm -C packages/hepdata-mcp build
pnpm -C packages/hepdata-mcp test
```

## See also

- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §4 Why provider MCP stays MCP
