---
name: julia-perf
description: Use when writing Julia numerical or scientific code, to apply always-on performance guardrails, gate an accelerated implementation as an identity against its verbatim reference over the full domain of intended use, and escalate to reproducible benchmark gating for speedup or regression claims. Works standalone by default and can optionally emit ecosystem artifacts.
---

# Julia Perf

## Overview

Use this skill as the default performance guardrail for Julia numerical coding.
It applies performance-first coding discipline continuously, and it can escalate to evidence-first benchmark gating when you need to prove speedup or detect regressions.

For package interfaces, dependency policy, concurrency, tests and documentation,
also use [`julia-package`](../julia-package/SKILL.md). Concrete hot storage and
generic public arguments are compatible: abstract signatures normally specialize
for concrete calls. Performance does not justify silently narrowing supported
precision, array axes or mathematical scope.

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
- **Compute the required outputs.** Check whether the consumer needs a full
  result or a subset. Candidates include selected eigenvalues, partial selection
  instead of a full sort, factor reuse across right-hand sides, and reductions
  without full intermediate materialization. Check the alternative algorithm's
  applicability and numerical contract. Unnecessary work can dominate cost;
  measure the actual workload before asserting a gain. Correctness tests alone
  do not establish that the algorithm meets a time or memory budget.
- Prefer concrete types and type-stable function boundaries.
- Avoid abstract containers in hotpaths.
- Avoid global-state driven hot loops.
- Prefer allocation-aware patterns (preallocation, fused broadcast when suitable).
- Treat column-major access order as default in dense matrix kernels.
- Establish index/alias validity before `@inbounds`; do not introduce `@fastmath`
  or reassociated reductions without checking their changed numerical semantics.
- Use views, copies, static arrays and broadcast fusion according to measured
  workload: noncontiguous views can lose to copies, and unfusing an expensive
  axis-invariant operation can avoid repeated computation.
- Distinguish package load/compilation, preparation/factorization and repeated
  execution costs. Measure the cost the user actually pays.
- Treat requested outputs, materialization/interpolation, event handling and
  effective backend/specialization choices as part of the workload. Reducing
  saved output is valid only if it still meets the declared consumer contract;
  otherwise it is a different workload. Reset reused state completely.
- Choose specialization and precompile workloads from observed usage. Compare
  cold latency and warm throughput when callable/type diversity changes; neither
  full specialization nor dynamic orchestration is universally preferable.
- For symbolic/sparse/generated kernels, device execution or scheduled tasks,
  read [structured-and-device-work.md](references/structured-and-device-work.md).
  Measure completed work and preserve the transformation/ownership contract.

### Level 2: Evidence gate mode (when claims matter)

Use full gate workflow when publishing speedup/regression claims:
1. Baseline:
   - Require a comparable provenance-bound baseline for changed hotpaths, or
     create `baseline.json` with `--save-baseline` before changing the code.
2. Diagnose:
   - Prefer programmatic checks such as `JET.report_opt` or `Test.@inferred`.
   - Use `@code_warntype` as human-readable supplemental evidence.
   - Capture allocation and hotspot data.
3. Optimize:
   - Apply targeted edits linked to diagnosed bottlenecks.
4. Verify:
   - Re-run benchmark protocol with fixed parameters and declared limits.
   - Use fresh/reset inputs for mutable workloads and compare actual evals,
     runtime, dependency, machine and input identities.
5. Emit:
   - Write machine-readable artifacts and a gate verdict.

## Gate policy

### Automated gates (script exit-code relevant)

Failure (`exit 1`) includes invalid/empty/unmatched/incomparable baselines or
suites, benchmark execution failure, deadline exhaustion and a violated declared
regression limit. Usage/configuration errors use `exit 3`.

`exit 0` means `BASELINE_CREATED` or a declared-threshold `PASS`; inspect the
verdict. Missing thresholds or a missing resolved environment leave the comparison
`UNVERIFIED` (`exit 2`). A threshold pass covers only the descriptive measurement
limits. The script always reports `claim_verified=false`: inference diagnosis,
numerical equivalence and suitable uncertainty evidence are external obligations.

Do not reinterpret successful execution or a single median ratio as a verified
speedup. See [benchmark-protocol.md](references/benchmark-protocol.md) for the
actual measured scope, reset semantics, comparisons and timeout boundary.

### Protocol gates (agent behavior)

- Do not claim speedup using `@time` only.
- Do not skip baseline, diagnosis, or verification steps when entering evidence gate mode.
- Do not emit unverifiable performance claims.
- Severity of review findings is graded by where they land. Always hard-fail, because it is correctness:
  - an accelerated path adopted without the equivalence evidence below
- Type instability, abstract storage and poor traversal order require examination
  of the actual hot call chain, layout and function barriers. They are blockers
  only when correctness, an explicit resource budget or a measured regression is
  violated. A reviewer may not declare an unmeasured path hot solely to block a
  change. Dynamic orchestration, intentional heterogeneous storage and a
  non-column-major representation are not inherently defects.

### Equivalence gate (an accelerated path must compute the same thing)

Speed evidence says nothing about *what* was computed, and a restructured implementation is derived on the
typical case. Before an accelerated, reorganized, batched, cached, or otherwise restructured implementation
may replace a reference one:

- Verify it as an **identity against the verbatim reference**, under a declared
  precision- and conditioning-aware error budget, and **state the measured agreement**
  (worst absolute and scaled relative deviations over the compared set) with the result. "It is faster
  and the suite is green" is not that evidence: a suite exercises the inputs someone thought of.
- Cover the **full domain of intended use**, not merely the typical inputs used for benchmarking — including
  the **edge configurations the fast path was not designed around**. Enumerate
  supported regimes and test their boundaries and exceptional cases. Finite tests
  alone do not prove an identity on an infinite domain; justify the transformation
  analytically where needed and scope any untested regime as unverified. Near
  machine precision is appropriate for well-conditioned exact rearrangements,
  not a universal decimal threshold. Fix the error budget before comparison;
  near-zero values need an absolute criterion. Do not relax it to make a failed
  optimization pass or exceed the downstream observable's error budget.
- Re-run the identity when either implementation changes, and record it with the benchmark artifacts — an
  equivalence check that predates the current code proves nothing about it.
- This gate covers only the identity between the two implementations. Whether the reference result itself is
  numerically reliable belongs to
  [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md); its G10 governs the other case —
  a fast path that is a *heuristic*, correct only under a precondition, rather than an exact reorganization.

## Script contract

Primary entry point:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/julia-perf" ] && echo "$r/skills/julia-perf" && break; done || true)}"
julia --project="$SKILL_DIR/scripts" "$SKILL_DIR/scripts/run_perf.jl" \
  --config /absolute/path/to/project/perf-config.toml \
  --out-dir /absolute/path/to/project/performance/reference \
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
- `--save-baseline` optional; creates a provenance-bound baseline artifact.

Read-only behavior:
- The runner writes only output artifacts, preserves existing result directories
  and records source/input identities before and after sampling.
- User-supplied suites execute Julia code and remain responsible for their own
  side effects; this script is not a sandbox.

## Artifact contract

Expected output files:

- `manifest.json`
- `benchmarks.json`
- `summary.json`
- `baseline.json` (successful baseline initialization only)

The runner does not create an automatic inference/diagnostics verdict. Record
actual external type, hotspot and equivalence checks beside the run when required.

Standalone path pattern:
- `.julia-perf/runs/<timestamp>/...`

Ecosystem path pattern:
- `artifacts/runs/<tag>/julia-perf/...`

Parallel writers:
- Prefer `artifacts/runs/<tag>/julia-perf/<agent-id>/...` and merge summaries after run completion.

## Reference files

- `references/performance-tips-map.md`:
  Julia manual tip-to-check mapping schema and required starter entries.
- [`julia-package/references/ecosystem-patterns.md`](../julia-package/references/ecosystem-patterns.md):
  Source-derived checks for workspace reuse, output costs, adapters,
  specialization and bounded precompilation.
- `references/structured-and-device-work.md`:
  Conditional checks for structured transformations and completed device/task work.
- `references/benchmark-protocol.md`:
  Fixed-parameter benchmark and significance protocol for gate runs.
- `references/environment.md`:
  Julia version and package contract, bootstrap commands.
- `references/research-integration.md`:
  Standalone and ecosystem integration details plus ownership boundaries.
- `templates/perf-config.toml`:
  Minimal config template for reproducible runs.
