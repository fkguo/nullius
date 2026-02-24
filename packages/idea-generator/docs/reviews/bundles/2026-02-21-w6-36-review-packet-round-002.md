# W6-36 Review Packet (Round-002) — Address cross-solver gate + float-binding semantics (tightening island execution)

NOT_FOR_CITATION. Tools disabled for reviewers.

## Purpose (unchanged)

Start executing the “tightening island” plan (W6-34) in a way that is **evidence-first** and **fail-closed**:

1) Introduce a machine-checkable **internal $\pi\pi$ S-matrix constraint** contract for the full $3\times 3$ PSD tightening kernel (without outputting phase shifts), and enforce it via `validate-project`.
2) Implement a trace-channel **full-PSD** SDP prototype (JuMP; SCS/COSMO) and run laptop-feasible smoke tests.

Hard scope constraints remain fixed:
- pion-only,
- no coupled-channel,
- laptop-feasible (smoke now; scale-up must stay within budget),
- evidence-closed-loop (schemas/artifacts/runs/evidence notes + gate receipts).

## Round-001 review status (inputs to this round)

- Opus (reviewer A): `VERDICT: NOT_READY` with blockers:
  - B1: missing enforced cross-solver gate for the full-PSD pathway
  - B2: float-binding semantics for s-grid binding unspecified
  - Output: `docs/plans/agent-team-output/2026-02-21-w6-36-review-v1/round-001/claude_output.md`
- Gemini (reviewer B): `VERDICT: READY`
  - Output: `docs/plans/agent-team-output/2026-02-21-w6-36-review-v1/round-001/gemini_output.md`

## Changes since Round-001 (addresses Opus blockers)

### (B1) Enforced cross-solver smoke gate for the full-PSD SDP pathway

We **do not** claim pilot-grade solver agreement yet, but we now enforce a machine-checkable *stability smoke gate* (finite + accepted statuses + same order) so that solver-dependent artifacts cannot be silently consumed downstream.

1) Cross-solver checker now supports trace $\hat\Theta^\pi$ bounds:
   - `idea-runs/schemas/cross_solver_check_v1.schema.json` allows `kind="Theta_hat_minusQ2_bounds_v1"`.
   - `idea-runs/scripts/validate_project_artifacts.py` cross-solver check supports `Theta_hat_minusQ2_{min,max}` arrays.
2) Project pipeline config now includes a trace $\hat\Theta^\pi$ cross-solver check on the “golden reduced” q2grid2 smoke instance:
   - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/pipeline/cross_solver_check_v1.json`
   - check id: `w6-36-theta-fullpsd-smoke-grid80-audit11-scs-vs-cosmo`
   - tolerance is intentionally coarse (abs=10, rel=0.6) and explicitly documented as “smoke stability gate”, not tightening/promotion.

### (B1.5) Fix a critical false-pass hazard: NaN/non-finite + per-$Q^2$ statuses are now gate-checked

We found that SCS can fail at the interior point (e.g. $Q^2=2\,\mathrm{GeV}^2$) while still being OPTIMAL at $Q^2=0$. To prevent the cross-solver gate from accidentally passing such runs:

- `idea-runs/scripts/validate_project_artifacts.py`
  - rejects non-finite values (`nan`/`inf`) in the compared bound arrays, and
  - requires **all** entries in `results.solver_status[]` (one per $Q^2$ point) to have `min_status/max_status` in the accepted list (not just the first entry).

### (B2) Document float-binding semantics for s-grid binding

We keep the current binding semantics (tight absolute epsilon) and document it explicitly:

- `idea-generator/schemas/s_matrix_constraints_v1.schema.json`
- `idea-runs/schemas/s_matrix_constraints_v1.schema.json`
  - schema `description` and `s_grid_mpi2.description` now state that `validate-project` binds the artifact grid to the compute grid with `|Δs|<=1e-12`.
- Evidence note also records this as an explicit gate semantic.

## Smoke-run status (still not “tightening”)

We still treat W6-36 as a tooling milestone (contract + gate + reproducible smoke evidence), not a physics tightening claim.

Updated evidence note (includes the golden reduced runs + SCS nonconvergence at tighter eps):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/2026-02-21-w6-36-theta-fullpsd-smoke-and-smatrix-gate-v1.md`

## Verification evidence (gate receipts)

Existing receipts are still present under `docs/reviews/bundles/2026-02-21-w6-36-*.txt`. This round will regenerate v2 receipts after the patch set is complete.

## Reviewer questions (Round-002)

1) Do the changes above fully resolve Opus B1/B2, i.e. is W6-36 now `VERDICT: READY` as an infrastructure increment?
2) Is the “coarse cross-solver smoke gate” acceptable as a fail-closed mechanism at this stage (with explicit documentation that it is not a tightening/promotion tolerance)?
3) Any minimal additional guardrails needed before we proceed to the *actual tightening* step: ingest He/Su-style modern bootstrap constraints into `s_matrix_constraints_v1` (halfspaces/regions) and rerun the full-PSD kernel?

