# idea-core

Standalone `idea-core` implementation repo (stdio JSON-RPC engine).

## Contract Source Strategy (M1.0)

- SSOT stays in sibling design/contract repo: `../idea-generator`.
- This repo keeps a **read-only vendored snapshot** under `contracts/idea-generator-snapshot/schemas/`.
- Sync is explicit and auditable: `make sync-contracts` updates snapshot + `CONTRACT_SOURCE.json` with source commit.
- `idea_core_rpc_v1.bundled.json` is a generated tooling artifact (non-SSOT); never hand-edit it.
- Engine/tooling/tests must validate against vendored snapshot; snapshot files must not be hand-edited.

## One-command workflow

```bash
make bootstrap
make sync-contracts
make bundle-contracts
make ci
```

## Runtime

```bash
make run-server
```

Server reads JSON-RPC 2.0 requests from stdin (one JSON object per line) and writes JSON-RPC responses to stdout.
