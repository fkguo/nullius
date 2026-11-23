# Inspecting compiler output for hot Julia calls

A type-stable, allocation-free loop can still repeat a transcendental
function, a division or a conversion for every element. Read the optimized
code for the concrete call that the consumer times. A profiler can locate a
hot loop or call boundary. Compiler output can show which work runs on every
iteration, which work runs once per call, and why a simpler source expression
could reduce executed instructions.

## Inspect the executed path

1. **Reproduce the call boundary.** Take argument types, callable and capture
   types, storage layout and options from the timed workload. Inspect the
   actual wrapper as well as the inner function when it affects inlining or
   constant propagation. Supply runtime values as in the workload so a
   constant-only probe cannot hide work done for an arbitrary caller.
2. **Read optimized typed IR and LLVM.** Start with `@code_typed optimize=true`
   to find residual dispatch, conversions and function boundaries. Use
   `@code_llvm optimize=true debuginfo=:none` on the hot specialization.
   Identify the loop back edge and locate expensive calls and arithmetic
   relative to it. Follow a callee if it remains out of line. Use
   `@code_native debuginfo=:none` when vectorization, call placement or
   generated machine instructions are decisive. Inspect each relevant route,
   including guarded vector blocks, scalar fallbacks and remainder loops.
   One static instruction can execute many times, so counting mentions of a
   symbol in a dump is insufficient.
3. **Check for removable work.** Look for repeated scalar math on invariant
   arguments, metadata or shape conversion, callback dispatch, hidden
   materialization and avoidable branches in the inner loop. For a comparable
   compiled reference, inspect the corresponding generated loop and the
   timing boundary to test whether one side already moves or eliminates this
   work. For Clang, use `-S -emit-llvm` with the measured optimization and
   target options, then check the linked path when link-time optimization is
   enabled. Record the compiler, CPU and math backend.
4. **Make the smallest source change and recheck.** Move a pure invariant to
   the outer computation, pass prepared state across a typed function
   boundary, or remove a repeated conversion at its source. An invariant
   address can still refer to changing data. Check aliasing, exception order,
   empty inputs and early exits before hoisting. Check all supported numeric
   types, including AD inputs when applicable. `Base.infer_effects` can help
   diagnose a missed move on versions that provide it. Explicitly preparing
   known invariants avoids promising effects for extensible callbacks. Keep
   the original operations and order unless a numerical change has its own
   acceptance criteria. Replacing division with multiplication by a
   reciprocal can change rounding and exceptional-value behavior. Reinspect
   that specialization and check equivalence
   and timing on the real entry point.

For residual bounds branches, find which actual indices the compiler cannot
prove valid. When the API permits it, validate those ranges at entry and use
the smallest `@inbounds` scope in the concrete kernel. Exercise boundary
indices and supported nonstandard axes with `--check-bounds=yes`. Inspect
the compiler output again under the normal runtime configuration.
[Julia bounds checking](https://docs.julialang.org/en/v1/devdocs/boundscheck/)

## Specialization and constant propagation

- Run the representative public entry point before probing individual methods.
  Check the caller and, when forwarding may suppress specialization, inspect
  `Base.specializations(@which f(args...))` after actual calls in a fresh
  process. Direct IR probes can request specialized code even when ordinary
  execution did not compile that method instance. If a measured forwarding
  boundary is missing dispatch resolution, try a precise `where` parameter
  for the forwarded callable, type or vararg arity that actually matters.
  [Julia specialization heuristics](https://docs.julialang.org/en/v1/manual/performance-tips/#Be-aware-of-when-Julia-avoids-specializing)
- Compare runtime and literal choices at the caller. Move repeated keyword
  normalization or option branching outside the loop when the API's defaults,
  evaluation order and errors allow it. Try a targeted call-site `@inline`
  or `Base.@constprop :aggressive` when the optimized caller still shows a
  profitable boundary. Compare compilation cost and the runtime-option case
  as well. [Julia keyword lowering](https://docs.julialang.org/en/v1/devdocs/functions/#Keyword-arguments) ·
  [Constant propagation controls](https://docs.julialang.org/en/v1/base/base/#Base.@constprop)
- If diverse callables or types drive compilation cost, consider keeping cold
  orchestration shared and the expensive numerical kernel specialized. Avoid
  specializing on unbounded runtime values. On a cold boundary, `@nospecialize`
  limits specialized native code generation. Used with `@nospecialize`,
  `Base.@nospecializeinfer` (Julia 1.10 and later) also limits inference for
  the marked arguments. That can cost the caller return-type information.
  Recheck inference at that caller. [Julia specialization annotations](https://docs.julialang.org/en/v1/base/base/#Base.@nospecializeinfer)

  Record compilation
  with `--trace-compile=trace.jl` and, where available, `--trace-compile-timing`
  in a diagnostic run. Measure package load, representative first calls and
  warm throughput separately. Use observed common signatures to choose
  [precompile workloads](../../julia-package/references/ecosystem-patterns.md#specialization-and-precompilation).

## Layout, aliasing and vectorization

- Check that real array layouts, overlap and trip counts reach the generated
  vector path. The presence of vector instructions does not tell which path an
  overlapping view or short input takes. When a loop repeatedly reloads a
  scalar through memory that may overlap an output, consider passing it by
  value only when disjointness or the API's snapshot semantics permits it.
  Preserve live reads for supported overlapping inputs. Test empty, short
  and vector-tail lengths as well as valid overlapping inputs.
  [LLVM runtime pointer checks](https://llvm.org/docs/Vectorizers.html#runtime-checks-of-pointers)
- Check `axes` and, for strided arrays, `strides`. Try unit-stride inner loops
  or reusable contiguous buffers when layout prevents vectorization or
  locality. For a packing scheme, include packing, writeback and the observed
  reuse count. A fieldwise workload can also benefit from a struct of arrays
  when the layout conversion pays for itself.
- Compare a small fixed-size or fused matrix kernel with `mul!` across the
  actual shapes, element types and views. Verify which path the call reaches,
  including its BLAS backend and thread count when used. Include conversion or
  packing, and check changed reduction order against the numerical budget.
  For unrolled kernels, inspect code size and register spills and measure the
  first call across the shapes users encounter. [Julia `mul!` contract](https://docs.julialang.org/en/v1/stdlib/LinearAlgebra/#LinearAlgebra.mul!)
- Check actual reads, writes and indices before annotating a loop with
  `@simd`. It can permit floating-point reductions to be reordered or
  contracted. `@simd ivdep` additionally asserts no loop-carried memory
  dependency. Shifted overlap and repeated scatter indices can violate that
  assumption. Preserve the ordered reduction when its rounding or
  exceptional-value semantics are part of the contract.
  [Julia SIMD semantics](https://docs.julialang.org/en/v1/base/base/#Base.SimdLoop.@simd)

## Example of scalar work repeated across a loop

The following functions keep the same per-element arithmetic. The early
return preserves the empty-input behavior for a scale whose logarithm throws.
If the interface exposes NaN payloads, compare their bit patterns explicitly.
Generated floating-point instructions can choose different NaN payloads even
when the source arithmetic is preserved.
[LLVM NaN behavior](https://llvm.org/docs/LangRef.html#nan-behavior)

```julia
using InteractiveUtils

function sum_offsets_reference(data::Vector{Float64}, scale::Float64)
    total = 0.0
    for x in data
        total += x + log(scale)
    end
    return total
end

function sum_offsets(data::Vector{Float64}, scale::Float64)
    isempty(data) && return 0.0
    offset = log(scale)
    total = 0.0
    for x in data
        total += x + offset
    end
    return total
end

data = [1.0, 2.0, 3.0]
scale = 1.5
@code_llvm optimize=true debuginfo=:none sum_offsets_reference(data, scale)
@code_llvm optimize=true debuginfo=:none sum_offsets(data, scale)
```

Look for the logarithm or its inlined implementation on the loop path.
Compiler versions can produce different placements. Test the observed
placement for the version and caller that matter, then compare warmed timings
with the inputs interpolated into the benchmark. Record the before/after
specialization, the relevant loop excerpt, and the full-operation result.
Compiler output identifies which work was removed. Repeat the timings at the
workload boundary before claiming a speedup there.

[Julia InteractiveUtils](https://docs.julialang.org/en/v1/stdlib/InteractiveUtils/) ·
[Julia Performance Tips](https://docs.julialang.org/en/v1/manual/performance-tips/)
