---
name: julia-perf
description: Use when writing Julia numerical or scientific code, to apply always-on performance guardrails and escalate to reproducible benchmark gating for speedup or regression claims. Works standalone by default and can optionally emit ecosystem artifacts.
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
- Treat the following as policy hard-fail findings in review, even when not yet auto-enforced by script:
  - new type instability in critical paths
  - non-concrete hotpath containers (`Vector{Any}`, `Dict{String,Any}`, `Array{Real}`, similar)
  - column-major violating loop order in identified matrix hotpaths

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
