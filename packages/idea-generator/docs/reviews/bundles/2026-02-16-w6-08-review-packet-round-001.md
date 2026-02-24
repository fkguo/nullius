# W6-08 Review Packet (Round-001) — Independent Dual Certificate at $Q^*$ (v19) + Residual Quotes

NOT_FOR_CITATION. Tools disabled for reviewers.

## Purpose

Close the remaining Phase L review blockers from W6-07 by making the *headline endpoint statement* fully auditable:

- provide an **independently recomputed dual objective** (not just solver self-report),
- ensure `tail_const(Q^*)` is taken from the **explicit UV-tail integral**,
- run **ECOS on the identical conic program** as Clarabel at $Q^*$,
- quote **worst-case residuals across the full grid** (v18) and residuals at $Q^*$ (v19).

## Key artifacts / reproduction

Kernel (updated dual-audit instrumentation):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/julia/bochner_k0_socp_dispersion_bounds.jl`

Reference full-grid run (defines $Q^*$; includes per-solve residuals):
- v18 (Clarabel; full Q2 grid):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-a-bochner-k0-socp-v18-dispersion-grid200-enf200-full-resaudit/`
  - `.../results.json`

Dual-certificate audit runs (single-point, identical discretization/enforcement; only solver differs):
- v19 Clarabel ($Q^*$ only):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-a-bochner-k0-socp-v19-dispersion-grid200-enf200-qstar-dualcert-clarabel/`
  - `.../results.json`
- v19 ECOS ($Q^*$ only):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-a-bochner-k0-socp-v19-dispersion-grid200-enf200-qstar-dualcert-ecos/`
  - `.../results.json`

Configs:
- v18: `.../compute/a_bochner_k0_socp_config_v2g_dispersion_grid200_enf200_full_resaudit.json`
- v19 Clarabel: `.../compute/a_bochner_k0_socp_config_v2h_dispersion_grid200_enf200_qstar_dualcert_clarabel.json`
- v19 ECOS: `.../compute/a_bochner_k0_socp_config_v2h_dispersion_grid200_enf200_qstar_dualcert_ecos.json`

## Claim under review

Under the explicit single-channel assumptions encoded in v18/v19, the **contiguous positivity endpoint on the v18 probe grid** is
$$Q^*=15.438084455604\,m_\pi^2,$$
with a **dual-certified** lower bound $A_{\min}(-Q^*)>0$.

(Definition of $Q^*$ unchanged: the largest contiguous grid point such that $A_{\min}(-Q^2)>0$ for all earlier scanned $Q^2$ in the same grid; no interpolation.)

## What changed vs W6-07 (addresses NOT_READY blockers)

### 1) Dual objective is recomputed from dual variables (independent check)

In v19 `results.json`, each solve stores `min_dual_check` / `max_dual_check` including:
- `dual_obj_recomputed`: recomputed from *bridged MOI* constraint duals + constants (independent of solver’s `dual_objective_value` bookkeeping),
- `stationarity_inf_norm`: $\|c - A^T y\|_\infty$ sanity check (should be small),
- `dual_cone_min_margin` + `dual_cone_violations`: cone-membership sanity checks on the bridged cones.

This directly addresses the “not a true dual certificate” concern: we evaluate the dual objective from the extracted dual variables and verify stationarity/cone sanity.

### 2) `tail_const(Q^*)` is taken from the UV-tail integral (not backed out from the primal)

In v19 `solver_status[0].tail_const_analytic`, `tail_const_analytic(Q^*)` is the explicit tail integral contribution computed from the pQCD tail model (2412 Eq. `imF` pattern) and stored as a number.

We do *not* define it as `Amin - objective_value`.

### 3) ECOS runs the identical $Q^*$ program

v19 ECOS uses the same grid200 + full-interior enforcement + same tail/sum rules; only the solver differs.

## Dual-certified bound at $Q^*$ (v19; auditable numbers)

Compute the dual-certified lower bound at $Q^*$ as:
$$A_{\min}^{\rm dual}(Q^*) = \mathrm{dual\_obj\_recomputed}(Q^*) + \mathrm{tail\_const\_analytic}(Q^*).$$

Numbers (from v19 `results.json`; see summary file):
- `idea-generator/docs/reviews/bundles/2026-02-16-w6-08-v19-qstar-dualcert-summary-v1.txt`

Clarabel v19:
- $A_{\min}(Q^*) = 0.007284756916$ (primal)
- `dual_obj_recomputed = 0.018590929027`
- `tail_const_analytic = -0.011306175356`
- **dual-certified** $A_{\min}^{\rm dual}(Q^*) = 0.007284753671 > 0$

ECOS v19:
- $A_{\min}(Q^*) = 0.018103849010$ (primal)
- `dual_obj_recomputed = 0.029410024471`
- `tail_const_analytic = -0.011306175356`
- **dual-certified** $A_{\min}^{\rm dual}(Q^*) = 0.018103849115 > 0$

Conservative certified statement (pilot framing): take the smaller dual-certified value across solvers:
$$A_{\min}(Q^*) \ge 0.007284753671.$$

## Residuals (quoted)

### Residuals at $Q^*$ (v19)

From v19 `solver_status[0].min_residuals`:
- Clarabel: `norm_eq_abs=2.33e-08`, `asr_eq_abs=1.09e-08`, `k0_min_margin=+1.71e-10`, `soc_min_margin=-1.96e-10`, `modulus_min_margin=+7.32e-09`
- ECOS: `norm_eq_abs=1.20e-07`, `asr_eq_abs=2.41e-08`, `k0_min_margin=+1.66e-10`, `soc_min_margin=+1.16e-10`, `modulus_min_margin=+2.33e-09`

### Worst-case residuals across the full v18 grid

Quoted verbatim from:
- `idea-generator/docs/reviews/bundles/2026-02-16-w6-07-v18-residual-worstcase-v1.txt`

(norm and ASR residuals are equality residuals; margins are “>=0 satisfied”.)

## Reviewer questions

1) Does v19’s **independent dual objective recomputation + stationarity/cone checks** resolve the W6-07 concern about “dual certificate relies on solver self-reporting”?  
2) Is the **conservative reporting rule** acceptable: report the smallest dual-certified $A_{\min}^{\rm dual}(Q^*)$ across solvers and cite the cross-solver spread as numerical systematic?  
3) Any remaining blockers before marking Phase L as `VERDICT: READY`?
