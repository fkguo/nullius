---
name: julia-perf
description: Use when writing Julia numerical or scientific code, to apply always-on performance guardrails, gate an accelerated implementation as an identity against its verbatim reference over the full domain of intended use, and escalate to reproducible benchmark gating for speedup or regression claims. Works standalone by default and can optionally emit ecosystem artifacts.
---

# Julia Perf

## Overview

Use this skill as the default performance guardrail for Julia numerical coding.
It applies performance-first coding discipline continuously, and it can escalate to evidence-first benchmark gating when you need to prove speedup or detect regressions.

## When to use

- Any Julia numerical or scientific coding task (new code, refactor, review).
- Explicit Julia performance optimization tasks.
- Julia regression checks on runtime, allocations, or memory usage.
- Producing benchmark evidence for merge, release, or research-quality reporting.

## When not to use

- Non-Julia projects.
- Julia tasks without numerical/scientific kernels (for example docs-only edits).

## Operating modes

### `standalone` (default)

- No shared control-plane dependency required.
- Write artifacts to local output paths such as `.julia-perf/runs/<timestamp>/`.
- Retention: during iterative development reuse a working run directory and keep only the baseline
  plus the latest verifying run; mint a new immutable timestamped directory only for a run cited as
  evidence for a recorded claim.

### `ecosystem` (optional)

- Use when integrating with shared run directories.
- Write artifacts under `artifacts/runs/<tag>/julia-perf/`.
- Never overwrite `artifacts/runs/<tag>/manifest.json` (owned by the shared run control plane).

### `auto`

- Prefer `ecosystem` when required arguments are present.
- Fall back to `standalone` when ecosystem context is missing.

## Usage levels

### Level 1: Default coding guardrails (always on)

Use these in every Julia numerical coding task:
- **Compute only what you need** — the highest-value guardrail and the easiest to miss. Before reaching
  for a general routine, ask *"do I need the WHOLE result, or a part?"* Reaching for the full
  computation when a part suffices is the recurring, order-of-magnitude waste: the full
  eigendecomposition when only a few extremal eigenvalues are wanted (use an index-range or iterative
  solver), a full sort for a min/max (use a partial select), re-forming a matrix factorization on every
  call instead of once and reusing it across right-hand sides, or materializing a whole array only to
  reduce it. This is an ALGORITHMIC win, so it dwarfs the micro-guardrails below — and, unlike them, it
  is INVISIBLE to a passing test suite (a slow-but-correct call fails nothing), so audit for it
  explicitly on every core operation rather than trusting green tests to surface it.
- Prefer concrete types and type-stable function boundaries.
- Avoid abstract containers in hotpaths.
- Avoid global-state driven hot loops.
- Prefer allocation-aware patterns (preallocation, fused broadcast when suitable).
- Treat column-major access order as default in dense matrix kernels.

### Level 2: Evidence gate mode (when claims matter)

Use full gate workflow when publishing speedup/regression claims:
1. Baseline:
   - Require existing baseline for changed hotpaths, or create one with `--save-baseline`.
2. Diagnose:
   - Prefer programmatic checks such as `JET.report_opt` or `Test.@inferred`.
   - Use `@code_warntype` as human-readable supplemental evidence.
   - Capture allocation and hotspot data.
3. Optimize:
   - Apply targeted edits linked to diagnosed bottlenecks.
4. Verify:
   - Re-run benchmark protocol with fixed gate parameters.
5. Emit:
   - Write machine-readable artifacts and a gate verdict.

## Gate policy

### Automated gates (script exit-code relevant)

Hard fail (`exit 1`) conditions:
- Missing baseline and no baseline-init mode.
- Benchmark case execution failure.

Soft warn (`exit 2`) conditions:
- Suite/config warnings that still allow run completion.

Pass (`exit 0`) condition:
- No hard-fail criteria and no soft-warn criteria.

Usage/config error (`exit 3`):
- Invalid CLI arguments, unreadable config, or invalid mode combinations.

### Protocol gates (agent behavior)

- Do not claim speedup using `@time` only.
- Do not skip baseline, diagnosis, or verification steps when entering evidence gate mode.
- Do not emit unverifiable performance claims.
- Severity of review findings is graded by where they land. Always hard-fail, because it is correctness:
  - an accelerated path adopted without the equivalence evidence below
- Hard-fail only on an identified hotpath — one that is profiled hot, or declared hot by the task —
  of an existing computational kernel:
  - new type instability in critical paths
  - non-concrete hotpath containers (`Vector{Any}`, `Dict{String,Any}`, `Array{Real}`, similar)
  - column-major violating loop order in identified matrix hotpaths
- Outside an identified hotpath the same three observations are non-blocking suggestions: a reviewer
  may not declare a path "hot" without a measurement or task declaration and then block on it —
  that would demand less evidence for the blocker than this skill demands for a speedup claim.

### Equivalence gate (an accelerated path must compute the same thing)

Speed evidence says nothing about *what* was computed, and a restructured implementation is derived on the
typical case. Before an accelerated, reorganized, batched, cached, or otherwise restructured implementation
may replace a reference one:

- Verify it as an **identity against the verbatim reference**, to near machine precision, and **state the
  measured agreement** (the worst relative deviation over the compared set) with the result. "It is faster
  and the suite is green" is not that evidence: a suite exercises the inputs someone thought of.
- Cover the **full domain of intended use**, not merely the typical inputs used for benchmarking — including
  the **edge configurations the fast path was not designed around**. An exact algebraic reorganization
  verified to ~1e-16 against the verbatim reference *including* an extended-domain configuration stayed
  verified when that configuration later became load-bearing; the same check restricted to typical inputs
  would have left the later use unverified.
- Re-run the identity when either implementation changes, and record it with the benchmark artifacts — an
  equivalence check that predates the current code proves nothing about it.
- This gate covers only the identity between the two implementations. Whether the reference value itself is
  converged and real belongs to
  [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md); its G10 governs the other case —
  a fast path that is a *heuristic*, correct only under a precondition, rather than an exact reorganization.

## Script contract

Primary entry point:

```bash
julia --project=scripts scripts/run_perf.jl \
  --config templates/perf-config.toml \
  --out-dir /tmp/julia-perf-run \
  --mode standalone \
  --save-baseline
```

Supported flags:

- `--config <path>` required.
- `--out-dir <path>` optional for explicit local output.
- `--mode standalone|ecosystem|auto` optional, default `auto`.
- `--artifact-root <path>` optional (ecosystem mode).
- `--tag <run_tag>` optional (ecosystem mode).
- `--agent-id <id>` optional, used for parallel writer namespacing.
- `--save-baseline` optional.

Read-only behavior:
- The gate script must not mutate source code files.
- It may only write output artifacts in resolved output directories.

## Artifact contract

Expected output files:

- `manifest.json`
- `benchmarks.json`
- `summary.json`
- `diagnostics.md`

Standalone path pattern:
- `.julia-perf/runs/<timestamp>/...`

Ecosystem path pattern:
- `artifacts/runs/<tag>/julia-perf/...`

Parallel writers:
- Prefer `artifacts/runs/<tag>/julia-perf/<agent-id>/...` and merge summaries after run completion.

## Reference files

- `references/performance-tips-map.md`:
  Julia manual tip-to-check mapping schema and required starter entries.
- `references/benchmark-protocol.md`:
  Fixed-parameter benchmark and significance protocol for gate runs.
- `references/environment.md`:
  Julia version and package contract, bootstrap commands.
- `references/research-integration.md`:
  Standalone and ecosystem integration details plus ownership boundaries.
- `templates/perf-config.toml`:
  Minimal config template for reproducible runs.
