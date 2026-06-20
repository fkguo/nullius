# @autoresearch/orchestrator

Generic lifecycle control plane and bounded workflow CLI for the autoresearch ecosystem. Exposes both:

- the **`autoresearch` CLI** — stateful front door for external project roots (init, status, workflow-plan, verify, final-conclusions, approve, graph);
- the **`orch_*` MCP/operator surface** — the canonical operator/tool counterpart of the same control plane, documented in [meta/docs/orchestrator-mcp-tools-spec.md](../../meta/docs/orchestrator-mcp-tools-spec.md).

## Layer

Stateful control plane. One shared authority for lifecycle state, approvals, bounded execution, verification, proposal decisions, and read models. Not a competing product identity with the MCP surface — both are facets of the same control plane.

## Binary

Build first, then point your `$PATH` at the workspace CLI:

```bash
pnpm -r build
ln -sf "$(pwd)/packages/orchestrator/dist/cli.js" "$HOME/.local/bin/autoresearch"
chmod +x "$HOME/.local/bin/autoresearch"
autoresearch --help
```

A project-local launcher (`./.autoresearch/bin/autoresearch`) is also written during `autoresearch init` so already-initialized research roots can reconnect without the global wrapper. `autoresearch init --refresh` re-applies the managed scaffold doc (`AGENTS.md`) with per-file backups under `.autoresearch/backups/`, without touching user-owned seed files.

## State and artifacts

Writes to **external project roots only**:

```text
<project_root>/
  .autoresearch/
    HARNESS              # machine-readable handshake
    state.json
    ledger.jsonl
    plan.md
    approval_policy.json
    fleet_queue.json     # if fleet features used
    fleet_workers.json   # if fleet features used
  artifacts/
    runs/<run_id>/
      approvals/<approval_id>/
        approval_packet_v1.json
```

Development repo paths are not real project roots — see [AGENTS.md](../../AGENTS.md) §Stable Public Invariants.

## Build & test

```bash
pnpm -C packages/orchestrator build
pnpm -C packages/orchestrator test
pnpm -C packages/orchestrator test tests/autoresearch-cli.test.ts   # front-door drift lock
```

## See also

- Root [README.md](../../README.md) — full surface policy, layer model, and external project lifecycle smoke path
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) — control plane internals
- [meta/docs/orchestrator-mcp-tools-spec.md](../../meta/docs/orchestrator-mcp-tools-spec.md) — `orch_*` tool inventory (fail-closed drift-locked)
