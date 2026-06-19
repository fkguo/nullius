---
name: numerical-reliability-gate
description: "Convergence/reliability gate for NUMERICAL results in ANY field (fits/optimizations, integrals/quadratures, eigenvalues, roots/poles/zeros, ODE/PDE solutions, Monte-Carlo estimates — domain carried only by the caller's context). Before a computed number is folded into the durable record it must pass: (G1) discretization convergence — the value is stable as every resolution knob (grid, node count, step, contour density) is refined, and a coarse-setting optimum that evaporates at the converged setting is flagged a MIRAGE; (G2) orthogonal-method cross-check — >=2 independent methods agree; disagreement blocks the number (unresolved, not pick-one) until explained; (G3) invariant/topological validation where available — prefer a method-agnostic invariant (e.g. an argument-principle winding number, which counts zeros minus poles inside a contour) over a fixed-seed search or a magnitude threshold, which give false positives/negatives; (G4) regression anchor — the default/reference configuration reproduces a KNOWN reference result before any variation is trusted; (G5) degeneracy honesty — in flat-direction fits quote only the observables robust to the degeneracy, not individual parameters; (G6) report only converged values, with their setting recorded; (G7) method-precondition validity — any structural identity the method's validity rests on (an operator commuting with a projector/symmetrizer, Hermiticity, self-adjointness, variational-subspace invariance) holds at the PRODUCTION setting/configuration, not only the smallest/cheapest, and a value whose precondition fails there is invalid even if G1-converged. Emits an auditable reliability matrix. Sibling to `derivation-verify` (which re-derives the SYMBOLIC answer) and `julia-perf` (which gates SPEED); this one gates whether a NUMERICAL result is converged and real.\n"
---

# Numerical Reliability Gate

A reusable gate for the question *"is this computed number actually converged and real, or an
artifact of the discretization / the method / the wrong configuration?"*
It enforces the standing rule: **fold only converged, method-cross-checked numbers into the durable
record; a value that moves when you refine the resolution, or that one method finds and another does
not, is not a result yet — it is a candidate.**

This is the numerical sibling of `derivation-verify`. That skill certifies a **symbolic** answer by
re-deriving it `>=2` independent ways; this one certifies a **numerical** answer by proving it is stable
under refinement, agreed across orthogonal methods, and anchored to a known reference. Different failure
modes: a derivation is wrong because the algebra is wrong; a number is wrong because the grid was too
coarse, the continuation was unstable, the search seeded the wrong basin, or the run was built on a
superseded configuration.

## When to use

Use when a **computed number** is about to be trusted, compared, or written into a durable artifact
(a contract, a paper, a conclusion). Domain-neutral — only the caller's context carries the domain.
Example quantities (illustrative, not a fixed list):

- a fit result (a χ²/dof, a best-fit parameter, an error bar) from a nonlinear optimization,
- an integral / quadrature / phase-space sum,
- an eigenvalue, a resonance pole / root / zero, a threshold / branch point,
- an ODE/PDE solution sampled at a point, a Monte-Carlo estimate, a continuation to a new regime.

## When NOT to use (use a sibling instead)

- **Certifying a symbolic DERIVATION** (a closed form, an identity, a sign/branch choice) →
  [`derivation-verify`](../derivation-verify/SKILL.md). *Different verb:* it re-derives the answer `N`
  ways and reconciles by mathematical equivalence; this gate proves a *number* is converged and real.
- **Proving SPEED / detecting a performance regression** → [`julia-perf`](../julia-perf/SKILL.md)
  (benchmark evidence gate). Speed and reliability are orthogonal: a fast wrong number still fails here.
- **Reviewing an existing artifact** (a diff, a draft) against a contract →
  [`review-swarm`](../review-swarm/SKILL.md).
- **Surviving the long, kill-prone COMPUTE that produces the numbers** (checkpoint / heartbeat / resume)
  → [`research-harness`](../research-harness/SKILL.md) owns that. This gate runs *after* the numbers exist.

## The gate

Apply the checks that fit the quantity; a result is **reliable** only when every applicable one passes.
Each check names its own minimum disconfirming test — never accept a number because it "looks reasonable".

- **G1 — Discretization convergence (mirage check).** Vary *every* resolution/size knob independently —
  integration grid, continuation/interpolation node count, step size, contour density, sample count,
  **domain size / number of grid points / domain extent, truncation order, grid parity (even–odd)** —
  and confirm the value stops moving as you refine. Report the value **only at the converged setting**,
  with the setting recorded. **A candidate optimum found at a coarse setting that does not survive
  re-evaluation at the converged setting is a MIRAGE** — re-evaluate every coarse-grid optimum at the
  converged grid before trusting it. Convergence is a *measured* plateau (e.g. stable to a stated
  tolerance across a 2–3× range of the knob), never assumed from a single setting. For **sensitive**
  quantities also escalate floating-point precision and check the residual / backward error / condition
  number (or use interval / arbitrary-precision arithmetic) — a grid-refined value can still be wrong from
  cancellation or roundoff. For a **stochastic** estimate (Monte Carlo / sampling), "converged" is not a
  frozen value but *shrinking uncertainty*: use independent seeds/chains, an effective sample size and
  autocorrelation check, sensitivity to rare events, and report a confidence/credible interval — not a
  single point that "stopped moving".
- **G2 — Orthogonal-method cross-check.** Recompute with `>=2` genuinely independent methods (a
  different algorithm or representation: two quadratures, two rational-continuation schemes, a
  determinant search vs. a topological count). They must **agree** within a stated tolerance. **Declare each
  check's resolution** — the smallest discrepancy it could detect — and *what it cannot resolve*; an
  agreement within a tolerance **coarser** than the property/effect you are certifying is **non-diagnostic**
  (record it as "agree, but cannot resolve `<X>`"), not a pass for that property. The same applies to a G3
  invariant and a G7 precondition residual: a check whose resolution exceeds the effect it must catch is
  exploratory context, not a gate.
  Disagreement means *unresolved* — the value is **unpromotable until the discrepancy is explained**; do
  **not** silently pick one (a method may be disqualified by an independent conditioning / error analysis,
  or a single certified-interval / a-posteriori-error method may suffice without a second). Prefer a method that stays well
  conditioned as resolution grows; flag any method known to be fragile beyond a regime (e.g. a
  continued-fraction interpolation that destabilizes past `~N` nodes) and do not report its value past
  that regime without the robust method confirming it.
- **G3 — Invariant / topological validation (prefer it over heuristics).** For presence/absence and
  counting (zeros, roots, poles, eigenvalues, modes), prefer a **method-agnostic invariant** over a
  **fixed-seed search** or a **magnitude threshold**, both of which give false negatives (the feature
  moved away from the seed) and false positives (a coarse-grid floor never reaches the true zero). Such
  invariants are field-specific but ubiquitous — a Sturm sequence or Descartes' rule of signs for
  real-root counts, Gershgorin disks or matrix inertia (Sylvester's law) for how many eigenvalues lie in
  a region, a conservation law / sum rule for a total that must balance, a degree / winding / topological
  index for any count that must come out an integer. G3 is that *general* move — replace a seed/threshold
  guess with a quantity the answer cannot violate — in whatever form your problem admits; it is **not**
  tied to complex analysis. The fullest worked example below happens to be the **argument principle**
  (complex-analytic zero/pole counting), used only because it shows every moving part: for `F` meromorphic
  inside and on a positively-oriented
  simple closed contour `Γ`, with **no zero or pole on `Γ` itself**,
  `(1/2πi)∮_Γ F'/F dz = Z − P` — the number of **zeros minus poles** inside `Γ`, each with multiplicity
  (equivalently the winding number of `F(Γ)` about 0). So it counts **zeros** only when `F` is pole-free
  in the region, and counts **poles** only when applied to a denominator / reciprocal whose zeros encode
  them. Validate its preconditions before trusting the integer: meromorphicity, no near-zero/near-pole on
  the contour, the correct Riemann sheet/branch, and that the numerical `∮` rounds to an integer within a
  stated residual (not e.g. `0.97`). Treat a seed-based or threshold-based hit as a *candidate* that the
  invariant then confirms or refutes.
- **G4 — Regression anchor before any variation.** Before trusting a variation — a bug fix, a new
  cutoff/regime, a scheme swap — assert the **default / reference configuration reproduces a KNOWN
  reference result** (a published value, a prior converged anchor). Two corollaries: reproduce the
  *original* (even buggy) result before claiming a fix changes it; and if a change that *should* move a
  reference observable leaves it unchanged (or vice versa), the change is not doing what you think —
  stop. (Pairs with `research-harness` "anchor on the final adopted version".)
- **G5 — Degeneracy honesty.** In a many-parameter fit with flat directions (individual parameters
  unconstrained, the Hessian not positive-definite), do **not** quote individual parameter values or
  their covariance intervals as if determined. Quote only the **identifiable combinations / observables
  robust to the degeneracy** (e.g., in a fit, the χ², a pole position, a lineshape, a residue) and mark
  flat-direction parameters "not individually determined".
- **G6 — Report only converged values, with provenance.** Fold into the durable record only values that
  passed every applicable G1–G7 check at the converged setting, each tagged with its
  grid/node/method/contour. A coarse, intermediate, or non-converged number is **labeled as such or
  discarded** — never silently reused. Check a reused artifact's timestamp against the current code
  version before trusting it (a stale artifact from a since-fixed bug reads as current truth otherwise).
- **G7 — Method-precondition at the production setting.** When a result's validity rests on a structural
  property of the operator/method — an operator commuting with a projector or symmetrizer, Hermiticity,
  self-adjointness, idempotency, unitarity, positivity, a variational/Galerkin subspace being invariant
  under the operator — record a **disconfirming residual** of that property **evaluated at the exact
  setting/configuration that produced the recorded value**, not only where it is cheapest. A property that
  holds at the smallest/cheapest setting can break at the production setting (aliasing, grid parity, and
  periodic wrapping first appear above the minimal size), so a value can be perfectly G1-converged and
  still be meaningless because its method precondition fails there. **Corollary** for any eigenvalue /
  variational result obtained via a projected or effective operator: report the **true-operator residual**
  `‖Oψ − λψ‖ / ‖Oψ‖` (documented norm; guard a near-zero `‖Oψ‖` with a fixed reference scale) and the
  variance — not merely that ψ has the assumed symmetry; if the precondition
  residual is non-negligible the value is `precondition_violated`, labeled **invalid** (not "approximate").

## Reliable vs. fragile methods (quick reference)

| Task | Fragile (false ±) | Reliable |
|---|---|---|
| Presence/absence, counting | fixed-seed search; `|F| < ε` threshold | topological invariant (argument-principle winding) |
| Analytic continuation | a continuation unstable past `~N` nodes | a continuation well conditioned as nodes grow + cross-check |
| "It converged" | a single setting that "looks flat" | a measured plateau across a 2–3× knob range + orthogonal method |
| Best fit | one optimizer run from one start | multi-start + the converged grid (coarse-grid optima are mirages) |

The principle: a heuristic that depends on a seed, a threshold, or a single discretization is easily
fooled when the feature moves or the resolution is too coarse; a method-agnostic invariant or a measured
refinement plateau is **much harder to fool — once its preconditions and numerical-error controls are
validated**. It is not infallible: a common-mode discretization bias, roundoff/cancellation, a false
plateau, an invalid sheet or near-contour singularity, or a net zero–pole cancellation can still defeat
it, which is why G3 requires checking the invariant's preconditions and G2 requires a genuinely
*independent* second method.

## Output — the reliability matrix

Emit one auditable record per gated quantity, conforming to
[`references/contract.md`](references/contract.md): an artifact named
`numerical_reliability_matrix_v1.json` (ART-01) with, per quantity, the refinement ladder (setting →
value), the orthogonal-method values and whether they agree, any invariant check, the regression-anchor
result, a degeneracy note, the recorded converged value, and a `verdict ∈ reliable | mirage |
unconverged | method_disagreement | fragile_method | anchor_failed | degenerate | stale_artifact`
(`reliable` requires every *applicable* G1–G7 check to pass — including the G4 anchor, G6 non-staleness, and the G7 production-scale precondition,
not only G1–G3). Only `reliable` rows may be folded into the durable record; everything else is a labeled
candidate or is discarded.

## Host-aware execution (quality first)

The checks are a discipline you apply with whatever your host exposes, not a single script (G1–G3 are
inherently model/tool-specific — there is no one generic runner for "refine the grid of arbitrary
code"). Run the orthogonal methods (G2) and any independent re-computation natively where you can; for
a cross-*model* independent reproduction of a full numerical result, pair this with an independent
backend via [`review-swarm`](../review-swarm/SKILL.md). Spend your maximum reasoning on the checks that
decide a load-bearing number (a contested pole, a χ² that selects a model); a trivial anchor does not
warrant a tie-break. When the underlying compute is long and kill-prone, run it under
[`research-harness`](../research-harness/SKILL.md) (checkpoint/heartbeat/resume) and gate the *results*
here.

## Provenance

Distilled from the f1(1420) `KK̄π` three-body-unitarity reproduction. Concrete failure modes this gate
encodes, each caught the hard way:

- a phase-space grid `(8,6,6,6)` produced "optima" at χ²/dof `1.65–1.97` that evaporated to `2.4–2.6`
  at the converged grid `(24,16,16,10)` — **G1 mirage**;
- a low-node-count AAA rational continuation grew a spurious low-χ² well a fitter exploited (a reported
  `1.588` that jumped to `~2.19` once the node count was converged and a second method agreed) — **G1+G2**;
- a fixed-seed pole search reported "pole absent" when the pole had merely moved, while an
  argument-principle winding count found exactly one zero there — **G3** (fragile vs. reliable);
- the same fit's contact couplings were flat directions (Hessian non-convergent) while χ² and the poles
  were stable to `<2 MeV` across the valley — **G5**;
- work was twice built on a **superseded** configuration (an earlier χ²≈2.19 fit instead of the adopted
  χ²≈1.9 one; a deprecated continuation method instead of the adopted one) before a regression anchor
  would have caught it — **G4** (and `research-harness` "anchor on the final adopted version").
