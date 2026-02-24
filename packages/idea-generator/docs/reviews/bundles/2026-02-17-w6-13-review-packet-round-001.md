# W6-13 Review Packet (Round-001) — Robustness probe: $\eta$-profile set to $\eta(s)=1$ at $Q^*$ (Clarabel NUMERICAL_ERROR; ECOS diagnostic positive)

NOT_FOR_CITATION. Tools disabled for reviewers.

## Purpose

Stress-test the endpoint positivity statement at $Q^*$ under a more conservative $\eta$-profile choice:

- Base mainline uses a piecewise-constant $\eta(s)$ with $\eta=1$ below $s_{\\rm inel}$ and $\eta=\\eta_{\\rm floor}=0.6$ above (tightens modulus constraints at higher $s$).
- This probe sets **$\eta_{\\rm floor}=1.0$** (so $\eta(s)=1$ everywhere) and attempts to re-run the **audit3 single-point conic program at $Q^*$**.

## Key artifacts / reproduction

Summary bundle (centralized):
- `docs/reviews/bundles/2026-02-17-w6-13-eta1-robustness-probe-summary-v1.txt`

Configs (instance repo):
- Clarabel eta1 attempt:  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2m_dispersion_grid200_enf200_qstar_audit3_eta1_clarabel.json`
- Clarabel eta1 retry (no equilibration):  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2n_dispersion_grid200_enf200_qstar_audit3_eta1_clarabel_noequil.json`
- ECOS eta1 diagnostic:  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2p_dispersion_grid200_enf200_qstar_audit3_eta1_ecos.json`

Runs:
- Clarabel v24 (eta1): `.../runs/2026-02-17-a-bochner-k0-socp-v24-dispersion-grid200-enf200-qstar-audit3-eta1-clarabel/` (termination_feasibility=NUMERICAL_ERROR)
- Clarabel v25 (eta1, noequil): `.../runs/2026-02-17-a-bochner-k0-socp-v25-dispersion-grid200-enf200-qstar-audit3-eta1-clarabel-noequil/` (termination_feasibility=NUMERICAL_ERROR)
- ECOS v26 (eta1): `.../runs/2026-02-17-a-bochner-k0-socp-v26-dispersion-grid200-enf200-qstar-audit3-eta1-ecos/` (OPTIMAL; $A_{\\min}(-Q^*)\\approx 0.006776$)

Negative-result note (instance repo):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/neg_results/2026-02-17-v24-eta1-clarabel-feasibility-numerical-error-v1.txt`

Machine-checkable recording:
- Failure library entry appended: `idea-runs/.../artifacts/ideas/failed_approach_v1.jsonl`
- Island progress stream appended + dashboards re-rendered: `idea-runs/.../artifacts/islands/idea_island_progress_v1.jsonl`, `.../islands_dashboard_v1.md`

Verification commands (PASS):
- `idea-runs make validate`: `docs/reviews/bundles/2026-02-17-w6-13-eta1-idea-runs-validate-v1.txt`
- `idea-runs PROJECT=... make validate-project`: `docs/reviews/bundles/2026-02-17-w6-13-eta1-idea-runs-validate-project-v1.txt`
- failure hook:
  - index build: `docs/reviews/bundles/2026-02-17-w6-13-eta1-failure-library-index-build-v1.txt`
  - query run: `docs/reviews/bundles/2026-02-17-w6-13-eta1-failure-library-query-run-v1.txt`

## Claim under review (W6-13)

1) **Partial robustness evidence:** Under $\eta(s)=1$ everywhere, ECOS (diagnostic) can still solve the single-point audit3 conic program at $Q^*$ and yields a positive lower bound:
   $$A_{\\min}(-Q^*) \\approx 0.006776>0.$$
   (Dual-audit agrees within numerical noise; see summary bundle.)

2) **Solver limitation (critical):** Clarabel (primary) terminates with `NUMERICAL_ERROR` already at the feasibility gate for the same $\eta$-profile modification (both with and without equilibration). Therefore, we **do not** treat this as a Clarabel-backed robustness statement yet.

3) **Interpretation discipline:** Clarabel `NUMERICAL_ERROR` is treated strictly as a solver/numerics failure mode (not physical infeasibility) and is recorded as a negative result + failed_approach entry for reuse.

## Reviewer questions

1) Is the above “partial robustness evidence” phrased conservatively enough given Clarabel’s numerical failure?
2) Do you agree with the failure recording decision (failed_approach + neg_results note + island progress event)?
3) What is the highest-leverage next retry to rescue Clarabel feasibility under $\eta_{\\rm floor}=1$ (e.g., Clarabel regularization settings, presolve toggles, explicit magnitude bounds, or alternative formulations)?
4) VERDICT: READY to proceed to the next unit (Clarabel tuning retries + a minimal $\eta_{\\rm floor}$ scan grid) while keeping ECOS as a diagnostic?

## Required verdict format

First line must be exactly `VERDICT: READY` or `VERDICT: NOT_READY`, with no preamble, and include the strict headers required by the contract checker.

