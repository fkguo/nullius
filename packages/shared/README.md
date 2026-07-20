# @nullius/shared

Provider-neutral types, schemas, and utilities consumed across the nullius monorepo. This is the **shared contracts layer** — every package that crosses a contract boundary (control plane, domain packs, provider atoms) imports from here rather than redefining the type.

## Layer

Shared contracts layer (cross-cutting). Sits between the control plane (`@nullius/orchestrator`) and the domain/provider packages. Not itself a runtime entrypoint.

## Subpath exports

| Entry | What lives there |
| --- | --- |
| `@nullius/shared` | Top-level barrel including all sub-exports plus `./generated` types |
| `@nullius/shared/types` | Hand-written domain-neutral TypeScript types |
| `@nullius/shared/utils` | Helpers (path/sha256/clock/etc.) used by control plane and domain packs |
| `@nullius/shared/graph-viz` | Memory-graph visualization helpers |
| `@nullius/shared/discovery` | Discovery-pipeline contracts (capabilities, ranking, dedup) |

## Generated contracts

TypeScript types under `src/generated/` are **codegen output** from `meta/schemas/`. Do not edit them by hand. Re-run codegen with:

```bash
pnpm codegen           # regenerate
pnpm codegen:check     # regenerate and fail if the working tree drifts
```

A long-term symbol must not adopt drift-prone suffixes like `v2`, `new_*`, `legacy_*`, or `W1/W2` — see [AGENTS.md](../../AGENTS.md) §Stable Public Invariants.

Gate-result envelopes follow the gate's actual semantics. Team/draft/reproduction
convergence uses `convergence_gate_result_v1`; the pre-dispatch delegation-budget
quality gate uses `delegation_budget_gate_result_v1` with
`pass | fail | input_error`. Do not add non-convergence gate ids to the
convergence envelope.

## Build & test

```bash
pnpm -C packages/shared build
pnpm -C packages/shared test
```

## See also

- Root [README.md](../../README.md) §3 Layer Model — where `shared` fits
- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority — authoritative scope
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) — control plane / contracts boundary discussion
