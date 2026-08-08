# @nullius/orchestrator

Generic lifecycle control plane and bounded workflow CLI for the nullius ecosystem. Exposes both:

- the **`nullius` CLI** — stateful front door for external project roots (init — including the `--mode=<engine|file>` execution-mode declaration —, status, workflow-plan, verify, final-conclusions, report-validate, approve, decision, graph, trace, current, notebook, result, release);
- the **`orch_*` MCP/operator surface** — the canonical operator/tool counterpart of the same control plane, documented in [meta/docs/orchestrator-mcp-tools-spec.md](../../meta/docs/orchestrator-mcp-tools-spec.md).

## Layer

Stateful control plane. One shared authority for lifecycle state, approvals, bounded execution, verification, proposal decisions, conversational-decision recording (`nullius decision record|pending` append to `.nullius/decisions.jsonl`; `decision list` reads it back; trunk-side `decision land` assigns durable ids), and read models. A new decision first carries a six-character random Crockford-base32 handle drawn from 30 unbiased random bits ($32^6 = 2^{30}$). Candidates that also spell durable `D<n>` ids or collide with local identities are redrawn, so the exact pair-collision probability is context-dependent; with no local reservations it is $1/(2^{30}-90{,}000)\approx 9.314\times 10^{-10}$, slightly above $2^{-30}$. The guarantee is probabilistic, not structural, so merged collisions fail closed. The handle is machine-facing branch identity for local relations, with chronological presentation taken from millisecond-precision `ts`. `--resolves` closes only an earlier open `pending` entry; `--relates` records non-closing context to an earlier readable `decided` or `pending` entry. On replay, an unrecognized persisted relation is ignored and reported under `decision_ledger.unrecognized_relations` while its containing record remains admitted; a legacy or unknown non-empty string `kind` is retained under current `decided` semantics, exposing the original `source_kind` and a `normalized_kinds` diagnostic. Only exact `pending` creates an open item, while an otherwise valid `resolves` on a normalized entry still closes its pending target. After branch tails reach the authoritative trunk, `decision land` atomically assigns the next permanent `D<n>` values in trunk file order, rewrites handle-valued relations, and retains the mapping in each landed entry as `provisional_id`. Existing `D<n>` ledgers remain valid, counted, and resolvable without migration. Duplicate detection stays form-agnostic and fail-closed: `decision list` exits non-zero with offending lines for a repeated current id or a retained provisional id that is not one-to-one, the status receipt carries `decision_ledger.duplicate_ids` and `decision_ledger.ambiguous_provisional_ids`, new relation writes refuse an ambiguous target, and landing changes no bytes until the collision is repaired; normal provisional entries remain visible under `decision_ledger.unlanded_count`. A non-no-op landing refuses a ledger with no write permission bit; its last-moment source check detects edits made while the replacement is prepared, while POSIX provides no portable compare-and-swap rename against a non-cooperating writer. If rename succeeds but parent-directory durability cannot be confirmed, the CLI reports commit status uncertain; inspect with `decision list` using the same project root and rerun `decision land` there. A canonical no-op retry fsyncs the parent directory to confirm the visible entry durably. `nullius report-validate` delegates to `packages/project-contracts` for immutable main-report registration, supersession, human-evidence, and structural validation; it does not decide scientific sufficiency. Verification records adjacent production snapshots, absolute declared external refs, runtime/checker identity, process evidence, and checker self-reported matching output observations. A recorded pass does not prove that the checker actually read an output, executed a named negative control, or used an independent implementation. Dependency closure is literally incomplete: it is not syscall traced and does not bind installed bytes, dynamic imports, shared libraries, or an isolated image. The exactly-one-subject A5 consumer therefore currently returns `unavailable`; the generic approve consumer is not reachable from current validation receipts. Not a competing product identity with the MCP surface — both are facets of the same control plane.

## Binary

Build first, then point your `$PATH` at the workspace CLI:

```bash
pnpm -r build
ln -sf "$(pwd)/packages/orchestrator/dist/cli.js" "$HOME/.local/bin/nullius"
chmod +x "$HOME/.local/bin/nullius"
nullius --help
```

A project-local launcher (`./.nullius/bin/nullius`) is also written during `nullius init` so already-initialized research roots can reconnect without the global wrapper. `nullius init --refresh` re-applies the managed scaffold doc (`AGENTS.md`) with per-file backups under `.nullius/backups/`, without touching user-owned seed files. For an existing project that predates the main-report registry, checkpoint it and render a current scaffold in a separate temporary external root; copy only a missing report template and manually merge the `project_index.md#Main research report` section. Refresh never performs that user-owned migration. `report-validate` returns `invalid_registry_markers` before the registry merge and `no_current_report` until a populated current report is registered.

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
