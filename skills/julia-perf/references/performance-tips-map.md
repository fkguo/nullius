# Julia Performance Tips Map

This file maps Julia official performance guidance to concrete checks used by `julia-perf`.

Primary source:
- https://docs.julialang.org/en/v1/manual/performance-tips/

## Entry Schema

Each map entry must include:
- `id`
- `manual_section`
- `url`
- `check_type` (`static`, `runtime`, `review`)
- `implementation_hint`
- `anti_pattern`
- `correct_pattern`
- `automated` (`true` or `false`)
- `gate_severity` (`hard`, `soft`, `info`)

## Required v1 Entries

```yaml
- id: avoid-global-variables
  manual_section: Avoid untyped global variables
  url: https://docs.julialang.org/en/v1/manual/performance-tips/#Avoid-untyped-global-variables
  check_type: static
  implementation_hint: grep for 'global ' usage inside function bodies
  anti_pattern: |
    x = 0.0
    function bump()
      global x
      x += 1.0
    end
  correct_pattern: |
    function bump(x::Float64)
      x + 1.0
    end
  automated: true
  gate_severity: hard

- id: ensure-type-stability
  manual_section: Write type-stable functions
  url: https://docs.julialang.org/en/v1/manual/performance-tips/#Write-%22type-stable%22-functions
  check_type: runtime
  implementation_hint: run JET.report_opt or parse @code_warntype output for Any and unstable unions
  anti_pattern: |
    f(x) = x > 0 ? x : 0
  correct_pattern: |
    f(x::Float64)::Float64 = x > 0 ? x : 0.0
  automated: true
  gate_severity: hard

- id: concrete-field-types
  manual_section: Avoid fields with abstract type
  url: https://docs.julialang.org/en/v1/manual/performance-tips/#Avoid-fields-with-abstract-type
  check_type: static
  implementation_hint: inspect struct fields and flag abstract supertypes in hotpath-owned structs
  anti_pattern: |
    struct BadBox
      x::Real
    end
  correct_pattern: |
    struct GoodBox{T<:Real}
      x::T
    end
  automated: true
  gate_severity: hard

- id: column-major-order
  manual_section: Access arrays in memory order, along columns
  url: https://docs.julialang.org/en/v1/manual/performance-tips/#Access-arrays-in-memory-order,-along-columns
  check_type: review
  implementation_hint: flag nested loops over matrices where row index is outer loop for column-major arrays
  anti_pattern: |
    for i in 1:size(A,1), j in 1:size(A,2)
      s += A[i, j]
    end
  correct_pattern: |
    for j in 1:size(A,2), i in 1:size(A,1)
      s += A[i, j]
    end
  automated: false
  gate_severity: hard

- id: preallocate-outputs
  manual_section: Pre-allocating outputs
  url: https://docs.julialang.org/en/v1/manual/performance-tips/#Pre-allocating-outputs
  check_type: runtime
  implementation_hint: compare allocations before and after introducing preallocated output buffers
  anti_pattern: |
    ys = [g(x) for x in xs]
  correct_pattern: |
    ys = similar(xs)
    @inbounds for i in eachindex(xs)
      ys[i] = g(xs[i])
    end
  automated: true
  gate_severity: soft

- id: avoid-abstract-containers
  manual_section: Avoid containers with abstract type parameters
  url: https://docs.julialang.org/en/v1/manual/performance-tips/#Avoid-containers-with-abstract-type-parameters
  check_type: static
  implementation_hint: detect Vector{Any}, Dict{String,Any}, Array{Real}, and similar abstract container declarations
  anti_pattern: |
    vals = Vector{Any}(undef, n)
  correct_pattern: |
    vals = Vector{Float64}(undef, n)
  automated: true
  gate_severity: hard

- id: fuse-broadcast
  manual_section: More dots, fuse vectorized operations
  url: https://docs.julialang.org/en/v1/manual/performance-tips/#More-dots:-Fuse-vectorized-operations
  check_type: runtime
  implementation_hint: benchmark split broadcast chains versus fused broadcast expression
  anti_pattern: |
    y = sin.(x)
    z = y .+ 3 .* x
  correct_pattern: |
    z = @. sin(x) + 3 * x
  automated: true
  gate_severity: soft

- id: avoid-hotloop-string-interp
  manual_section: General hot-loop allocation control (derived guardrail)
  url: https://docs.julialang.org/en/v1/manual/performance-tips/
  check_type: review
  implementation_hint: detect repeated string interpolation inside loops and suggest buffered output patterns
  anti_pattern: |
    for i in 1:n
      msg = "step=$(i) value=$(arr[i])"
      push!(logs, msg)
    end
  correct_pattern: |
    io = IOBuffer()
    for i in 1:n
      print(io, "step=", i, " value=", arr[i], '\n')
    end
  automated: false
  gate_severity: soft
```
