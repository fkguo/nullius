# W6-18 Review Packet (Round-001) — SRerr-style SVZ moment constraint as an $L_2$-norm SOC tightening @ $Q^*$ (plus Clarabel feasibility regression)

NOT_FOR_CITATION. Tools disabled for reviewers.

## Purpose

We aim to shift focus from “which solver behaves” to a **physics/maths tightening** aligned with modern bootstrap practice:

- arXiv:2403.10772 imposes SVZ/FESR constraints as a **vector norm** bound (Eq. `SRerr`), i.e. $\\|w\\|\\le\\epsilon$, rather than independent per-moment bands.
- Our pilot previously used componentwise absolute bands (still weaker than SRerr’s vector constraint).
- W6-18 implements the **SRerr vector $L_2$ constraint** as a single SOC constraint in the *dispersion-coupled SOCP* kernel and quantifies its tightening at the shared audit point
  $$Q^*=15.438084455604\\,m_\\pi^2.$$

Secondary goal:
- record the observed **Clarabel feasibility regression** (`NUMERICAL_ERROR`) under this refactor in an auditable way and decide how to treat solver choice moving forward.

## Key artifacts / reproduction

Primary diagnostic / summary (instance repo):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/neg_results/2026-02-18-srerr-moment-l2-socp-qstar-v1.txt`

Configs (instance repo):
- Baseline (componentwise abs band, ECOS):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2aa_dispersion_grid200_enf200_qstar_audit4_ecos_baseline_rerun.json`
- SRerr-style vector constraint ($L_2$ norm, ECOS):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2z_dispersion_grid200_enf200_qstar_audit4_ecos_moml2_rerun.json`
- Clarabel diagnostic retest (expected failure):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2ad_dispersion_grid200_enf200_qstar_audit3_clarabel_retest.json`

Runs (instance repo):
- Baseline (componentwise, ECOS):
  - `idea-runs/.../runs/2026-02-18-a-bochner-k0-socp-v32-dispersion-grid200-enf200-qstar-audit4-ecos-baseline/`
- SRerr L2 tightening (ECOS):
  - `idea-runs/.../runs/2026-02-18-a-bochner-k0-socp-v31-dispersion-grid200-enf200-qstar-audit4-ecos-moml2/`
- Clarabel feasibility regression (diagnostic):
  - `idea-runs/.../runs/2026-02-18-a-bochner-k0-socp-v35-dispersion-grid200-enf200-qstar-audit3-clarabel-retest/`

Code changes (instance repo):
- `idea-runs/.../compute/julia/bochner_k0_socp_dispersion_bounds.jl`
  - adds `moment_spec.tolerance_mode = componentwise|l2_norm`
  - implements SRerr $\\|w\\|_2\\le\\epsilon$ as a unit-radius scaled SOC constraint
  - adds moment residual auditing in `results.json` (moment values/targets/residual norms)
- `idea-runs/.../compute/julia/bochner_k0_socp_bounds.jl`
  - adds the same `moment_spec.tolerance_mode` semantics (non-dispersion baseline kernel)

Human-readable report update (NOT_FOR_CITATION):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/reports/draft.md`
  - adds “Phase N (W6-18): SRerr moment constraint as an L2-norm (SOC) tightening at $Q^*$”

Dashboards (human-readable):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/islands/islands_dashboard_v1.md`
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/opportunities/opportunities_dashboard_v1.md`

Machine-checkable pools updated:
- opportunity pool: `idea-runs/.../artifacts/opportunities/bootstrap_opportunity_pool_v1.jsonl` (adds SRerr-L2 opportunity card)
- island progress: `idea-runs/.../artifacts/islands/idea_island_progress_v1.jsonl` (W6-18 event appended)
- failure library: `idea-runs/.../artifacts/ideas/failed_approach_v1.jsonl` (Clarabel regression recorded)

Verification commands (PASS):
- `idea-generator make validate`: `docs/reviews/bundles/2026-02-18-w6-18-idea-generator-validate-v1.txt`
- `idea-runs make validate`: `docs/reviews/bundles/2026-02-18-w6-18-idea-runs-validate-v1.txt`
- `idea-runs PROJECT=... make validate-project`: `docs/reviews/bundles/2026-02-18-w6-18-idea-runs-validate-project-v1.txt`
- failure hook:
  - index build: `docs/reviews/bundles/2026-02-18-w6-18-failure-library-index-build-v1.txt`
  - query run: `docs/reviews/bundles/2026-02-18-w6-18-failure-library-query-run-v1.txt`

## Claim under review (W6-18)

1) **Modern-bootstrap alignment:** Implementing SVZ moment errors as a vector $L_2$ constraint (SOC) is the correct conic translation of arXiv:2403.10772 Eq. `SRerr`-style input, and should be preferred to independent per-moment bands.

2) **Quantitative effect (at $Q^*$, ECOS, same discretization):** the SRerr $L_2$ constraint yields a modest but measurable tightening vs componentwise abs bands:
- baseline: $A_{\\min}(-Q^*)=0.012047828618$, $A_{\\max}(-Q^*)=0.757989508542$
- SRerr $L_2$: $A_{\\min}(-Q^*)=0.012333435650$, $A_{\\max}(-Q^*)=0.757460592406$

3) **Solver posture:** Clarabel now hits `NUMERICAL_ERROR` at feasibility for this family under the refactor, so we treat ECOS as the primary evidence solver until Clarabel stability is recovered under an explicit acceptance criterion.

## Reviewer questions

1) Is the SRerr $L_2$ SOC implementation faithful enough to the paper’s intent to be treated as a “modern bootstrap” tightening step (even if small numerically here)?
2) Is it acceptable to proceed with ECOS as primary for this SOCP family while Clarabel is unstable, provided dual recomputation + residual budgets are recorded?
3) Given the tightening is small at $Q^*$, what is the most promising next tightening direction to shrink the interval substantially (UV/OPE inputs, more moments, low-energy constraints, different positivity kernels, etc.)?
4) VERDICT: READY to proceed to the next tightening phase (UV/OPE/trace-anomaly inputs and/or 1–2 low-energy conditions island)?

## Required verdict format

First line must be exactly `VERDICT: READY` or `VERDICT: NOT_READY`, with no preamble, and include the strict headers required by the contract checker.

