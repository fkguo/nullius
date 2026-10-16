# Numerical reliability gate — provenance

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
- a connected curve was assembled from checkpoints produced by several runs that agreed on the visible
  headline grid settings but lacked a shared full evaluator fingerprint. One plotted component remained
  smooth while a more sensitive component developed kinks. **G6** — compare a canonical per-point
  evaluator fingerprint before joining rows, fail on missing or mixed fingerprints, and recompute the
  whole connected series under one fingerprint rather than smoothing or selectively replacing points;
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

Further failure modes from a fifth reproduction (a computed field evaluated over a two-dimensional domain
by a resolution-controlled evaluator, rendered as a landscape and feeding an already-accepted results
table; domain carried only by the caller's context):

- the rendered landscape looked smooth, and carried isolated neighbour-to-neighbour jumps of ~1.5 decades
  whose location drifted with one coordinate, while the field was smooth to ~0.01 everywhere else —
  including across its genuinely declared singularities. The mechanism was a **discrete acceptance
  threshold inside the evaluator** that toggled the size of the working problem as the threshold was
  crossed; the defect had already propagated into an accepted results table, where it reversed the verdict
  the table was built to deliver (restored once fixed). **G1/G6** — a mechanical neighbour-difference scan
  of the rendered field found in one pass what visual inspection had certified as smooth, which is why that
  scan is a pre-delivery obligation in `figure-hygiene` (*rendered-field continuity*) rather than an
  eyeball check;
- after that evaluator was fixed, rows computed with the broken path **stayed in the delivered table under
  a status caveat**, and figures rendered with the broken path were still presented as delivered. **G6** —
  a correction upstream obliges *recomputation* downstream, not relabelling; the corrected verdict only
  reappeared once the affected rows were actually recomputed, and the record had to say which rows those
  were;
- a convergence ladder silently **ran one setting twice** — the knob never reached the stage that consumed
  it — and the anomalously bit-identical values were the only thing that exposed it; read as a plateau, the
  ladder would have certified an arbitrary resolution as converged. **G1** — a ladder proves nothing until
  the knob is shown to have changed what was computed;
- a cross-check run through a genuinely different implementation shared the **same under-resolved value of
  the very knob whose adequacy was in question**, so its agreement confirmed nothing about the setting under
  suspicion. **G2** — independence has to hold in the suspect setting, not only in the implementation.
