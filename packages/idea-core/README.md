# idea-core

Retiring internal Python reference engine for legacy contract parity and fixture generation.

This package is no longer the public runtime front door. The active host authority is the TS
`idea-engine`; new integrations should target that surface instead of wiring against `idea-core`.
`idea-core` remains in-tree only while the remaining fixture-generation and parity workflows are
being migrated off the Python implementation.

## Contract Source Strategy (M1.0)

- SSOT stays in sibling design/contract package: `../idea-generator` (inside this monorepo).
- This repo keeps a **read-only vendored snapshot** under `contracts/idea-generator-snapshot/schemas/`.
- Sync is explicit and auditable: `make sync-contracts` updates snapshot + `CONTRACT_SOURCE.json` with source commit.
- `idea_core_rpc_v1.bundled.json` is a generated tooling artifact (non-SSOT); never hand-edit it.
- Engine/tooling/tests must validate against vendored snapshot; snapshot files must not be hand-edited.

## Maintainer Workflow

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

Maintainer-only stdio JSON-RPC entrypoint for parity checks and retirement-gap debugging.
