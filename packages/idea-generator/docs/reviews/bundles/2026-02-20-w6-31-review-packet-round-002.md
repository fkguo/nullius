# W6-31 Review Packet (Round-002) — $\hat\Theta^\pi(-Q^2)$ band + derived $D^\pi(-Q^2)$ band

NOT_FOR_CITATION. Tools disabled for reviewers.

## Purpose

Add a second independent pion GFF target beyond $A^\pi(-Q^2)$, in a way that stays:
- pion-only,
- no coupled-channel,
- laptop-feasible,
- evidence-closed-loop.

Deliverables under review:
1) a trace/Theta band for $\hat\Theta^\pi(-Q^2)\equiv \Theta^\pi(-Q^2)/m_\pi^2$ in the scalar ($S0$) channel, and  
2) a derived conservative band for the $D$-term $D^\pi(-Q^2)$ using the exact algebraic relation among $(A,\Theta,D)$.

## What changed since Round-001 (addresses Opus blockers)

1) **Audit: explicit sum-rule value/target in residuals.**  
   The Theta kernel now records `norm_value`, `norm_target`, and their “per-$\pi$” versions in `results.json` residuals for feasibility and for each per-$Q^2$ min/max solve. This makes the “mass sum rule (grid+tail split)” auditable without re-deriving conventions from code.

2) **Band-width diagnostic table added (low-$Q^2$).**  
   We include a table (shared scan grid points) showing that the current Im-only cone yields a very wide $\hat\Theta$ band already at low $Q^2$; therefore the derived $D$ envelope is also wide. The deliverable is framed as a **pipeline proof-of-concept** until PV-modulus tightening (or additional physics inputs) makes it informative.

3) **D-envelope rule clarified (sign analysis).**  
   The derivation script includes an explicit sign analysis for the envelope rule: for $q^2>0$, the coefficient of $\hat\Theta$ is positive while the coefficient of $A$ is negative, so $D_{\min}$ uses $(\hat\Theta_{\min},A_{\max})$ and $D_{\max}$ uses $(\hat\Theta_{\max},A_{\min})$.

4) **D postprocess now restricts to the intersection grid.**  
   If the Theta scan contains extra audit points not present in the A scan, the D postprocess skips them (records `skipped_q2_missing_in_a`) and proceeds on the shared grid (outer bound on that grid).

## Constraint stack (trace band)

Scope: pion-only; no coupled-channel.

Trace/Theta_hat run used for the claimed deliverable (Clarabel; Im-only cone):
- Run: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-20-theta-trace-s0-socp-v1c-imonly-grid200-multiq0to2gev-audit2-clarabel-pqcdTh/`
- Config: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/theta_trace_s0_socp_config_v1c_imonly_grid200_multiq0to2gev_audit2_clarabel_pqcdTh.json`

Inputs/assumptions encoded in the config:
- Mass sum rule: $\hat\Theta^\pi(0)=2$ (arXiv:2412.00848 Eq. `thsr`), enforced exactly as $(1/\pi)\int ds\,{\rm Im}\hat\Theta(s)/s=2$ (grid+tail split).
- No ASR: per arXiv:2412.00848 discussion (Im$\Theta$ decays too slowly for an ASR); therefore we do **not** impose any $\int ds\,{\rm Im}\Theta(s)=0$ constraint.
- UV tail model: pQCD time-like ${\rm Im}\,\Theta(s)$ (arXiv:2412.00848 Eq. `imTh`) used as a fixed tail contribution beyond $s_{\max}=s_0$.
- GTB-style inequality: pointwise modulus cone (Im-only), $\rho(s_i)\ge ({\rm Im}\,\hat\Theta(s_i))^2/c_{\rm fac}(s_i)$ with
  $$c_{\rm fac}(s)=\frac{1+\eta(s)}{2}\frac{1}{\mathrm{scale}_{S0}(s)^2}.$$
  Here `scale_S0(s)` uses arXiv:2403.10772 Eq. (FFS0scale), and $\eta(s)$ is a piecewise-constant envelope (`eta_floor_0p6`).

Negative result (numerics):
- PV dispersion tightening + full modulus cone (`dispersion_reF.enabled=true`) in v1 terminates Clarabel feasibility with `NUMERICAL_ERROR`:
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-20-theta-trace-s0-socp-v1-dispersion-grid200-enf200-multiq0to2gev-audit1-clarabel-pqcdTh/`
  - Recorded as a failure-library entry and not used for the claimed deliverable.

## Derived $D^\pi(-Q^2)$ band (exact algebra; conservative envelope)

Exact identity used:
$$
D^\pi(-Q^2)=\frac{2\hat\Theta^\pi(-Q^2)-(4+q^2)\,A^\pi(-Q^2)}{3q^2},\qquad q^2\equiv Q^2/m_\pi^2,\ q^2>0.
$$

Envelope rule (with explicit coefficient-sign justification in the script):
- $D_{\min}$ uses $\hat\Theta_{\min}$ and $A_{\max}$.
- $D_{\max}$ uses $\hat\Theta_{\max}$ and $A_{\min}$.

This is explicitly an **outer bound** (no correlation assumed between the independent bands).

Derived run:
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-20-d-band-v1b-from-a-v118-theta-v1c/`

Inputs:
- $A^\pi(-Q^2)$ band: Clarabel v118 (binding UV/ASR budget + derived UV anchor budget):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-20-a-bochner-k0-socp-v118-dispersion-grid200-enf200-multiq0to2gev-audit12-clarabel-asrbinding-uvbudget-derived-impliedf1-pqcdA10gev-anchorbudget-derived-bind/`
- $\hat\Theta^\pi(-Q^2)$ band: Clarabel v1c:
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-20-theta-trace-s0-socp-v1c-imonly-grid200-multiq0to2gev-audit2-clarabel-pqcdTh/`

## Key results (band endpoints; plus “un-informativeness” evidence)

At $Q^2=2\,\mathrm{GeV}^2$ ($q^2\simeq 102.6705$):
- $A^\pi(-Q^2)\in[-0.02345,\ 0.29380]$ (v118)
- $\hat\Theta^\pi(-Q^2)\in[-65.97,\ 66.41]$ (v1c)
- $D^\pi(-Q^2)\in[-0.530,\ 0.439]$ (derived band)

Band-width diagnostic table (shared scan grid, $Q^2=k/64\,\mathrm{GeV}^2$):

| $Q^2$ [GeV$^2$] | $q^2$ | $\hat\Theta_{\min}$ | $\hat\Theta_{\max}$ | $D_{\min}$ | $D_{\max}$ |
|---:|---:|---:|---:|---:|---:|
| 0.046875 | 2.40634 | -25.2289 | 28.8957 | -7.83814 | 7.56864 |
| 0.09375 | 4.81268 | -40.846 | 44.2319 | -6.21715 | 5.95973 |
| 0.25 | 12.8338 | -64.2152 | 66.91 | -3.68584 | 3.46006 |
| 0.5 | 25.6676 | -74.5826 | 76.6 | -2.19185 | 2.00163 |
| 1 | 51.3353 | -75.3477 | 76.5828 | -1.15076 | 1.01096 |
| 2 | 102.671 | -65.9729 | 66.4108 | -0.530127 | 0.439344 |

**Claim framing for reviewers:** this Round-002 packet treats the trace/$D$ constraints as a *pipeline proof-of-concept* under an Im-only cone. We do **not** claim the current band is physically competitive.

## Sum-rule audit (explicit numbers; grid+tail split)

At the $Q^2=2\,\mathrm{GeV}^2$ point:
- grid target (per-$\pi$): $3.035528136633803$
- grid value (per-$\pi$, min/max): $3.035528136633357$, $3.035528136633694$
- tail (per-$\pi$): $-1.035528136633802$
- total (per-$\pi$, min/max): $1.999999999999555$, $1.999999999999892$

## Artifacts (plots)

- $\hat\Theta$ plot:  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-20-theta-trace-s0-socp-v1c-imonly-grid200-multiq0to2gev-audit2-clarabel-pqcdTh/Theta_hat_band_Q2_GeV2_0to2.png`
- $D$ plot:  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-20-d-band-v1b-from-a-v118-theta-v1c/D_band_Q2_GeV2_0.015625to2.png`

## Gates executed (PASS)

NOTE: we will re-run receipts after committing the updated artifacts for W6-31 Round-002.

## PV-tightening recovery plan (concrete next steps)

Goal: make `dispersion_reF.enabled=true` feasible (and stable) for the trace channel.

Proposed sequence (laptop-feasible):
1) Reduce PV/modulus enforcement density: enforce modulus only on a sparse subset of $s$ points (e.g. 40 instead of 200), then sweep upward until failure to locate the conditioning threshold.
2) Apply the same conditioning trick used in $A$ (W6-11): switch to an Im-variable scaling (optimize in $z_i=\mathrm{Im}\hat\Theta(s_i)/\sqrt{c_{\rm fac}(s_i)}$) so the cone becomes $\rho_i\ge z_i^2$ with better conditioning.
3) Try solver cross-checks and attributes: ECOS as a spot-check feasibility solver; Clarabel with more conservative tolerances/regularization if exposed.
4) If still `NUMERICAL_ERROR`, shrink grid (e.g. `n_points=120`) and confirm whether the issue is purely discretization/conditioning.

## Reviewer questions

1) Is the “proof-of-concept only” framing now accurate and safe (no overclaiming)?
2) Are the sum-rule audit numbers sufficient and correctly interpreted (grid+tail split)?
3) Is the D envelope labeling + sign analysis sufficient to prevent misinterpretation?
4) Does the PV-recovery plan look concrete and technically appropriate for the observed `NUMERICAL_ERROR`?

