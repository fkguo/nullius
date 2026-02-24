# W6-14 Review Packet (Round-001) — Clarabel tuning: rescue $\eta_{\\rm floor}=1$ feasibility (regularization) + monotonicity discrepancy note

NOT_FOR_CITATION. Tools disabled for reviewers.

## Purpose

Follow-up to W6-13: Clarabel (primary) previously terminated with `NUMERICAL_ERROR` at the feasibility gate when we switched to the conservative $\eta$-profile $\eta_{\\rm floor}=1$ at fixed $Q^*$.

This round reviews:
1) A **solver-only** Clarabel tuning retry that now passes feasibility and produces outputs at $Q^*$ under $\eta_{\\rm floor}=1$.
2) A conservative interpretation of the resulting objective values, because the Clarabel $A_{\\min}$ is unexpectedly larger than the $\eta_{\\rm floor}=0.6$ baseline (monotonicity mismatch), so we treat it as diagnostic until audited.

## Key artifacts / reproduction

Summary bundle (includes baseline vs ECOS vs Clarabel-reg comparison):
- `docs/reviews/bundles/2026-02-17-w6-14-eta1-clarabel-reg-summary-v1.txt`

Config (instance repo):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2q_dispersion_grid200_enf200_qstar_audit3_eta1_clarabel_reg1e-6.json`
  - Adds Clarabel solver attributes:
    - `static_regularization_constant=1e-6`
    - `dynamic_regularization_enable=false`

Run (instance repo):
- `idea-runs/.../runs/2026-02-17-a-bochner-k0-socp-v27-dispersion-grid200-enf200-qstar-audit3-eta1-clarabel-reg1e-6/`

Verification commands (PASS):
- `idea-runs make validate`: `docs/reviews/bundles/2026-02-17-w6-14-eta1-clarabel-reg-idea-runs-validate-v1.txt`
- `idea-runs PROJECT=... make validate-project`: `docs/reviews/bundles/2026-02-17-w6-14-eta1-clarabel-reg-idea-runs-validate-project-v1.txt`
- failure hook:
  - index build: `docs/reviews/bundles/2026-02-17-w6-14-eta1-clarabel-reg-failure-library-index-build-v1.txt`
  - query run: `docs/reviews/bundles/2026-02-17-w6-14-eta1-clarabel-reg-failure-library-query-run-v1.txt`

## Claim under review (W6-14)

1) **Tuning success claim (tooling):** Clarabel feasibility `NUMERICAL_ERROR` for $\eta_{\\rm floor}=1$ can be eliminated by regularization tuning (static regularization increased; dynamic regularization disabled), yielding an `OPTIMAL` feasibility status and producing min/max results at $Q^*$.

2) **Conservative interpretation claim:** Because the Clarabel v27 $A_{\\min}(-Q^*)$ is unexpectedly larger than the $\eta_{\\rm floor}=0.6$ baseline (which would violate monotonicity expectations if the conic programs were identical), we treat v27 objective values as **diagnostic only** until we complete a monotonicity/bridge/tolerance audit. For robustness statements we keep using the conservative cross-solver envelope (min across solvers).

## Reviewer questions

1) Is it acceptable to record this as “solver tuning success” while explicitly not using the v27 objective value as physics evidence yet?
2) Do you agree with the proposed next step: a monotonicity audit (ensure the $\eta_{\\rm floor}=1$ program is a relaxation of $\eta_{\\rm floor}=0.6$, then compare solver objectives under identical bridges/tolerances)?
3) Any other Clarabel settings you recommend scanning first (equilibration/presolve/refinement/regularization) to stabilize both feasibility and objective credibility?
4) VERDICT: READY to proceed to monotonicity audit + a minimal $\eta_{\\rm floor}$ scan ladder (e.g. 0.6/0.8/1.0) at fixed $Q^*$?

## Required verdict format

First line must be exactly `VERDICT: READY` or `VERDICT: NOT_READY`, with no preamble, and include the strict headers required by the contract checker.

