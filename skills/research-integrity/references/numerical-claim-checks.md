# Research integrity: checks on numerical claims

## Reference-reproduction fidelity (a "matches a published value" claim is computed, not asserted)

A result reported as **reproducing / matching / agreeing with** a published reference
value is making a **quantitative** claim, not a citation: the deliverable is the
agreement itself. Three distinct verification dimensions fail silently here even after a
multi-round correctness / methodology / honesty gate has passed — because that gate
checks whether the implementation matches the derived **form**, not whether the result's
**number** matches the literature number it claims, nor whether the model being solved
**is** the source's model:

- **D1 — quantitative reproduction of the reference number.** The failure mode is a
  match asserted only *qualitatively* — "same order of magnitude", "same sign", "of the
  right scale" — while the claimed observable was **never computed on a comparable state /
  regime / configuration and compared to the published value numerically**. *Minimum
  disconfirming check:* compute the claimed observable on the comparable regime the
  reference used (or the nearest reachable one, recorded as such) and compare numbers;
  where the claim is term-level, compare **term by term**, since a net total can agree
  while individual contributions are suppressed or sign-flipped. **An order-of-magnitude
  same-direction discrepancy, or a sign reversal, is a finding — not a pass.** A "matches
  in scale" claim with no computed comparison is ungrounded; treat it as an undisclosed
  gap, not a confirmation.
- **D2 — independent cross-check that did not silently lapse.** The failure mode is an
  established independent cross-validation pattern **silently lapsing**, or a
  structurally **different-model** engine / a degenerate-or-limit regime being **presented
  as validation**. *Minimum disconfirming check:* confirm any cross-validation evaluates
  the *same* model with an independently constructed and executed check; if the only reachable alternative engine
  implements a structurally different model (or the check holds only in a limit), **label
  it as a different-model / limit-regime comparison and record the absence of an
  apples-to-apples check as an explicit stated limitation** — never let the prior
  cross-check pattern quietly disappear and never let the different-model check stand in
  for it. Independent confirmation requires at least two evidence lanes independently constructed or derived and executed from a neutral question and raw inputs. Record method diversity, model-family diversity, execution independence and input independence separately. Same or similar methods, the same algorithm name, matching hashes or shared legitimate libraries do not by themselves disqualify a lane. Agent names, seeds, reworded prompts, copied answers and simple reruns of the original implementation do not establish independence. Different methods with contaminated input framing still fail. A fresh assessor must substantively inspect the actual steps, method preconditions, known defects and diagnostic power with exact source spans and reasons; a self-filled no-defect checkbox is insufficient. Missing, rejected, stale or non-diagnostic evidence does not count. Keep an explicit project-specific different-method risk requirement when that requirement tests a known shared failure mode.

- **D3 — model-transcription identity (the declared model IS the source's model).** The
  failure mode is reading internal verification as external fidelity: the convergence
  ladder, independent discretizations, and regression anchors certify only that the
  implementation solves its *declared* model correctly — every internal route shares the
  model definition, so none of them can see a mistranscribed element. D3 binds exactly
  the claims that assert the source's *own prescription* was solved or reproduced; a
  comparison that does not assert the source's prescription — against a structurally
  different model (D2's different-model labeling), or against measured/experimental
  data, which is a measurement comparison rather than a model reproduction — is not a
  D3 failure. *Minimum disconfirming check:* for each such claim, produce an exact
  element-level embedding of the source's prescription into the current framework (a
  frame map) with an elementwise identity test over the transcription, plus an
  as-printed run of the source's exact prescription used as a falsification
  instrument — the source's numbers are candidates to test against, never input
  truths to calibrate to. When the source prints no
  complete prescription, record the as-printed run as unavailable — a stated
  limitation, never a silent skip. (The note-layer counterpart is the *Extraction /
  transcription fidelity* checklist above; D3 gates the *implemented* model — a clean
  source-note does not certify the implementation.)

This is **not a new receipt mode.** It is a cross-cutting check that **augments M3** (the
cited / compared number) and **M5b** (when the result's own validity *is* the claimed
match) — and, for D3, **M6** (the model actually solved is not the one the reproduction
narrative describes); record it under those modes so the machine receipt set stays within
`M1`–`M7`, with no new mode introduced.

**Tools that help.** `numerical-reliability-gate` **G8** is the active gate — compute the
claimed observable on the comparable regime and compare, with an order-of-magnitude or
sign discrepancy returning `reference_mismatch`; its **G2** carries the D2
structural-independence honesty (a different-model or limit-regime check is labeled as
such or its absence recorded, never a cross-check pass) and the D3 transcription axis
(the shared-model-definition clause: frame map, elementwise transcription identity,
as-printed falsification run). `claim-grounding` routes a
"reproduces / matches a published value" claim to that computation rather than grounding
it by quoting the published number. `review-swarm`'s **reference-reproduction reviewer**
is the role that recomputes the claimed observable on the comparable state instead of
statically reading the assertion.

## Post-correction impact accounting (every affected cell measured, never argued from position)

After an upstream defect is found and fixed, the durable record owes a **defect impact
map**: an enumeration of every downstream artifact — quoted numbers, table rows,
figures, stored grids — whose inputs intersect the affected domain, with each cell's
status **measured** as immune (an exact identity), bounded (a deviation measured, and
small against its use's stated tolerance), or superseded (recomputed). Two failure
shapes pass silently:

- **(a) position-argued negligibility** — a cell declared negligible from its
  *position* in the domain ("the defect is mildest there"). A downstream response can
  amplify a mild upstream deviation (near a resonance or steep feature), so the
  mildest-affected zone can be largest in effect and needs its own probe, not an
  exemption.
- **(b) superseded values left quotable** — pre-fix stored values that remain quotable
  after the fix, so a superseded number travels on as current truth.

**Minimum disconfirming check.** For each still-quoted number downstream of the fix,
produce its measured immune/bounded status from the impact map — each probe paired
with an identity control (a point whose expected outcome is strict identity) that
passed; a probe whose control fails counts as no measurement — or the post-fix
recomputation that superseded it (superseded stored values marked do-not-quote where
they live), or a demonstration that its inputs lie wholly outside the affected domain.
A number with none of the three is an unmeasured claim: do not cross the boundary.

This is **not a new receipt mode**: record it under **M3** (a quoted number's validity)
and **M5** (an artifact of a since-fixed defect treated as a result). The active gate is
`numerical-reliability-gate` **G6** — after a correction, recompute downstream, never
relabel — which carries the defect impact map and its identity controls; the
display-side counterpart is `figure-hygiene`'s fail-closed substitution rule.

## Validation-chain validity (a "validated" claim names its reference, its layer, and a rejected alternative)

A result defended as "validated" / "cross-checked" / "reduces to a known object" is only as good as
the gate that says so. Three failure shapes pass silently, each observed in practice:

- **(a) circular reference** — the gate's reference object was derived under (or reverse-engineered
  from) the very assumption the gate is now trusted to test; the comparison is A-against-A and
  passes indefinitely while the shared assumption is wrong.
- **(b) stripped comparison** — the check compares in a simplified limit/mode in which all competing
  hypotheses collapse to the same object, so it cannot discriminate the disputed structure no matter
  how precisely it agrees.
- **(c) layer / path transfer** — a validation of one layer (e.g. a denominator/singularity
  skeleton) or of a sibling reference implementation is cited as support for an orthogonal layer
  (an operator/numerator structure) or for a production path that never invokes the validated code.

**Minimum disconfirming check.** For each load-bearing "validated" claim crossing the boundary,
record: (1) the provenance of the gate's reference and why it is independent of the assumption
under test; (2) that the comparison retains the disputed degree of freedom; (3) at least one
**negative control** — a known-wrong variant the gate demonstrably rejects, with its failure margin
(a gate that has never rejected anything is unproven); (4) which layer and which code path the
validation covers, stated next to the claim. A gate failing any of these does not discharge the
check — the "validated" status is void and the result reverts to a labeled candidate.

This is **not a new receipt mode**: record it under **M1** (the gate is code/reasoning that passed
its author's self-review) and **M5** (a gate-pass artifact treated as a genuine confirmation). The
active gate is `numerical-reliability-gate` **G9** (verdict `circular_validation`), which also
carries the negative-control bonus: the failure *pattern* of the wrong variants localizes errors
that symbolic review alone does not reach.

## Accelerated / heuristic fast-path honesty (a fast path that can be wrong is scoped, not guaranteed)

A **fast / optimized computational path** that is a *heuristic* — one whose *local* success certificate
does not entail the *global* answer (the archetype: a fixed-start Krylov/subspace iteration for a
dominant eigenvalue/quantity, where a small residual certifies *an* eigenpair, **not** that it is the
dominant one, so a target mode nearly orthogonal to the deterministic start is silently missed) — is
correct only under a **precondition**, and three failures pass silently even after a correctness /
methodology gate has accepted the implementation:

- **(a) false guarantee** — a docstring / comment / README states a correctness the method does not
  deliver ("never returns a wrong value", "always finds the dominant mode"). The claim is false as
  written **even if the wrong output never arises in the actual production use**, and a later caller will
  lean on it in a regime where it fails.
- **(b) asserted, not validated, precondition** — the condition under which the fast path equals the
  unconditional answer is *assumed* to hold for the production input rather than *demonstrated* there (a
  structural argument plus a fast ≡ exact cross-check — at the production setting if affordable, else on
  the largest affordable production-regime cases with the extrapolation gap recorded).
- **(c) no escape hatch** — the slow-but-provably-correct path (a dense/direct solve, an exhaustive
  enumeration) is not retained and auto-selected where it is cheap, so there is no unconditional fallback.

**Minimum disconfirming check.** For each load-bearing fast / heuristic path crossing the boundary: (1)
*try to construct one input that breaks its stated guarantee* — if you can (for a fixed-start heuristic
you almost always can), narrow the guarantee to the precondition that actually holds and document the
failure mode (that it can return a wrong value, and how such an input is built); (2) confirm the
precondition is **validated at (or as near as feasible to) the production setting**, not asserted; (3) confirm the unconditional path
exists and is auto-selected where affordable. An adversarial counterexample that never arises in the
production use is refuting the **claim**, not the result — answer with honest scoping (narrow the claim,
document the blind spot, keep the escape hatch, validate the real use), never by rewording to fake a
guarantee, tuning a seed/parameter to hide the case, or chasing an impossible cheap *universal* guarantee.
Where a fundamental limit exists (e.g. no fixed-start Krylov/subspace method certifies global dominance —
so a global guarantee needs a whole-operator routine, canonically a full dense eigensolve or another
globally certified path), state it rather than pretend it away.

This is **not a new receipt mode**: record the false guarantee (a) under **M1** (here M1 covers a stated
guarantee / documentation claim, not only a code bug — code, reasoning, or a claimed guarantee that passed
its author's self-review) and the production-setting precondition (b) under **M5b** — with M5b's
production-scale requirement discharged by the **structural argument about the real (production)
operator**, the fast ≡ exact cross-check on smaller affordable cases serving only as *corroboration* (gap
recorded), never as the smaller-scale-only evidence M5b rightly rejects (absent a production-scale
structural argument, an exact-infeasible precondition is simply **unvalidated** → `overclaimed_heuristic`).
The missing-escape-hatch failure (c) has no M-mode analogue and is carried by the active gate
`numerical-reliability-gate` **G10** (verdict `overclaimed_heuristic`) directly. G10 complements
`numerical-reliability-gate` **G3**, which says to prefer a robust invariant *instead of* the heuristic
where that is affordable — G10 governs the case where the heuristic is deliberately kept as a performance
fast path.
