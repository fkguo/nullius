# Example benchmark suite for julia-perf.
#
# Contract:
# - Define JULIA_PERF_BENCHMARKS as a vector of name => zero-arg function pairs
#   OR define julia_perf_benchmarks() returning the same shape.

const JULIA_PERF_BENCHMARKS = [
    "scalar-loop" => (() -> begin
        s = 0.0
        @inbounds for i in 1:10_000
            s += i
        end
        s
    end),
    "broadcast-kernel" => (() -> begin
        x = rand(256)
        y = @. sin(x) + 3 * x
        sum(y)
    end),
]

