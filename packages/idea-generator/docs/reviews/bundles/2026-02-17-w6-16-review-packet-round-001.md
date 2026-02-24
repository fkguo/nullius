# W6-16 Review Packet (Round-001) — Clarabel $\eta_{\\rm floor}=0.8$ solver-attribute sweep: feasibility threshold + baseline objective-bias cross-check

NOT_FOR_CITATION. Tools disabled for reviewers.

## Purpose

Follow-up to W6-15. Goal is to stabilize Clarabel (primary) for the conservative $\eta$-profile scan at fixed $Q^*$:

- We previously saw Clarabel feasibility `NUMERICAL_ERROR` at $\eta_{\\rm floor}=0.8$ (v29).
- W6-16 runs a minimal solver-attribute sweep to identify:
  1) the smallest regularization that restores feasibility at $\eta_{\\rm floor}=0.8$, and
  2) whether that setting biases objective values (checked by rerunning the $\eta_{\\rm floor}=0.6$ baseline under identical solver settings).

## Key artifacts / reproduction

Sweep summary (numbers + statuses):
- `docs/reviews/bundles/2026-02-17-w6-16-clarabel-eta0p8-reg-sweep-summary-v1.txt`

Configs (instance repo):
- v31 (eta=0.8; static reg 1e-8; dyn off):  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2u_dispersion_grid200_enf200_qstar_audit3_eta0p8_clarabel_reg1e-8.json`
- v34 (eta=0.8; static reg 1e-8; dyn on):  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2x_dispersion_grid200_enf200_qstar_audit3_eta0p8_clarabel_reg1e-8_dyn.json`
- v32 (eta=0.8; static reg 1e-7; dyn off):  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2v_dispersion_grid200_enf200_qstar_audit3_eta0p8_clarabel_reg1e-7.json`
- v33 (eta=0.6 baseline; static reg 1e-7; dyn off):  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2w_dispersion_grid200_enf200_qstar_audit3_eta0p6_clarabel_reg1e-7.json`

Runs (instance repo):
- v31: `idea-runs/.../runs/2026-02-17-a-bochner-k0-socp-v31-...-eta0p8-clarabel-reg1e-8/` (NUMERICAL_ERROR)
- v34: `idea-runs/.../runs/2026-02-17-a-bochner-k0-socp-v34-...-eta0p8-clarabel-reg1e-8-dyn/` (NUMERICAL_ERROR)
- v32: `idea-runs/.../runs/2026-02-17-a-bochner-k0-socp-v32-...-eta0p8-clarabel-reg1e-7/` (OPTIMAL)
- v33: `idea-runs/.../runs/2026-02-17-a-bochner-k0-socp-v33-...-eta0p6-clarabel-reg1e-7/` (OPTIMAL)

Neg-results notes (instance repo):
- `idea-runs/.../evidence/neg_results/2026-02-17-v31-v34-eta0p8-clarabel-small-reg-numerical-error-v1.txt`
- `idea-runs/.../evidence/neg_results/2026-02-17-v33-eta0p6-clarabel-reg1e-7-objective-shift-v1.txt`

Verification commands (PASS):
- `idea-generator make validate`: `docs/reviews/bundles/2026-02-17-w6-16-idea-generator-validate-v1.txt`
- `idea-runs make validate`: `docs/reviews/bundles/2026-02-17-w6-16-idea-runs-validate-v1.txt`
- `idea-runs PROJECT=... make validate-project`: `docs/reviews/bundles/2026-02-17-w6-16-idea-runs-validate-project-v1.txt`
- failure hook:
  - index build: `docs/reviews/bundles/2026-02-17-w6-16-failure-library-index-build-v1.txt`
  - query run: `docs/reviews/bundles/2026-02-17-w6-16-failure-library-query-run-v1.txt`

Commit(s):
- `idea-runs`: fb7f5de

## Claim under review (W6-16)

1) **Feasibility threshold finding:** For this SOCP family at $Q^*$, Clarabel feasibility at $\eta_{\\rm floor}=0.8$ is not rescued by static regularization 1e-8 (dyn on/off), but is rescued by static regularization 1e-7 with dynamic regularization disabled (v32).

2) **Baseline-bias cross-check:** The same Clarabel regularization setting (1e-7; dyn off) materially shifts the $\eta_{\\rm floor}=0.6$ baseline objective (v33 vs v21), so reg-tuned objective values are diagnostic-only until an acceptance criterion is defined and met.

3) **Next step (proposal):** pre-register an acceptance criterion and run a small-regularization ladder that searches for a setting that:
   - keeps feasibility OPTIMAL at $\eta_{\\rm floor}=0.8$, and
   - recovers the $\eta_{\\rm floor}=0.6$ baseline objective within tolerance.

## Reviewer questions

1) Is it acceptable to record this sweep as “feasibility rescued but objective still biased”, and proceed to an acceptance-criterion + ladder sweep, rather than promoting any reg-tuned $A_{\\min}$ as physics evidence?
2) Any Clarabel attribute(s) you recommend prioritizing next to reduce objective bias while keeping feasibility stable (equilibrate/presolve/refinement, etc.)?
3) VERDICT: READY to proceed to the acceptance-criterion ladder sweep?

## Required verdict format

First line must be exactly `VERDICT: READY` or `VERDICT: NOT_READY`, with no preamble, and include the strict headers required by the contract checker.

