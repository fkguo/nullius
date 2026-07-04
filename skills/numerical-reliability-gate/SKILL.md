---
name: numerical-reliability-gate
description: "Convergence and reliability gate for NUMERICAL results in any field, including fits, optimizations, integrals, eigenvalues, roots, poles, zeros, ODE/PDE solutions, Monte-Carlo estimates, and downstream feature extraction. Use before trusting, comparing, publishing, or folding a computed number into durable research artifacts. Requires resolution convergence, independent-method checks, regression anchors, method-precondition checks, configuration-threading audits, gate-discrimination (negative-control) audits of purpose-built validation chains, accelerated/heuristic fast-path scoping (no false guarantee, unconditional escape hatch, production-validated precondition), and honest uncertainty/reporting. Emits an auditable reliability matrix. Sibling to derivation-verify for symbolic claims and julia-perf for speed claims."
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
- an integral / quadrature / high-dimensional sum,
- an eigenvalue, a pole / root / zero, a threshold / branch point,
- an ODE/PDE solution sampled at a point, a Monte-Carlo estimate, a continuation to a new regime.

## When NOT to use (use a sibling instead)

- **Certifying a symbolic DERIVATION** (a closed form, an identity, a sign/branch choice) →
  [`derivation-verify`](../derivation-verify/SKILL.md). *Different verb:* it re-derives the answer `N`
  ways and reconciles by mathematical equivalence; this gate proves a *number* is converged and real.
- **Proving SPEED / detecting a performance regression** → [`julia-perf`](../julia-perf/SKILL.md)
  (benchmark evidence gate). Speed and reliability are orthogonal in BOTH directions: a fast wrong number
  still fails here, and — the easy trap — a CORRECT-but-wasteful number PASSES every check here (this gate
  does not surface performance waste: a value can be right and still computed orders of magnitude more
  expensively than needed, e.g. the whole result formed when only a part was used). So treat efficiency as
  a first-class deliverable gated by `julia-perf`, not an afterthought bolted on once the number is
  "reliable" — a green reliability matrix says nothing about whether the computation was efficient.
- **Reviewing an existing artifact** (a diff, a draft) against a contract →
  [`review-swarm`](../review-swarm/SKILL.md).
- **Surviving the long, kill-prone COMPUTE that produces the numbers** (checkpoint / heartbeat / resume)
  → [`research-harness`](../research-harness/SKILL.md) owns that. This gate runs *after* the numbers exist.
- **Verifying the TOOL/ENV itself runs and its docs match reality** → the three-layer readiness
  validation (import → seeded witness → agent-follows-doc) under Long-Running Compute Jobs in
  [`research-harness`](../research-harness/SKILL.md); this gate then certifies the numbers it produces.

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
  **Independence is structural, not nominal.** A second computation counts as a cross-check only when it
  evaluates the *same* quantity under the *same* model by a genuinely different route. A solver/engine that
  implements a structurally *different* model (a different governing relation, a different approximation, a
  different set of modeling assumptions), or a check that holds only in a degenerate / limiting regime, is a
  **different-scientific-model (or limit-regime) comparison, not an apples-to-apples cross-check** — record its outcome
  labeled as such, never as a G2 pass. When *no* apples-to-apples independent method is reachable, record
  that **absence as an explicit stated limitation**: do not let an established cross-check pattern silently
  lapse, and do not let a different-scientific-model or limit-regime check stand in for the missing one (an
  unrecorded lapse reads as "cross-checked" when nothing comparable was ever run).
  **Which LLM/engine runs a method is not the cross-check axis — the *route* is.** `>=2` orthogonal methods
  run by ONE LLM is a valid G2 floor (parallelize them across same-model subagents if useful, one method
  each — the independence lives in the method, never in the agent label), so a single-LLM host is never
  blocked here; two subagents (or two LLMs) running the *same* algorithm are one check, not two. A
  **cross-LLM (different model-family)** independent re-implementation is the *ceiling* — it additionally
  decorrelates the coding-style, transcription, and library error two methods inside ONE LLM can still share —
  reached for a load-bearing number when a second LLM family is available, its absence recorded as a stated
  limitation, not a blocker. **"Different model" here always means a different LLM/engine, never a different
  scientific model:** recomputing under a different governing relation/approximation is a new scientific
  question, out of this gate's scope — G2 verifies a result WITHIN its fixed scientific model (same model,
  different route, per the structural-independence rule above).
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
  passed every applicable G1–G8 check at the converged setting, each tagged with its
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
- **G8 — Reference-number reproduction (a claimed match is computed, not asserted).** When a result is
  reported as *reproducing / matching / agreeing with* a **published reference value**, the gate is to
  **compute the claimed observable on a comparable state / regime / configuration and compare to the
  published number numerically** — not to assert a qualitative "same order of magnitude / same sign"
  agreement, and not to cite the source as if citing it established the match. Reproduce on the same
  regime the reference used (or the nearest reachable one, recorded as such, with the gap to the
  reference's regime stated); where the claim is term-by-term, compare term by term, since a net total
  can agree while individual contributions are suppressed or sign-flipped. **An order-of-magnitude
  same-direction discrepancy, or a sign reversal, between the computed value and the published one is a
  finding (`reference_mismatch`), not a pass** — a magnitude or sign gap is exactly what a qualitative
  "in scale" match conceals. Record the published value with its source locator, the computed value on
  the comparable regime, and the ratio / signed difference. (Distinct from **G4**: G4 anchors your *own
  pipeline* on a known result before you trust a variation; G8 tests whether a *headline external-match
  claim* actually holds when the observable is recomputed on the comparable state — a result can pass
  G1–G7 and still misstate how it relates to the literature.) The **strongest execution form** of this
  gate is the opt-in independent reproduction check in
  [`research-harness`](../research-harness/SKILL.md): it reruns the project's declared reproduction
  entry in a fresh, isolated checkout of committed state and machine-compares each declared expected
  value under an explicit absolute/relative tolerance, default-deny. It is adopted per project and
  changes no default workflow.

- **G9 — Gate discrimination: a validation must be able to fail (independent reference, negative
  controls).** When a value's trust rests on a purpose-built consistency check — "it reduces to a
  known object", "it matches the reference implementation", "it was validated N-way" — audit the
  gate itself before crediting the pass. Four requirements:
  **(i) Reference independence.** The reference the gate compares against must have been derived
  independently of the assumption under test. A reference that was reverse-engineered to reproduce
  the object it now validates, or that was built under the same structural assumption (the same
  operator/numerator form, the same approximation, the same convention), makes the gate a tautology
  — A-against-A: it can pass indefinitely while the shared assumption is wrong. (The sharpest form
  of G2's "co-invocation is not independence", lifted from shared *code* to shared *assumptions*.)
  **(ii) Disputed structure left in.** The comparison must run in a mode that retains the degree of
  freedom in dispute. A stripped/simplified comparison limit in which all competing hypotheses
  collapse to the same object (a limit that projects out the disputed operator / structure / term
  before comparing) is structurally non-discriminating regardless of how precisely it agrees —
  record such a check as skeleton-only, never as a validation of the disputed structure. (The
  structural analogue of G2's non-diagnostic tolerance: there the check is too *coarse* to see the
  effect; here it is *blind* to it by construction.)
  **(iii) Negative controls.** Demonstrate — never assume — that the gate rejects the known-wrong
  alternatives: run the gate on each rejected/competing variant and record its failure margin. A
  gate that has never rejected anything is unproven; the pass of the adopted variant is meaningful
  exactly in proportion to how loudly the wrong variants fail. As a bonus, the failure *pattern* of
  the negative controls localizes errors that symbolic review cannot.
  **(iv) Production path, and no validation transfer.** The gate must run on (or directly against)
  the code path and configuration that actually produce the recorded value — validating a
  sibling/reference implementation that the production path never invokes validates nothing about
  the production path (the path-level analogue of G7's production-*setting* rule). And a validation
  certifies only the quantity/layer it actually compared (e.g. the denominator/singularity skeleton
  of an integral, not its numerator/operator structure): annotate every "validated" claim with the
  layer it covers, and never let it transfer to an orthogonal layer.

- **G10 — Accelerated / heuristic fast path: scope the guarantee, keep the unconditional escape hatch.**
  When a fast path is a **heuristic** whose *local* success certificate does not entail the *global*
  answer — the archetype is a fixed-start Krylov/subspace iteration (e.g. a restarted Arnoldi) for a
  dominant eigenvalue/quantity, where a small residual certifies *an* eigenpair (a local optimum),
  **not** that it is the dominant one, so a target mode nearly orthogonal to the deterministic start is
  silently missed — its output is correct only under a **precondition**, and the gate is to make that
  precondition explicit, validated, and escapable, never to assert a correctness the method does not
  carry. Five obligations, each with its disconfirming test:
  **(i) No false guarantee.** Do **not** write into a docstring / comment / README a guarantee the method
  does not deliver ("never returns a wrong value", "always finds the dominant mode"). Overclaiming the
  method's scope is a **scientific-integrity defect in its own right — even if the wrong output never
  arises in the actual production use** — because the claim is false as written and a later caller will
  lean on it in a regime where it fails. *Test:* try to construct one input that breaks the stated
  guarantee; for a fixed-start heuristic you almost always can, which proves the guarantee false and
  forces it to be narrowed to the precondition under which it actually holds.
  **(ii) Document the precondition and its failure mode.** State the condition under which the fast path
  is correct (the sought mode has nonzero, bounded-below overlap with the start; the search begins in the
  correct basin) **and** the blind spot when it is violated — that it can return a *wrong* value, and how
  a defeating input is constructed (a target eigenvector orthogonal to every deterministic start). A
  precondition recorded without its failure mode is half the truth. *Test:* grep the docstring / comment /
  README (and the reliability-matrix note) for BOTH the precondition and the constructed failure mode;
  either absent → fail.
  **(iii) Keep the unconditional path, auto-selected where cheap.** Retain the slow-but-provably-correct
  routine (a dense/direct solve, an exhaustive enumeration) and route to it automatically wherever it is
  affordable — e.g. below a size threshold — so the heuristic runs only where the exact path is genuinely
  too expensive. A fast path with no unconditional fallback is a single point of silent failure. *Test:*
  confirm the unconditional routine exists in the code and is actually selected below the stated size/cost
  threshold; if none exists, or the heuristic runs unconditionally, → fail.
  **(iv) Validate — do not assert — the precondition at (or as near as feasible to) the production
  setting.** Prove or empirically demonstrate that the *actual* operator/input meets the precondition. If
  the unconditional path is affordable at the production value, run the fast-path ≡ unconditional-path
  cross-check *there*, to a stated tolerance (and if it is cheap enough, obligation (iii) already routes
  you to the exact value directly). If the unconditional path is infeasible at production scale, the
  load-bearing evidence is a **structural argument** that the precondition holds for the real operator at
  production scale (e.g. a positivity / Perron-type structure forcing the dominant mode to keep a
  bounded-below overlap with the start) **plus, as corroboration only**, a fast ≡ exact cross-check on **at
  least one — ideally the largest — affordable case in the production regime**, with the extrapolation gap
  to the true production scale recorded — a smaller-scale cross-check never substitutes for the
  production-scale structural argument, and a structural argument with *zero* affordable cross-check
  available is **uncorroborated** — record that absence explicitly rather than treat the structural
  argument as numerically confirmed. "It surely holds
  here" is exactly the gap this closes — this is G2's independent cross-check and G7's production-setting
  rule applied to the fast/exact split: validate where the value is produced, or as near as feasible with
  the gap stated, never only where it is cheapest.
  **(v) An adversarial counterexample tests the CLAIM, not the use — answer with honest scoping.** A
  reviewer who constructs an input that breaks the fast path but **never arises in the production use** is
  refuting the *stated guarantee* (i), not the *production result* (iv). The correct response is (i)–(iv)
  — narrow the claim, document the blind spot, keep the escape hatch, validate the real use — **not** (a)
  rewording to fake a guarantee, (b) tuning a seed/parameter to hide that one case, nor (c) chasing an
  impossible cheap *universal* guarantee (e.g. reimplementing a heavy general-purpose library to defend
  against an adversarial-only input). *Test:* inspect the change made in response to the counterexample
  and confirm it (1) **narrowed the public/stated guarantee** rather than reworded it to still overclaim,
  (2) did **not** merely tune a seed/parameter so that one case passes while the blind spot survives, and
  (3) left the unconditional escape hatch and the production-precondition evidence intact — a response
  that fails any of these has *hidden* the defect, not scoped it. Where a **fundamental limit** exists,
  state it: e.g. no fixed-start Krylov/subspace method certifies global dominance (the genuine limit), so a
  global guarantee requires a whole-operator routine — canonically a full dense eigensolve, or another
  globally certified path (a dense/direct solve, an exhaustive enumeration, a certified enclosure) — and
  the honest artifact is "heuristic + validated precondition + exact escape hatch", not a universal
  guarantee that cannot exist.
  **Complements G3, does not repeat it:** where replacing the heuristic with a method-agnostic
  invariant / robust method is affordable, G3 says prefer it; **G10 governs the case where the heuristic
  is deliberately kept as a performance-motivated fast path** and must be scoped honestly rather than
  papered over. Verdict `overclaimed_heuristic` when a fast/accelerated path is folded in as if
  unconditional while its stated guarantee claims correctness beyond the validated precondition, its
  failure mode / unconditional escape hatch is absent, or its **fast-vs-exact agreement precondition** (start-overlap /
  basin membership) was asserted rather than validated at the production setting. **Precedence vs G7:** a
  structural property that makes the *method itself* valid (commutation with a projector/symmetrizer,
  Hermiticity, …) failing is `precondition_violated` (G7); the *fast-vs-exact agreement* precondition
  failing, or a guarantee / escape-hatch defect, is `overclaimed_heuristic` (G10) — there the exact method
  stays valid and only its acceleration is in doubt.

## Reliable vs. fragile methods (quick reference)

| Task | Fragile (false ±) | Reliable |
|---|---|---|
| Presence/absence, counting | fixed-seed search; `|F| < ε` threshold | topological invariant (argument-principle winding) |
| Analytic continuation | a continuation unstable past `~N` nodes | a continuation well conditioned as nodes grow + cross-check |
| "It converged" | a single setting that "looks flat" | a measured plateau across a 2–3× knob range + orthogonal method |
| Best fit | one optimizer run from one start | multi-start + the converged grid (coarse-grid optima are mirages) |
| Dominant eigenvalue/quantity (fast path) | a fixed-start Krylov/subspace iteration sold as a "never wrong" guarantee | the same heuristic scoped to its overlap precondition + an unconditional dense solve as escape hatch (validated ≡ at production scale) |

The principle: a heuristic that depends on a seed, a threshold, or a single discretization is easily
fooled when the feature moves or the resolution is too coarse; a method-agnostic invariant or a measured
refinement plateau is **much harder to fool — once its preconditions and numerical-error controls are
validated**. It is not infallible: a common-mode discretization bias, roundoff/cancellation, a false
plateau, an invalid sheet or near-contour singularity, or a net zero–pole cancellation can still defeat
it, which is why G3 requires checking the invariant's preconditions and G2 requires a genuinely
*independent* second method. And when such a heuristic is nonetheless *kept* — because it is the
performance-motivated fast path and the robust method is too expensive to run everywhere — G10 governs
how to keep it honestly: scope the guarantee to its precondition, document the blind spot, validate the
precondition at production scale, and keep the unconditional path as an auto-selected escape hatch,
rather than paper the blind spot over with a guarantee the method cannot deliver.

## Output — the reliability matrix

Emit one auditable record per gated quantity, conforming to
[`references/contract.md`](references/contract.md): an artifact named
`numerical_reliability_matrix_v1.json` (ART-01) with, per quantity, the refinement ladder (setting →
value), the orthogonal-method values and whether they agree, any invariant check, the regression-anchor
result, a degeneracy note, the recorded converged value, and a `verdict ∈ reliable | mirage |
unconverged | method_disagreement | fragile_method | anchor_failed | degenerate | stale_artifact |
precondition_violated | reference_mismatch | circular_validation | overclaimed_heuristic`
(`reliable` requires every *applicable* G1–G10 check to pass — including the G4 anchor, G6 non-staleness, the G7 production-scale precondition, the G8 reference-match when a published-value match is claimed, the G9 gate-discrimination audit when trust rests on a purpose-built validation chain, and the G10 fast-path scoping when the value comes from an accelerated/heuristic path,
not only G1–G3). Only `reliable` rows may be folded into the durable record; everything else is a labeled
candidate or is discarded.

## Host-aware execution (quality first)

The checks are a discipline you apply with whatever your host exposes, not a single script (G1–G3 are
inherently model/tool-specific — there is no one generic runner for "refine the grid of arbitrary
code"). Run the orthogonal methods (G2) and any independent re-computation natively where you can; for
a cross-*model* independent reproduction of a full numerical result, pair this with an independent
backend via [`review-swarm`](../review-swarm/SKILL.md). Spend your *maximum* reasoning — and scale the *number* of independent cross-checks — with stakes: a routine
anchor needs the `>=2`-method floor; a load-bearing number (a contested pole, a χ² that selects a model)
warrants more orthogonal methods and — when a second LLM family exists — the cross-LLM re-implementation
ceiling, while a trivial anchor warrants neither a tie-break nor a second engine. When the underlying compute is long and kill-prone, run it under
[`research-harness`](../research-harness/SKILL.md) (checkpoint/heartbeat/resume) and gate the *results*
here.

## Provenance

Distilled from a real reproduction of a projected/variational multi-channel spectral analysis (a
multi-parameter fit with analytic continuation to complex poles/eigenvalues; domain carried only by the
caller's context). Concrete failure modes this gate encodes, each caught the hard way:

- a multidimensional integration grid `(8,6,6,6)` produced "optima" at χ²/dof `1.65–1.97` that evaporated
  to `2.4–2.6` at the converged grid `(24,16,16,10)` — **G1 mirage**;
- a low-node-count AAA rational continuation grew a spurious low-χ² well a fitter exploited (a reported
  `1.588` that jumped to `~2.19` once the node count was converged and a second method agreed) — **G1+G2**;
- a fixed-seed pole search reported "pole absent" when the pole had merely moved, while an
  argument-principle winding count found exactly one zero there — **G3** (fragile vs. reliable);
- the same fit's near-unconstrained couplings were flat directions (Hessian non-convergent) while χ² and
  the pole positions were stable across the valley — **G5**;
- work was twice built on a **superseded** configuration (an earlier χ²≈2.19 fit instead of the adopted
  χ²≈1.9 one; a deprecated continuation method instead of the adopted one) before a regression anchor
  would have caught it — **G4** (and `research-harness` "anchor on the final adopted version").

Further failure modes from a second reproduction (a composite kernel assembled from several parts,
feeding a downstream feature extraction — a root / mode / peak located by fitting or continuation; domain
carried only by the caller's context), each a way an agreement-based check gave false confidence:

- a composite term assembled by a **positional shortcut** (grouping its factors by their *slot* — which
  position they occupy — rather than by their *actual role*) was **bit-identically correct for the
  symmetric/dominant components**, where the shortcut coincides with the role-correct assignment, and wrong
  only for the single asymmetric, least-exercised component; two re-implementations that both inherited the
  shortcut agreed to machine precision and "passed". **G2/G7** — a structure verified only on the
  symmetric/dominant cases is unverified: exercise the case whose roles *differ* from the shortcut's
  assumption, and test the *premise* (the assembled term equals its first-principles form) directly per
  component, not via cross-implementation numerical agreement;
- a **"bit-identical" cross-implementation (even cross-model) agreement** proved only that both invoked the
  same code/idea, not that the idea was correct; the error surfaced only when a re-derivation was
  **forbidden to inherit the suspect kernel** and rebuilt the component from first principles, after which
  the discrepancy was *traced* (not voted) to the exact structural step. **G2** — for a load-bearing
  structure require a from-scratch re-derivation barred from inheriting it; kernel-sharing agreement (and
  bit-identical agreement most of all) is co-invocation, not independence;
- an independent-verifier brief that **stated the expected answer/structure** produced conformity; the same
  verifiers re-dispatched **blind** (given only the claim and the code — no answer, no suspected mechanism,
  no analysis window) independently recovered the result, its mechanism, and its root cause. **G2** — blind
  the dispatch (withhold the expected value, the suspected mechanism, and the window); an anchored agreement
  can be a shared error rubber-stamped;
- a **configuration knob** (a cutoff / resolution) was not threaded into a sub-stage, which **silently fell
  back to its own default**, so the value was G1-converged but computed at the *wrong configuration* with no
  error raised — caught only by tracing a few-percent gap to a reference. **G6/G7** — thread configuration
  explicitly and assert end-to-end that the requested setting actually reaches every stage; a silent default
  is a converged-but-wrong trap;
- a feature's width/strength was **extracted from a window/region that did not contain the feature's
  peak/root**, so shoulder/background data fed the extractor and several methods produced a wide,
  method-dependent spread later reported as a genuine width; **locating the feature first** (and bracketing
  it) collapsed the spread onto the true value. **G1/G3** — locate the feature before extracting from it and
  confirm the window brackets it; a method-spread on mis-located data is an artifact, not an uncertainty;
- a spread of extraction methods **targeting one observable was relabeled as a different observable** that
  was never measured directly (the directly-computed second observable lay far from the relabeled number).
  **G8** — report an extraction under the observable it actually targets; never relabel the method-spread of
  an extraction for one quantity as the value of another.

Further failure modes from a third reproduction (a loop-integral source amplitude whose
operator-valued numerator was disputed between competing structural hypotheses; domain carried only
by the caller's context) — the episode that created **G9**:

- the adopted numerator had been "validated" by a **reduce-to-a-known-object gate whose reference was
  later *measured* to be exactly the assumed-form object** (the reference had been reverse-engineered
  under the same structural assumption), and the gate's comparison limit additionally **collapsed every
  competing numerator to the same scalar** before comparing — the gate passed at the sub-percent level
  throughout while **three independent structural errors** persisted in the production path. **G9(i)+(ii)**
  — a co-derived reference plus a stripped comparison mode is a tautology, not a test; the pass carried
  zero information about the disputed structure;
- an N-way, ~1e-5-level external-library validation of the **scalar skeleton** of the same integral was
  repeatedly cited as support for the **numerator/operator layer it never touched**, and the audited
  implementation was a **sibling reference path the production engine never invoked**. **G9(iv)** —
  validation transfers neither across layers nor across code paths; annotate what each validation covers;
- the replacement gate (an independent external-library evaluation of the **full object with the disputed
  structure left in**, at the production configuration) **rejected both known-wrong variants at O(1)
  margins**, confirmed the corrected structure at the expected truncation floor, and *additionally
  surfaced a third, unsuspected defect* (a dropped frame/recoil term in an internal kinematic variable)
  that several independent symbolic derivations and cross-model reviews had all missed. **G9(iii)** —
  negative controls both prove the gate's discriminating power and, through their failure pattern,
  localize errors that symbolic review alone does not reach.

Further failure modes from a fourth reproduction (a hand-rolled iterative accelerator for a dominant
eigenvalue/quantity inside a larger solver — its fast path a fixed-start subspace iteration; domain
carried only by the caller's context) — the episode that created **G10**:

- the accelerator's docstring **claimed it "never returns a wrong value"**, an unconditional guarantee a
  fixed-start Krylov/subspace method cannot deliver; an adversarial reviewer built a small operator —
  its dimension just above the number of deterministic starts — whose dominant eigenvector was
  orthogonal to *every* start, so the fast path silently returned a sub-dominant value, refuting the
  *stated guarantee* even though that input never arises in the production use. **G10(i)+(v)** — the false guarantee was itself the defect (the wrong
  output never surfaced in production), and the reviewer's counterexample was testing the *claim*, not
  the *use*: the fix owed was honest scoping, not a reworded guarantee nor a parameter tweak to hide the
  case;
- it was resolved exactly as (i)–(iv) prescribe: the false claim was **removed**, the fast path
  **documented as a heuristic with an explicit "orthogonal-to-every-start" blind spot**, the
  **unconditional dense solve kept as an escape hatch** (auto-selected below a size threshold), and the
  production precondition — that the *real* (positivity / Perron-structured) operator's dominant mode
  keeps a bounded-below overlap with the start — **validated to ~1e-14** by a fast-path ≡ dense-path
  cross-check at production scale. **G10(ii)–(iv)** — since no fixed-start method certifies global
  dominance universally, the honest deliverable is "heuristic + validated precondition + exact escape
  hatch", never a universal guarantee that cannot exist.
