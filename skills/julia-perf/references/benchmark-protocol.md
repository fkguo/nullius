# Benchmark protocol

The runner collects warmed kernel measurements with `BenchmarkTools.Trial`. It
does not measure package load time, first-call latency, inference quality,
implementation equivalence, or statistical significance. A threshold `PASS`
means only that the declared descriptive regression limits passed.

## Workload definition

Define `JULIA_PERF_BENCHMARKS` or `julia_perf_benchmarks()` returning a nonempty
vector/dictionary of `name => Benchmark` pairs. Names must be unique. Suites are
loaded in their own module in a fresh supervised Julia process.

```julia
using BenchmarkTools, Random
const input = rand(MersenneTwister(17), 256)
kernel!(y, x) = (@. y = sin(x) + 3 * x)
const JULIA_PERF_BENCHMARKS = [
    "kernel" => @benchmarkable(kernel!(y, $input),
        setup=(y=similar($input)), evals=1),
]
```

Interpolate fixed inputs. Put reset/allocation of mutable fixtures in `setup`;
setup executes once per sample, so mutating workloads normally require
`evals=1`. Declare whether data generation, copying, factorization, and output
allocation belong inside the measured operation. Reject benchmarks whose work
can be constant-folded or eliminated. Seed stochastic input generation, and
hash external data through `benchmark.input_files`.

Declare the outputs the consumer requires: selected components, endpoints,
sampled history, event-side values, queryable interpolation or a materialized
adapter/rendering result, as applicable. Compare implementations delivering the
same requirements, tolerances, event semantics and effective backend. Include
actual output consumption where lazy work would otherwise be omitted. Less
saving may reduce memory/time without removing internally needed interpolation
or event work. A changed consumer requirement is a workload change, not by
itself an equivalent-computation speedup.

To attribute a speedup to a representation, apply every compatible optimization
to the competing implementations too. Trace the actual code paths through
preparation, reuse, evaluation and output. Run a paired comparison that changes
only the representation, including the cost of constructing it. Rotate execution
order across repeated rounds and compare with the fastest verified equivalent
implementation. Report preparation or kernel gains separately from whole-workload gains.

For reusable state, distinguish a fresh construction from a documented restart.
Reset history, schedules, callback state and diagnostics as well as visible
arrays; verify the reused case against a fresh case after relevant prior exit
states. The runner does not inspect these semantic requirements automatically.

Record effective specialization policy and the variety/frequency of callable,
parameter and size types in the intended use. Measure fresh-process first calls
separately when latency matters, including any extension loading required by
the consumer. Precompile directives do not establish lower latency by themselves.
This runner supplies warmed trials only; cold/precompile measurements need a
separate protocol. See [ecosystem-patterns.md](../../julia-package/references/ecosystem-patterns.md).

For asynchronous/device/task workloads, a benchmarkable operation must wait for
the claimed work to complete. Include transfers and result materialization when
required by the consumer. Record backend/device and the effective completion
boundary separately; the runner's environment fingerprint does not inspect an
accelerator's identity or enforce waits. See
[structured-and-device-work.md](structured-and-device-work.md).

Pure zero-argument functions are also supported with `policy="fixed"`.
For per-case parameters use `policy="suite"` and explicitly declare `evals`
on every `Benchmark`. The runner never tunes `evals` independently for baseline
and candidate. Samples and seconds come from the config, with `gctrial=true`,
`gcsample=false`, and zero overhead correction.

## Capture and compare

1. Run unchanged reference code with `--save-baseline`. Keep its `baseline.json`
   with its source and input evidence. This creates a baseline; it does not
   validate a speedup or pass a regression check.
2. Point `benchmark.baseline_file` at that `baseline.json`.
3. Benchmark candidate code with the same suite, input files, actual evals,
   protocol, Julia binary/options, threads, BLAS, machine/CPU, and dependency
   environment. Candidate source hashes may differ. Declared path dependencies
   are hashed; the candidate package's source is recorded separately.
4. Declare project-justified limits in `[regression]`. Supported limits are
   `max_time_ratio`, `max_memory_ratio`, `max_memory_bytes`, and
   `max_allocations`. Ratio means current / baseline; absolute limits apply to
   current metrics. No universal regression tolerance is supplied.

Missing, corrupt, empty, duplicate, unmatched, or incomparable baselines fail.
The embedded manifest must retain well-formed schema/tool, timestamp, config,
source-root/file hashes, Git evidence, output and limitation fields as well as
the comparison signature. Source/config hashes can differ between reference
and candidate; their absence is not a supported way to make a comparison pass.
Format checks do not authenticate a caller-supplied record or prove undeclared
inputs were captured.
Historical arrays lacking provenance remain readable as historical evidence;
they cannot authorize a new comparison. Absolute allocation/memory metrics
must be present; historical deltas never substitute for them. No thresholds
means `UNVERIFIED` even if execution completes successfully. A missing resolved
`Manifest.toml` also prevents a comparison `PASS`.

For a speedup claim, separately supply numerical/behavioral equivalence,
appropriate type/hotspot diagnosis, and repeated/interleaved or independently
replicated timing evidence with an uncertainty analysis suited to the noise.
These checks are external to this runner. A single median ratio does not
establish significance. See the [BenchmarkTools manual](https://juliaci.github.io/BenchmarkTools.jl/stable/manual/)
for interpolation, setup, explicit evals, and Trial semantics.

## Artifacts and status

- `benchmarks.json`: raw per-evaluation `sample_times_ns`/`sample_gc_times_ns`,
  median/minimum time, actual samples/evals, real Trial `allocations` and
  `memory_bytes`, and comparison ratios/deltas when available. Trial allocation
  count/memory are minimum per-evaluation metrics observed across samples;
  they are not Boolean flags or a separate `@allocated` probe.
- `manifest.json`: config/suite/runner SHA256, declared source/input hashes,
  git revision and dirty-state/diff hashes, dependency/environment fingerprint,
  protocol, actual evals, and explicit measurement limitations.
- `summary.json`: verdict, exit code, `thresholds_passed`, `claim_verified=false`,
  `statistical_analysis="not_performed"`, and
  `equivalence_check="external_required"`.
- `baseline.json`: created only by successful baseline initialization; embeds
  the provenance manifest and complete raw rows.

Exit 0 is `BASELINE_CREATED` or a declared-threshold `PASS`; inspect the verdict.
Exit 1 is failure; exit 2 is `UNVERIFIED`; exit 3 is configuration/usage error.
No automatic type-inference/JET diagnostics report is produced.

## Bounded execution and source preservation

`timeout_seconds` is a supervisor deadline covering child startup, suite
loading, compilation, warmup, and sampling. It starts after the supervisor's
own imports/configuration. A timed-out child is killed, a `FAIL` summary is
written, and complete case rows already written are retained. This bounds the
worker Julia process; workloads that start external processes must manage
their own process lifecycle. The runner writes only its output artifacts;
user-supplied suite code remains responsible for its own side effects.

Output artifact writes are atomic. An existing output with result artifacts is
rejected to prevent stale verdicts. `latest` may be replaced only when it is a
symlink; an existing real directory is preserved. Source/input/environment
hashes are checked again after sampling to detect changes during a run.
Directories published through `latest` persist after the Julia process exits,
including failed-run summaries; they are evidence outputs, not temporary storage
registered for process-exit cleanup.

Declare source files explicitly, including code loaded outside `src`; git
revision alone does not identify dirty/untracked source bytes. Input/source
declarations cannot capture unlisted external data, environment variables,
power state, background load, or thermal effects. Document those separately.
