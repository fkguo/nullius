# @nullius/shared

Provider-neutral types, schemas, and utilities consumed across the nullius monorepo. This is the **shared contracts layer** — every package that crosses a contract boundary (control plane, domain packs, provider atoms) imports from here rather than redefining the type.

## Layer

Shared contracts layer (cross-cutting). Sits between the control plane (`@nullius/orchestrator`) and the domain/provider packages. Not itself a runtime entrypoint.

## Subpath exports

| Entry | What lives there |
| --- | --- |
| `@nullius/shared` | Top-level barrel: types, tool-name/risk/annotation tables, artifact-ref, gate registry, discovery, utils and the other root modules, plus `./generated` types; `./graph-viz` is not re-exported from it |
| `@nullius/shared/types` | Hand-written domain-neutral TypeScript types |
| `@nullius/shared/utils` | Helpers (LRU cache, INSPIRE/arXiv/DOI URL builders, text and author formatters, rate-limit helpers, `sortKeysRecursive`, ...) used by control plane and domain packs |
| `@nullius/shared/graph-viz` | Graphviz dependency-graph rendering engine and adapters: claims, progress, literature and roadmap (behind `nullius graph`) plus a memory-graph adapter |
| `@nullius/shared/atomic-write` | Durable atomic-write primitives (`writeBytesAtomicDurable`, `writeJsonAtomicDurable`, `appendJsonlDurable`, ...) |
| `@nullius/shared/discovery` | Provider capability descriptors and evidence localization/multimodal artifact contracts |

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

Notebook content-review evidence reuses `verification_subject_v1`,
`verification_check_run_v1`, `verification_subject_verdict_v1`,
`verification_coverage_v1`, and `ArtifactRef` rather than defining another
verification authority. It binds the complete UTF-8 notebook and required
declared dependencies by SHA-256 of their actual bytes, including automatic
blocks and uncommitted edits. The semantic check is supporting evidence;
accepted prose review is neither decisive computation validation nor proof of
scientific truth. Coverage and reviewer independence remain explicit limits.

Valid UTF-8 text remains text regardless of size; Markdown links are discovered
recursively. Binary or invalid UTF-8 linked files are immutable `opaque_links`
snapshots and hash locators, not read evidence. Every opaque path/hash needs a
specific `opaque_sources` assessment; a required unread source prevents acceptance.
Notebook and explicit dependencies require strict UTF-8 and LF or CRLF endings.

The complete material is frozen before review. Storage (`--snapshot-bytes`,
default 512 MiB; `--max-files`, default 256) is separate from each request's
`--context-bytes` and configured backend `--context-tokens` window (default
200,000 tokens, with instruction/output reserves). Default request bytes use a
conservative token upper bound. A larger explicit byte packet requires captured
backend token usage when that bound exceeds the window; missing capacity evidence,
observed backend compaction or delivery failure supplies no acceptance.

Larger materials use original UTF-8 intervals with adjacent original context,
followed by a joint audit receiving the COMPLETE original notebook and text
dependencies. All intervals and the joint audit must be complete and fresh;
selected quotations or summaries cannot replace this original input. The default
execution budget is 1200 seconds and 64 calls (`--timeout-secs`, `--max-batches`),
with one attempt per call and no automatic retry. Shortfalls expose total frozen
material, pending intervals and joint scope, the reason and a resumable command.
An unfinished intake reports discovered material and incomplete dependency
enumeration. `--resume <run-id>` creates a new run, revalidates original receipts
and material identity, retains explicit dependencies and storage budgets, and
never rewrites old evidence. If the full joint input does not fit the backend,
raise an available backend's request budget or leave the review incomplete.
Only tool mode `none` is accepted. Multiple batches are one semantic review;
they do not establish independent confirmations or a cross-family quorum.

## Build & test

```bash
pnpm -C packages/shared build
pnpm -C packages/shared test
```

## See also

- Root [README.md](../../README.md) §3 Layer Model — where `shared` fits
- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority — authoritative scope
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) — control plane / contracts boundary discussion

Capacity evidence requires an adjacent runtime observation of the actual successful invocation, including requests that fit the conservative byte bound. The local runtime binds the complete original request, actual report locator, working directory and captured bytes using its host authority; recalculating project artifact hashes cannot create that observation. Verification trusts the runtime and owning OS account, and does not authenticate provider truth or scientific correctness. Historical unsigned records remain readable, but cannot supply new capacity acceptance; they are never retrospectively signed.

Interrupted notebook reviews resume in a fresh run from immutable intake and batch checkpoints, retaining original bytes and rechecking current material. Only completed, fresh, runtime-observed primary interval receipts can be reused; the complete-original joint audit is always executed again. Missing closure, stale sources or incomplete operations remain unavailable or incomplete. Member reproduction evidence requires an authenticated actual producer episode and the complete source/data inputs bound to the executed command; declared inputs and bounded static discovery do not prove arbitrary filesystem activity.

Runtime observations bind the actual report location, so copying signed capture bytes cannot authenticate a new invocation elsewhere. Member episodes freeze every observed file into durable original storage before publication; successful workspace cleanup preserves subsequent verification. Records lacking these bindings remain readable and unavailable for new acceptance.

Member origin trusts the configured runner and owning host runtime: the complete runner bytes are recorded, but no runner allowlist or provider attestation is claimed. Offline or injected host execution establishes a local process/callable observation; actual provider capacity evidence requires the corresponding CLI capture. The canonical team cycle performs a postflight source assessment and a separate fresh assessment at the final consumer; both use the configured assessor request/execution budgets.

The owning account can read the authority key, including code executed by a member under that account; this authenticates against non-executing artifact tampering, not hostile same-account code. No OS sandbox or provider attestation is supplied.

The configured token window is frozen before the original reviewer subprocess starts and bound into its authenticated runtime observation. Changing historical window metadata cannot admit that receipt. Older observations without this policy remain readable and require a fresh execution for capacity acceptance.

Local directory links leave notebook dependency closure pending and prevent acceptance. The complete-original joint audit requires exact substantive original-byte anchors for every interval; a reasoning checkbox alone cannot supply coverage.
