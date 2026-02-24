# 2026-02-01 — W2 toy reproduce design

Goal: define a deterministic “toy” W2 case that exercises the full **reproduce → artifacts → compare → audit** pipeline, before locking onto a real-paper headline result.

Why a toy case first:
- Validates the workflow contract + artifacts schema without depending on external codebases or ambiguous paper conventions.
- Enables fast regression tests (E4) so future agent “evolution” (L2/L3) can be gated safely.

Related workflow spec: [W2 — Reproduction-first](../../workflows/W2_reproduce.md).

## Target definition (toy)

Compute a small set of 1D integrals with known closed-form answers, and report:
- the numeric value(s),
- absolute/relative error vs exact,
- cross-method disagreement (audit metric).

Example family:

$$
I_n \equiv \int_0^{\infty} x^n e^{-x}\,dx = \Gamma(n+1) = n!.
$$

Pick a small set of $n$ values (e.g. $n=0,1,2,5,10$) to avoid triviality and to stress the integrator.

## Candidate methods

1) Primary: `scipy.integrate.quad` (adaptive Gauss–Kronrod)
   - Pros: fast, robust, available in base scientific Python stacks.
   - Cons: may need care with tolerances and integration limits.
2) Cross-check: `mpmath.quad` with increased precision
   - Pros: independent implementation; can raise precision to diagnose numeric issues.
   - Cons: slower.
3) Exact reference: `math.gamma` / factorial (closed form)
   - Used only as ground truth for toy; for real papers this becomes “paper target”.

## Selection rationale (M2 v0)

Use (1) as the main result, (2) as the independent check, and (3) as the reference.
The key audit headline number for E4 should be the **cross-method disagreement**:

$$
\Delta \equiv \lvert I_n^{\rm scipy} - I_n^{\rm mpmath} \rvert.
$$

## Artifacts mapping (contract)

Runner output must write:
- `artifacts/runs/<TAG>/reproduce/manifest.json` (inputs, versions, command line)
- `artifacts/runs/<TAG>/reproduce/summary.json` (what ran, success/failure)
- `artifacts/runs/<TAG>/reproduce/analysis.json` (numeric results + errors + audit metrics)

And `analysis.json` must include machine-checkable fields such as:
- `results.integrals[n].scipy.value`
- `results.integrals[n].mpmath.value`
- `results.integrals[n].exact.value`
- `results.integrals[n].abs_err_scipy`
- `results.integrals[n].abs_err_mpmath`
- `results.integrals[n].abs_diff_scipy_mpmath`

## Human approval points

This toy W2 case should be runnable without additional human approvals beyond default code-change review (A2) because it is:
- fully local and deterministic,
- low compute cost,
- does not require mass web search.

