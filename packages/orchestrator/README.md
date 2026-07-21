# @nullius/orchestrator

Generic lifecycle control plane and bounded workflow CLI for the nullius ecosystem. Exposes both:

- the **`nullius` CLI** — stateful front door for external project roots (init — including the `--mode=<engine|file>` execution-mode declaration —, status, workflow-plan, verify, final-conclusions, report-validate, approve, decision, graph);
- the **`orch_*` MCP/operator surface** — the canonical operator/tool counterpart of the same control plane, documented in [meta/docs/orchestrator-mcp-tools-spec.md](../../meta/docs/orchestrator-mcp-tools-spec.md).

## Layer

Stateful control plane. One shared authority for lifecycle state, approvals, bounded execution, verification, proposal decisions, conversational-decision recording (`nullius decision record|pending` append to `.nullius/decisions.jsonl`; `decision list` reads it back), and read models. `nullius report-validate` delegates to `packages/project-contracts` for immutable main-report registration, supersession, human-evidence, and structural validation; it does not decide scientific sufficiency. Verification records adjacent production snapshots, absolute declared external refs, runtime/checker identity, process evidence, and checker self-reported matching output observations. A recorded pass does not prove that the checker actually read an output, executed a named negative control, or used an independent implementation. Dependency closure is literally incomplete: it is not syscall traced and does not bind installed bytes, dynamic imports, shared libraries, or an isolated image. The exactly-one-subject A5 consumer therefore currently returns `unavailable`; the generic approve consumer is not reachable from current validation receipts. Not a competing product identity with the MCP surface — both are facets of the same control plane.

## Binary

Build first, then point your `$PATH` at the workspace CLI:

```bash
pnpm -r build
ln -sf "$(pwd)/packages/orchestrator/dist/cli.js" "$HOME/.local/bin/nullius"
chmod +x "$HOME/.local/bin/nullius"
nullius --help
```

A project-local launcher (`./.nullius/bin/nullius`) is also written during `nullius init` so already-initialized research roots can reconnect without the global wrapper. `nullius init --refresh` re-applies the managed scaffold doc (`AGENTS.md`) with per-file backups under `.nullius/backups/`, without touching user-owned seed files.

## State and artifacts

Writes to **external project roots only**:

```text
<project_root>/
  .nullius/
    HARNESS              # machine-readable handshake
    state.json
    ledger.jsonl
    decisions.jsonl
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
pnpm -C packages/orchestrator test tests/nullius-cli.test.ts   # front-door drift lock
```

## See also

- Root [README.md](../../README.md) — full surface policy, layer model, and external project lifecycle smoke path
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) — control plane internals
- [meta/docs/orchestrator-mcp-tools-spec.md](../../meta/docs/orchestrator-mcp-tools-spec.md) — `orch_*` tool inventory (fail-closed drift-locked)
