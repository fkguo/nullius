# W6-15 Review Packet (Round-001) — $\eta_{\\rm floor}=0.8$ monotonicity ladder @ $Q^*$ + Clarabel instability + regularization-bias note

NOT_FOR_CITATION. Tools disabled for reviewers.

## Purpose

Follow-up to W6-14. We are auditing the expected monotonic behavior under the conservative $\eta$-profile knob:

- In the dispersion-coupled modulus SOCP, $c_{\\rm fac}(s) \\propto (1+\\eta(s))/2$, so increasing `eta_floor` should **relax** constraints; hence $A_{\\min}(-Q^*)$ should be **non-increasing** as `eta_floor` increases, for an identical conic program.

This round reviews:
1) The $\eta_{\\rm floor}=0.8$ single-point audit at fixed $Q^*$ using ECOS (diagnostic monotonicity ladder).
2) Clarabel failure at $\eta_{\\rm floor}=0.8$ (feasibility `NUMERICAL_ERROR`) recorded as a negative-result pattern.
3) A diagnostic note that the W6-14 Clarabel rescue setting (`static_regularization_constant=1e-6`) appears to bias objectives even on the $\eta_{\\rm floor}=0.6$ baseline; therefore we treat it as *diagnostic-only* until a small-regularization ladder reproduces baseline values.

## Key artifacts / reproduction

Summary bundle (baseline + probes):
- `docs/reviews/bundles/2026-02-17-w6-15-eta0p8-monotonicity-summary-v1.txt`

Configs (instance repo):
- ECOS probe ($\\eta_{\\rm floor}=0.8$):  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2r_dispersion_grid200_enf200_qstar_audit3_eta0p8_ecos.json`
- Clarabel probe ($\\eta_{\\rm floor}=0.8$):  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2s_dispersion_grid200_enf200_qstar_audit3_eta0p8_clarabel.json`
- Clarabel regularization diagnostic (baseline $\\eta_{\\rm floor}=0.6$ + static reg 1e-6):  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2t_dispersion_grid200_enf200_qstar_audit3_eta0p6_clarabel_reg1e-6.json`

Runs (instance repo):
- ECOS $\\eta_{\\rm floor}=0.8$:  
  `idea-runs/.../runs/2026-02-17-a-bochner-k0-socp-v28-dispersion-grid200-enf200-qstar-audit3-eta0p8-ecos/`
- Clarabel $\\eta_{\\rm floor}=0.8$ (NUMERICAL_ERROR at feasibility):  
  `idea-runs/.../runs/2026-02-17-a-bochner-k0-socp-v29-dispersion-grid200-enf200-qstar-audit3-eta0p8-clarabel/`
- Clarabel baseline + static reg 1e-6 (diagnostic objective shift):  
  `idea-runs/.../runs/2026-02-17-a-bochner-k0-socp-v30-dispersion-grid200-enf200-qstar-audit3-eta0p6-clarabel-reg1e-6/`

Negative-result notes (instance repo):
- `idea-runs/.../evidence/neg_results/2026-02-17-v29-eta0p8-clarabel-feasibility-numerical-error-v1.txt`
- `idea-runs/.../evidence/neg_results/2026-02-17-v30-eta0p6-clarabel-static-reg-1e-6-objective-shift-v1.txt`

Verification commands (PASS):
- `idea-generator make validate`: `docs/reviews/bundles/2026-02-17-w6-15-idea-generator-validate-v1.txt`
- `idea-runs make validate`: `docs/reviews/bundles/2026-02-17-w6-15-idea-runs-validate-v1.txt`
- `idea-runs PROJECT=... make validate-project`: `docs/reviews/bundles/2026-02-17-w6-15-idea-runs-validate-project-v1.txt`
- failure hook (post-append refresh):
  - index build: `docs/reviews/bundles/2026-02-17-w6-15-failure-library-index-build-v2.txt`
  - query run: `docs/reviews/bundles/2026-02-17-w6-15-failure-library-query-run-v2.txt`

Commits:
- `idea-runs`: 57161f6, 72839f9

## Claim under review (W6-15)

1) **Monotonicity ladder progress (diagnostic):** ECOS successfully solves the $\\eta_{\\rm floor}=0.8$ audit3 single-point instance (v28) and yields a positive endpoint lower bound at $Q^*$; it is consistent with the expected monotone weakening as `eta_floor` increases (see prior ECOS $\eta_{\\rm floor}=1$ diagnostic from W6-13).

2) **Clarabel instability recorded (tooling):** Clarabel terminates with `NUMERICAL_ERROR` already at the feasibility gate for $\\eta_{\\rm floor}=0.8$ (v29). Residual auditing suggests constraints are satisfied at small tolerances, so we interpret this as numerical instability rather than physical infeasibility; we record it as a negative result and a structured `failed_approach_v1` entry.

3) **Regularization-bias warning (diagnostic):** The rescue setting `static_regularization_constant=1e-6` can materially shift objective values even on the baseline $\\eta_{\\rm floor}=0.6$ instance (v30 vs v21). Therefore, we treat large static regularization as diagnostic-only until a small-regularization ladder reproduces baseline values within a conservative tolerance.

## Reviewer questions

1) Is it acceptable to record W6-15 as “audit ladder progress + negative-result capture”, while explicitly not promoting any Clarabel regularization-tuned objectives as physics evidence yet?
2) Do you agree with the proposed next step: sweep Clarabel solver attributes in a small ladder (static reg 1e-12/1e-10/1e-8/1e-7 + dynamic reg on/off + equilibration/presolve toggles) and accept only settings that both pass feasibility and reproduce the baseline within a conservative tolerance?
3) Any higher-priority Clarabel setting(s) to try first for feasibility stability at $\\eta_{\\rm floor}\\ge 0.8$ on this SOCP family?
4) VERDICT: READY to proceed to the solver-attribute sweep and then a minimal $\eta_{\\rm floor}$ scan ladder (0.6/0.8/1.0) with stable Clarabel settings?

## Required verdict format

First line must be exactly `VERDICT: READY` or `VERDICT: NOT_READY`, with no preamble, and include the strict headers required by the contract checker.

