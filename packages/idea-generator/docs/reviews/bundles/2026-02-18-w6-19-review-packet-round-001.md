# W6-19 Review Packet (Round-001) — Low-energy slope (NLO ChPT / TMD) sum-rule tightening attempt: **INFEASIBLE** (recorded as a structured negative result)

NOT_FOR_CITATION. Tools disabled for reviewers.

## Purpose

User request: if 1–2 additional low-energy conditions can materially tighten pion $A^\\pi(-Q^2)$ bounds, it is worth exploring.  

W6-19 tests one concrete candidate:

- arXiv:2507.05375 provides an NLO ChPT slope for pion/kaon $A^i(t)$ (Eq. `Aslope`) and a tensor-meson-dominance (TMD) estimate (Eq. `TMD`).
- We translate this into a **linear “slope sum rule”** constraint on the spectral function ${\\rm Im}A(s)$ and add it to the **dispersion-coupled SOCP** kernel.
- Result: under the current bootstrap constraint stack, adding this slope constraint makes the model **INFEASIBLE** (ECOS), both for componentwise SVZ moments and SRerr-$L_2$ moments.

Goal for this review:
1) confirm the implementation is faithful (units/normalization), and  
2) confirm the “negative result discipline” is satisfied (failure library + dashboards + reproducibility + gates).

## Key artifacts / reproduction

Primary negative-result note (instance repo; human-readable):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/neg_results/2026-02-18-chpt-slope-sum-rule-infeasible-v1.txt`

Configs (instance repo):
- Baseline moments + slope(TMD) (ECOS):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v3aa_dispersion_grid200_enf200_qstar_audit4_ecos_baseline_slope_tmd.json`
- SRerr moment $L_2$ + slope(TMD) (ECOS):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v3ab_dispersion_grid200_enf200_qstar_audit4_ecos_moml2_slope_tmd.json`

Runs (instance repo):
- Baseline + slope(TMD) (INFEASIBLE):
  - `idea-runs/.../runs/2026-02-18-a-bochner-k0-socp-v36-dispersion-grid200-enf200-qstar-audit4-ecos-baseline-slope-tmd/`
- SRerr-$L_2$ + slope(TMD) (INFEASIBLE):
  - `idea-runs/.../runs/2026-02-18-a-bochner-k0-socp-v37-dispersion-grid200-enf200-qstar-audit4-ecos-moml2-slope-tmd/`

Code changes (instance repo):
- `idea-runs/.../compute/julia/bochner_k0_socp_dispersion_bounds.jl`
  - adds optional `sum_rules.f1` + `sum_rules.f1_absolute_tolerance`
  - computes tail integral `I_slope_tail = ∫_{s0}^{∞} ds Im_tail(s)/s^2`
  - audits `slope_eq` residuals in `results.json` for feasibility/min/max solves

Machine-checkable pools updated (instance repo):
- failure library (adds 2 records, both INFEASIBLE): `idea-runs/.../artifacts/ideas/failed_approach_v1.jsonl`
- opportunity pool (diagnostic gate card): `idea-runs/.../artifacts/opportunities/bootstrap_opportunity_pool_v1.jsonl`
- island progress event (FAILURE_RECORDED): `idea-runs/.../artifacts/islands/idea_island_progress_v1.jsonl`

Human-readable dashboards:
- `idea-runs/.../artifacts/islands/islands_dashboard_v1.md`
- `idea-runs/.../artifacts/opportunities/opportunities_dashboard_v1.md`

Human-readable report update (NOT_FOR_CITATION):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/reports/draft.md`
  - adds an explicit limitation bullet referencing the W6-19 slope infeasibility note.

Verification commands (PASS):
- `idea-generator make validate`: `docs/reviews/bundles/2026-02-18-w6-19-idea-generator-validate-v1.txt`
- `idea-runs make validate`: `docs/reviews/bundles/2026-02-18-w6-19-idea-runs-validate-v1.txt`
- `idea-runs PROJECT=... make validate-project`: `docs/reviews/bundles/2026-02-18-w6-19-idea-runs-validate-project-v1.txt`
- failure hook:
  - index build: `docs/reviews/bundles/2026-02-18-w6-19-failure-library-index-build-v1.txt`
  - query run: `docs/reviews/bundles/2026-02-18-w6-19-failure-library-query-run-v1.txt`

## Claim under review (W6-19)

1) **Implementation correctness:** The slope constraint added to the SOCP is the correct linear translation of
$$A'(0)=\\frac{1}{\\pi}\\int_{4}^{\\infty} ds\\,\\frac{{\\rm Im}A(s)}{s^2}$$
in the campaign’s $m_\\pi=1$ units (with explicit tail subtraction), and the chosen target
$$f_1:=\\frac{dA}{ds}\\Big|_{0}=\\frac{m_\\pi^2}{m_{f_2}^2}$$
with tolerance derived from $m_{f_2}=(1.275\\pm0.020)\\,\\mathrm{GeV}$ is consistent with arXiv:2507.05375 Eq. `Aslope`/`TMD`.

2) **Result is a valid negative result:** Under the current convex constraint stack, adding this slope input makes the model INFEASIBLE (ECOS) in the feasibility solve; therefore no physics bounds are promoted and the result is recorded in a queryable failure library + a NOT_FOR_CITATION neg-results note.

3) **Next-step posture:** Since this is a physics-level incompatibility (not solver noise), the next tightening phase should prioritize diagnosing which load-bearing assumptions drive the mismatch and/or adding the missing low-energy unitarity/threshold-shape input that would make the slope condition meaningful in this framework.

## Reviewer questions

1) Is the slope constraint implementation/units/normalization sound enough to trust the “INFEASIBLE” conclusion?
2) Is the negative-result recording sufficient (failure library + dashboards + report limitation + gates), i.e., VERDICT: READY?
3) What is the sharpest next diagnostic to run (single-knob relaxation: ASR on/off, tail scale_factor scan, eta-profile changes, IR matching tightening, etc.)?
4) What is the most promising physics/maths tightening direction to shrink the $A^\\pi(-Q^2)$ interval substantially (beyond solver choice), consistent with pion-only + no coupled-channel?

## Required verdict format

First line must be exactly `VERDICT: READY` or `VERDICT: NOT_READY`, with no preamble, and include the strict headers required by the contract checker.

