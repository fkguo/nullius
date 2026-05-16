# @autoresearch/rep-sdk

Agent-native core SDK for the Research Evolution Protocol (REP). Library-only; modular sub-exports for client, server, transport, validation, discovery, and signals.

## Layer

Independent protocol substrate. Sits alongside the shared contracts layer rather than under the control plane — REP is a separate protocol concern and does not flow through `@autoresearch/orchestrator` state. See root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority.

## Subpath exports

| Entry | Use for |
| --- | --- |
| `@autoresearch/rep-sdk` | Top-level barrel |
| `@autoresearch/rep-sdk/client` | REP client primitives |
| `@autoresearch/rep-sdk/server` | REP server primitives |
| `@autoresearch/rep-sdk/transport` | Transport adapters |
| `@autoresearch/rep-sdk/validation` | Envelope and signal validation |
| `@autoresearch/rep-sdk/discovery` | Discovery contracts |
| `@autoresearch/rep-sdk/signals` | Signal types and helpers |

## Build & test

```bash
pnpm -C packages/rep-sdk build    # tsc + smoke-exports.mjs
pnpm -C packages/rep-sdk test
```

`scripts/smoke-exports.mjs` runs as part of `build` to catch broken sub-exports early.

## See also

- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) — layer model context
