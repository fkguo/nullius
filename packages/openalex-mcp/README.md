# @autoresearch/openalex-mcp

OpenAlex scholarly knowledge graph MCP server — work/author/institution/concept search, citation graph traversal, and paginated metadata retrieval over local stdio.

## Layer

Atomic provider operator. Bounded schema-driven MCP atom — does not own workflow state. See root [README.md](../../README.md) §3 Layer Model.

## Run

```bash
pnpm -r build
node packages/openalex-mcp/bin/openalex-mcp.js
```

Or wire into an MCP client:

```json
{
  "mcpServers": {
    "openalex-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/autoresearch-lab/packages/openalex-mcp/dist/index.js"]
    }
  }
}
```

## Notes

- Respects OpenAlex rate-limit policy (see `src/rateLimiter.ts`); set a contact email via `OPENALEX_USER_AGENT` to qualify for the polite pool.
- Large result sets are paginated; tool results stay compact and large artifacts go to the resolved local data directory.

## Composition

`@autoresearch/hep-mcp` aggregates openalex-mcp's tools via `packages/hep-mcp/src/tools/registry/shared.ts` so they appear in the HEP MCP tool list when the HEP server runs. There is no per-provider opt-out env var for openalex aggregation — it is always present in the HEP composition.

## Build & test

```bash
pnpm -C packages/openalex-mcp build
pnpm -C packages/openalex-mcp test
```

## See also

- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §4 Why provider MCP stays MCP
