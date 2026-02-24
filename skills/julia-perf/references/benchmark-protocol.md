# Benchmark Protocol

This protocol defines how `julia-perf` produces reproducible performance evidence.

## Run Classes

- Interactive diagnosis:
  - Use `@btime` and ad-hoc profiling to locate bottlenecks quickly.
  - Do not use interactive output as final gate evidence.
- Gate-producing runs:
  - Use `BenchmarkTools` with explicit, fixed parameters.
  - Emit machine-readable artifacts (`benchmarks.json`, `summary.json`, `manifest.json`).

## Suite Contract

`suite_file` must define one of:

1. `JULIA_PERF_BENCHMARKS`:
   - vector of `name => zero_arg_function` pairs, or
2. `julia_perf_benchmarks()`:
   - function returning the same vector shape.

Example:

```julia
const JULIA_PERF_BENCHMARKS = [
  "kernel-a" => (() -> begin
    x = rand(1000)
    sum(@. sin(x) + 3x)
  end),
]
```

## Session Constraint

The suite file is included into `Main` at run time.
Run one gate invocation per Julia process to avoid symbol shadowing from previous suite definitions.

## Gate-Run Defaults

For gate-producing runs:

```julia
using BenchmarkTools
BenchmarkTools.DEFAULT_PARAMETERS.samples = 100
BenchmarkTools.DEFAULT_PARAMETERS.seconds = 30
```

Set `evals` explicitly per benchmark case:
- runtime < 1us: `evals = 1000`
- runtime < 1ms: `evals = 10`
- runtime >= 1ms: `evals = 1`

Do not rely on implicit auto-tuned `evals` for final gate decisions.

## Metrics to Capture

Each benchmark case should include at minimum:
- `name`
- `baseline_median_ns` and `current_median_ns` (when baseline exists)
- `ratio` (`current / baseline`)
- `allocations` delta
- `memory_bytes` delta
- sample count
- evaluation count

Allocation metric note:
- `memory_bytes` is sampled via one warm-up invocation followed by one `@allocated` invocation.

## Output Schemas

### `benchmarks.json`

Array of objects, one per benchmark case:

```json
[
  {
    "name": "hotpath1",
    "baseline_median_ns": 1200.0,
    "current_median_ns": 1100.0,
    "ratio": 0.9167,
    "allocations_delta": -2,
    "memory_bytes_delta": -1024,
    "samples": 100,
    "evals": 1
  }
]
```

### `summary.json`

```json
{
  "verdict": "PASS",
  "exit_code": 0,
  "hard_failures": [],
  "soft_warnings": [],
  "timestamp_utc": "2026-02-14T00:00:00Z"
}
```

Exit code mapping:
- `0`: pass
- `1`: hard fail
- `2`: soft warn only
- `3`: usage or configuration error

## Statistical Guidance

- Default significance guidance: non-parametric comparison (for example Mann-Whitney U) with `alpha = 0.05`.
- If no significance test is run, mark result as uncertain and emit soft warning.

## Required Diagnostics

At least one diagnostic entry per hotpath function:

```julia
# supplemental human-readable type output
@code_warntype target_function(args...)

# benchmark evidence (macro-free pseudocode)
median_ns = measure_hotpath(target_function, args; samples=100, evals=1)
```

Recommended programmatic checks:

```julia
using JET
JET.report_opt(target_function, Tuple{ArgType1, ArgType2})
```

## Manifest Requirements

`manifest.json` should capture:
- Julia version
- OS and CPU
- thread count (`Threads.nthreads()`)
- UTC timestamp
- git revision (if repository available)
- `Manifest.toml` SHA256 hash (or explicit statement that no manifest file was found)
- tool versions (`BenchmarkTools`, `JET` when available)
