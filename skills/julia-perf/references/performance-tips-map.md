# Julia performance decision map

Primary reference: [Julia Performance Tips](https://docs.julialang.org/en/v1/manual/performance-tips/).
Check the actual input, representation and call chain; a text pattern is a lead,
not a diagnosis. The bundled runner measures supplied workloads: it does not
execute JET, inspect these patterns, or verify numerical equivalence automatically.

| Decision | Evidence to obtain | Avoid automatic prescriptions |
|---|---|---|
| Algorithm and output size | Profile the operation; identify the outputs actually consumed. | Do not compute all eigenvectors, sort all inputs or refactor for each RHS when only a subset/reused factor is needed. |
| Global state | Inspect mutable globals used by the hot call chain. | A constant binding and a harmless setup variable are not the same as an untyped changing global. |
| Dispatch and storage | Analyze representative concrete calls with JET/`@inferred`; inspect function barriers. | Abstract public arguments specialize; `struct Box{T}; x::T; end` can preserve storage type. Do not force `Float64` for a generic API. |
| Compiled hot loop | Inspect optimized typed IR and LLVM for the measured specialization. Locate loop-invariant math, dispatch and conversions relative to the loop back edge. See [compiler-hotpaths.md](compiler-hotpaths.md). | A type-stable or allocation-free call can still execute redundant scalar work. |
| Allocation | Measure actual Trial allocation count and bytes after compilation. | Zero allocation is a task budget when required, not a universal correctness criterion. |
| Layout | Inspect strides/storage and benchmark representative traversal. | Column-major order is a dense Array default, not a rule for every AbstractArray. |
| Broadcast | Compare fused and selectively materialized forms. | Recomputing an expensive axis-invariant intermediate can make maximal fusion slower. |
| Views versus copies | Include reuse count and noncontiguous access costs. | A copy may improve locality enough to repay allocation; a view is not always faster. |
| Static size | Measure runtime plus specialization/compilation cost on intended sizes. | StaticArrays suit small fixed dimensions; no universal element-count cutoff. |
| Bounds and aliasing | Check indices/axes and documented alias cases; run with bounds checks enabled. | `@inbounds` cannot repair an invalid array contract. |
| SIMD/fast math | Compare the mathematical operation and error budget, including exceptional inputs. | Reassociation and `@fastmath` can change NaN/Inf, signed-zero and rounding semantics. |
| Threads and BLAS | Record task ownership and both Julia/BLAS threads. | Nested thread pools can oversubscribe; thread IDs do not own migratable task buffers. |
| Execution latency | Measure fresh-process load/first call separately from warm calls. | A warm benchmark does not establish faster import/precompilation. |
| Specialization strategy | Record the effective strategy and callable/type diversity; compare cold total cost and warm throughput. | Do not force full specialization or encode high-cardinality runtime values in types without evidence. |
| Reusable state | Compare the documented reset with fresh state after relevant prior exits. | Overwriting the input array alone may leave history, callbacks, schedules or status behind. |
| Output and adapter work | Match requested outputs, lazy materialization, event semantics and effective backend. | Less saving or returning an unconsumed lazy object can change the workload rather than accelerate the same task. |
| Device/task completion | Inspect the backend, wait for the claimed work, and include required transfer/materialization. | Host enqueue time and successful CPU execution do not establish accelerator throughput or correctness. |
| Generated and transformed code | Check domain, purity, branch behavior, complete writes and semantic input/output maps. | Algebraic cancellation or CSE need not preserve singular domains, side effects or lazy branches. |
| Sparse reuse | Identify RHS/value/pattern changes and measure actual rebuild work. | Equal dimensions/nonzero count do not establish pattern identity; in-place mutation may bypass cache notification. |
| Task granularity | Include scheduling, placement, useful parallel work and final retrieval. | More tasks and copied fixed cutoffs are not evidence of better throughput. |

For supported types, aliasing, cache invalidation and concurrency contracts, read
[julia-package](../../julia-package/SKILL.md). For result-bearing numerical
acceptance, use [numerical-reliability-gate](../../numerical-reliability-gate/SKILL.md).
Performance findings block when they violate correctness, an agreed resource
budget or a measured regression, not because a regex found a stylistic pattern.
