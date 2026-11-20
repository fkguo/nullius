# Constructing compressed numerical operators

Use this reference when a tensor, low-rank or sampled operator is cheap to apply
but expensive to prepare. It supplements the identity and benchmark gates in
the parent skill; it does not supply a universal approximation theorem.

## Locate the expensive work before choosing a representation

Measure preparation, actual expensive evaluations, interpolation/materialization,
range selection, coefficient compression, application, solve and original-problem
verification separately. Count actual evaluations, not callback requests: caches,
rejected trials and exact corrections can make these very different. Preserve
already evaluated samples when a trial is rejected. Include setup and verification
in an end-to-end comparison, and distinguish compilation from repeated execution.

Write a cost and live-array model before the next large computation. Estimate the
cost of forming a full block/row versus accumulating its factors, and of tall
factorizations versus small coordinate operations. Inspect singular spectra on
representative full-coordinate cases before assuming compressibility. A small
toy with a smaller physical coordinate space may hide the dominant cost.
Apply the existing accuracy ceiling and declared resource limits; a timeout is
incomplete evidence, not proof that an algorithm is slow. A single-call exploratory
comparison is legitimate when requested, but does not establish variability or
statistical significance. Do not silently average, repeat or select a best run.

## Keep structure through construction and application

If the producer supplies a sum of weighted factors, first ask whether those
factors can feed the range finder or coefficient fit directly. Materializing the
full row and subsequently compressing it can erase the benefit of sampling.
Sparse projections, bounded sketches and small-coordinate fits are candidates,
not automatic improvements. Repeated tall QR/SVD updates or basis rotations can
cost more than the dense path they replace. Measure those operations explicitly.

Separate provider-owned integration, geometry, singular terms and units from
generic factor accumulation, coordinate compression and application. Define
whether emitted factors add to or replace blocks; preserve exact samples and
corrections without double counting. Consume borrowed inputs synchronously.
Handle partial final groups rather than hard-coding a pilot's block alignment.
Keep an uncompressed reference available for falsification.

Where a transpose symmetry is available, check the unsymmetrized input in the
consumer's basis and distinguish ordinary from conjugate transpose. State
whether it holds for each sample or only for their sum. In the latter case
accumulate independent blocks and complete the symmetry after all partial
sums. Apply exterior weights in their original order.

For a coarse-grid interpolant, compare dense and compressed actions on the
same coarse samples, interpolation map, corrections and right-hand sides.
Check the final fine-grid action independently of the holdouts used to choose
corrections. Count distinct evaluations on both accepted and rejected panels.
If all pairs were requested, sampling saved no evaluations on that input.
Benchmark the prepared action with reused buffers and the full setup-plus-solve
before choosing a default. Retire a duplicated execution path once the
replacement covers its layouts, precision, failure behavior and downstream
outputs; keep a recoverable reference for independent comparisons.

## Fit in the norm required by the consumer

Nonorthonormal range coordinates change the physical norm. Use an orthonormal
basis or the physical Gram metric when fitting coefficients; a small coordinate
residual alone can hide a large physical defect. Reject poorly conditioned
metrics and nonfinite or unsupported scaling regimes. Do not transfer an error
theorem for one random-map distribution to another map without justification.

Keep sampling/interpolation, range truncation, coefficient compression, storage
rounding and solve errors distinct. Bound or measure their effect in the original
norm at the original tolerance. A bounded tighter coefficient refit can reuse the
same expensive factors if checkpoints show that the range itself is adequate;
it must not relax the acceptance ceiling. If the range fails, return a failure
or use an explicitly bounded, independently checked fallback.

Sketch residuals and a few checkpoints are not global certificates. Test an
adversarial component invisible to the chosen projections. Verify full original
coordinates on a declared finite problem and the downstream original equation
and outputs. Report exactly which checks were exhaustive, sampled, conditional
on the provider, or unavailable. Verification against supplied interpolants does
not validate those interpolants against their source function.

## Treat memory ownership as part of the algorithm

Allocate task-owned buffers for atoms, maps, coordinates and contraction scratch.
Reset every state field on reuse, including pending batches, counters and maps;
ensure deterministic map selection does not mutate a global RNG. Keep completed
factors independent of scratch, and inspect them after later groups and resets.
An ephemeral prepared basis may alias scratch: coefficient retries must not
overwrite it with checkpoint predictions or a later component's preparation.

Model simultaneous old/new allocations during shape changes. Distinguish retained
coefficients, total allocated bytes, live numeric scratch and peak process memory.
A lower scratch estimate does not establish a smaller result or lower RSS.
Reduce retained storage only with a measured rounding-error budget and actual
application timing; mixed precision can add conversion or backend costs.

Parallelize independent construction only after sizing private workspaces and
retained output together. Coordinate task and linear-algebra threading without
changing process-wide settings inside the library. Use memory headroom, actual
provider safety and completed-work timings to select concurrency. An ideal
stage-wise speed bound is a planning bound, not a measured speedup.

## Keep reusable guidance separate from project evidence

Put concrete operators, tolerances, fixtures, spectra and measurements in their
owning project. Keep this reference about transferable decisions and checks.
The current owner can perform diagnosis, implementation and focused verification;
this reference does not require another agent or a new orchestration layer.
Use independently framed review only when authorized and when it adds a needed
dimension of evidence. Separate models, methods and input framing when claiming
independence; a rerun of shared code is a rerun.
