---
name: julia-package
description: "Develop or audit Julia computational packages: modules and optional extensions, public APIs, numerical contracts, dependencies, concurrency, tests, documentation, and release readiness. Use for package creation and substantive Julia package changes; combine with julia-perf for kernels and performance claims."
---

# Julia Package

Use this skill for reusable computational libraries. It also applies to research
packages before registration. Keep domain equations, conventions, fixtures and
acceptance tolerances in the target project; this skill specifies how to check
them. Do not introduce a framework, new dependency, release or global environment
change merely to satisfy a checklist.

## Start with the actual package

1. Read local instructions, `Project.toml`, the module entrypoint, public docs,
   affected callers and tests. Record the checkout and uncommitted state when
   evidence will be retained. Distinguish a library, application and research
   reproduction environment before changing dependency policy.
2. Declare the intended public behavior and supported Julia floor, numeric types,
   array representations and backends. Preserve an intentional narrow contract;
   a broad signature is not evidence of broad support. Check current official
   documentation for version-sensitive features using [sources.md](references/sources.md).
3. Reuse suitable standard-library or established package interfaces before
   building another solver, integration layer or cache. Inspect their documented
   applicability; a similar name is not a guarantee of matching semantics.
4. Bound execution and delegation: a task-derived tolerance, hard time limit,
   retry limit and excluded scope. Static audit has no numerical acceptance
   tolerance. A failed or unavailable check remains failed or unavailable.

## Rules for ordinary implementation

- **Separate input, algorithm, mutable workspace and result when useful.** A
  small direct function need not become a problem/solution framework. Keep model
  parameters separate from solver tolerances and mutable caches.
- **Make the public contract explicit.** Document argument meaning, units when
  relevant, shape/axes, mutation and aliasing, supported scalar types, return
  values, failure behavior and numerical validity. Export deliberately; use
  documented accessors rather than another package's internal module or fields.
- **Give shared definitions one owner.** File splitting is not module splitting.
  Keep shared types and generic functions in one namespace, import them into
  consumers, and keep implementation-module dependencies acyclic. Specify root exports
  and public submodule APIs deliberately; avoid duplicate type definitions caused
  by including the same definitions in separate modules.
- **Use generic dispatch and concrete storage.** Abstract arguments often
  specialize efficiently; parametric fields and callable types keep hot storage
  concrete. Do not force `Float64` merely for performance. If the implementation
  intentionally converts, validate the converted value as well as the input:
  finite positive inputs can overflow to `Inf` or underflow to zero.
- **Respect the declared array interface.** Use `axes`, `eachindex`, `similar`
  and `eltype` where suitable. Test the supported views/strides/custom axes; if
  only one-based dense arrays are supported, check that requirement at entry.
  Prove index validity before `@inbounds`; verify changed paths with bounds
  checking enabled. `AbstractArray` alone does not promise GPU compatibility.
- **Expose mutation honestly.** Use `!` for mutation following Julia conventions
  (IO/RNG advancement alone is an exception). State which inputs may alias,
  whether results retain buffer references, and whether workspaces are reusable
  concurrently. Test documented alias cases or reject them explicitly.
- **Preserve numerical meaning.** Validate domain, finite values, dimensions and
  singular cases where the mathematical contract requires them; ordinary
  arithmetic interfaces may legitimately propagate `NaN`/`Inf`. Keep a useful candidate distinct from a
  converged result. Propagate termination reason, residual/error estimate and
  applicability flags where the calculation requires them; ensure printing,
  serialization, tables and plots preserve those distinctions.
- **Thread configuration through every route.** New tolerance, convention,
  precision, backend or workspace choices must reach direct, batched, cached and
  fallback paths. Test non-default choices. Cache identity includes every input
  affecting its contents; mutation must invalidate or rebuild it.
- **Define reuse and capability boundaries.** Reset all state needed by the
  promised restart, including history, schedules, callbacks and diagnostics.
  Check nested result ownership. An available method or base capability does not
  imply support for every requested keyword, representation or backend.
- **Avoid hidden process-wide effects.** Library import must not install packages,
  activate environments, download data, change working directories, seed a
  global RNG or set BLAS threads. Use caller-controlled resources and explicit
  RNGs. `threadid()`-indexed mutable buffers are unsafe under task migration;
  prefer task-owned workspaces or synchronized ownership.
- **Keep optional capabilities optional.** Use `[weakdeps]`/`[extensions]` when
  supported by the declared Julia floor. Load/test core without optional packages
  and each changed extension with its triggers, in fresh processes and relevant
  load orders; for multiple triggers, test that a missing trigger prevents loading.
  Keep extension methods behind a documented package API and respect the loader's
  dependency rules. Do not add AD/GPU support claims
  without tests of the operations actually used.

Read [interfaces.md](references/interfaces.md) for interface, scalar, concurrency
or result-semantics changes. Read [lifecycle.md](references/lifecycle.md) for
dependency, test, documentation, CI or release changes.
Read [modules-and-extensions.md](references/modules-and-extensions.md) when
changing source layout, namespaces, initialization, public submodules or optional
integrations; its loading checks apply before adopting those changes.
Read [ecosystem-patterns.md](references/ecosystem-patterns.md) for reusable
workspaces, callbacks, adapter pipelines, backend configuration, output policies
or specialization/precompilation choices. Apply its checks only to features the
package actually exposes.
For generated/structurally transformed kernels, sparse factor caches or device
and task execution, also read
[structured-and-device-work.md](../julia-perf/references/structured-and-device-work.md)
for the corresponding correctness and measurement boundaries.

## Verification proportional to the change

- A bug fix needs a regression that fails on the defective behavior, preferably
  through the public entrypoint. Cover boundaries and non-default configurations
  touched by the change, rather than reproducing the implementation in a test.
- Select appropriate independent checks: exact small problems, invariants,
  higher precision, another representation, an external oracle or another
  algorithm. Sharing the same helper/reference data can share the same defect.
  Explain model, method and input independence separately when claimed.
- For a public property such as round-trip equivalence or idempotency, generate
  cases from its declared input domain and include explicit boundaries. Use an
  explicit RNG and record its seed and the failing input. Keep a minimized
  counterexample as a deterministic regression when it exposes a defect.
- Set absolute and relative tolerances before inspecting the answer, with a
  scale and conditioning rationale. Near-zero results need an absolute error
  criterion. Reordered floating-point arithmetic need not be bit-identical;
  ill-conditioning does not permit an arbitrary relaxed threshold.
- Run the affected tests and required project checks. For a release or dependency
  change, also test a fresh environment on the declared minimum and current
  supported Julia versions, plus affected extension combinations. Do not call
  dependency resolution or a green unit suite physical acceptance.
- Use Aqua for relevant package-quality checks and JET or `@inferred` for selected
  supported signatures when they add evidence. Inspect findings; do not silence
  entire categories or treat these tools as proofs of numerical correctness.
- Build documentation against the changed local source. Execute changed examples
  and doctests. Check public result presentation after changes to validity flags.
- For numerical kernels, also use [`julia-perf`](../julia-perf/SKILL.md). A
  performance claim requires measurements, an unchanged workload and correctness
  evidence; package cleanliness does not establish speed.

## Completion and neighboring skills

Report behavior changed, actual checks, unresolved limits and concrete next
fixes. A static audit reports source findings and proposed verification, never
invented test passes or timings. Do not auto-apply broad project changes during
an audit or publish/release merely because the package is ready.

For research results, use available specialist gates only at their relevant
boundary: [`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md) for
result-bearing numbers, [`derivation-verify`](../derivation-verify/SKILL.md) for
load-bearing formula changes, and [`research-integrity`](../research-integrity/SKILL.md)
before promoting conclusions. If a required specialist is unavailable, retain
the evidence and state the limitation. Ordinary package maintenance remains
usable without a shared control plane.
