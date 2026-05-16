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

`@autoresearch/hep-mcp` aggregates hepdata-mcp's tools under `hep_*` namespaces by default. Set `HEP_ENABLE_HEPDATA=0` in the HEP server env to hide them.

## Build & test

```bash
pnpm -C packages/hepdata-mcp build
pnpm -C packages/hepdata-mcp test
```

## See also

- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §4 Why provider MCP stays MCP
