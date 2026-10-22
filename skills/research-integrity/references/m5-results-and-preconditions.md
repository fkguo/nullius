Command, script and asset paths in this reference are relative to the `research-integrity` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

### M5: bug_as_insight

**In-cycle exemption.** If you are inside an active `research-team`
cycle and the Reproducibility Capsule (specifically section
"G) Sweep semantics / parameter dependence") has been filled and
the convergence gate has accepted this milestone, the per-boundary
M5 walk reduces to: *verify the capsule's G/H sections are filled
and validated for this milestone, and verify the cited finding falls
under the capsule's declared sweep / branch coverage*. Do not
duplicate the perturbation work the capsule already locked in. If
you are *not* in a research-team cycle, or the capsule does not
cover the cited observable, perform the full check below.
**This exemption covers ONLY sweep/branch coverage (§G/§H); it does
NOT cover method-validity preconditions.** M5b below is performed in
full **regardless of the cycle** and is **never** discharged by a
gate pass alone: the capsule's §J records the precondition residual,
but M5b independently confirms it was actually measured at the
PRODUCTION configuration (a concrete residual + command/artifact +
matching config), not self-asserted. (Never let an exemption defer to
a gate that may not have run the check at the production scale.)

**Definition.** Treating an artifact of a code bug, numerical
instability, plotting mistake, or unit error as a genuine scientific
result. The agent reports the artifact as the finding instead of
investigating its source.

**Signs.**
- Unexpected feature in output and the response says "this is
  interesting" without first ruling out a code-side cause.
- Effect disappears or reverses sign when a parameter unrelated to
  the modeled system is changed (random seed, batch size, numerical
  tolerance, mesh resolution, integration order).
- Effect cannot be reproduced from a clean checkout with the
  recorded seeds and config.
- The "finding" coincides with a recent code change that touched the
  observable.

**Minimum disconfirming check.** Reproduce the alleged finding from a
clean checkout under the same seeds and parameters recorded in
`artifacts/runs/<run_id>/`. If reproducible, perturb one numerical
knob (tolerance, precision, mesh size, integration order, sample
size, domain size / number of sites / grid parity / periodic-wrap
regime) and verify the effect persists in the expected direction. If
the effect comes and goes, the code is the first hypothesis to
investigate.

**M5b: precondition_as_validity (no in-cycle exemption).** If the
result comes from a method whose validity rests on a structural
property of the operator/method — an operator commuting with a
projector/symmetrizer, Hermiticity, self-adjointness, idempotency,
unitarity, a variational/Galerkin subspace being invariant under the
operator — you MUST evaluate that property's disconfirming residual
**at the exact scale/configuration that produced the headline
number**, regardless of the in-cycle exemption and regardless of how
clean the reproduction is. A precondition-violating result is
perfectly reproducible from a clean checkout and survives
knob-perturbation, so the M5 reproduce-and-perturb check passes it;
only the precondition residual *at the production scale* exposes it.
For a projected/effective eigenvalue report the true-operator
residual `‖Oψ − λψ‖/‖Oψ‖`, not merely that ψ has the assumed
symmetry. A precondition verified only at a smaller/cheaper scale
than the result is NOT verified.

**Tools that help.**
- `nullius run` with explicit `run_id` for reproducibility.
- `research-team` Reproducibility Capsule (mandatory section of
  `research_contract.md`).
- `derivation-verify` (or a CAS) for an independent symbolic
  re-derivation when an analytic cross-check is available.
- `git bisect` when the symptom postdates a known-clean reference
  point.
