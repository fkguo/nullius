# W6-33 Review Packet (Round-001) — Trace $\hat\Theta^\pi$ UV anchor budget (derived+binding) $\rightarrow$ rerun $\rightarrow$ updated $D^\pi(-Q^2)$ envelope

NOT_FOR_CITATION. Tools disabled for reviewers.

## Purpose

Tighten the pion trace-channel ($S0$) band by adding an explicit, machine-checkable **UV value-anchor** for $\hat\Theta^\pi(-Q^2)$ (rather than treating the UV tail as “exact”/implicit), and propagate the improved trace band into an updated conservative $D^\pi(-Q^2)$ envelope.

Hard scope constraints remain fixed:
- pion-only,
- no coupled-channel,
- laptop-feasible,
- evidence-closed-loop (configs/runs/evidence notes + gate receipts).

## What changed vs W6-32

1) **Trace-channel UV anchor budget + binding gate (new).**  
   We add a new budget artifact `uv_theta_anchor_budget_v1.json` (schema + builder + validate-project enforcement). Any compute config that opts into binding must match the derived budget numerically (target + tolerance).

2) **New PV-tightened $\hat\Theta^\pi(-Q^2)$ run including the UV anchor point.**  
   Uses the same PV dispersion + modulus cone (sparse enforcement `n_enforce=30`) but now includes a UV value-band constraint at $Q^2=10\,\mathrm{GeV}^2$.

3) **Updated derived $D^\pi(-Q^2)$ envelope.**  
   Keep the same $A^\pi(-Q^2)$ band (v118) and recompute the conservative $D$ outer envelope using the updated $\hat\Theta$ band.

## Constraint stack (trace band)

Trace/Theta_hat run (Clarabel; dispersion + modulus + UV value band):
- Run: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-20-theta-trace-s0-socp-v3-dispersion-grid200-enf30-multiq0to2gev-audit2-clarabel-pqcdTh-anchorbudget-derived-bind/`
- Config: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/theta_trace_s0_socp_config_v3_dispersion_grid200_enf30_multiq0to2gev_audit2_clarabel_pqcdTh_anchorbudget_derived_bind.json`

Inputs/assumptions (encoded in the config):
- Mass sum rule: $\hat\Theta^\pi(0)=2$ (arXiv:2412.00848 Eq. `thsr`), implemented as $(1/\pi)\int ds\,{\rm Im}\hat\Theta(s)/s=2$ (grid+tail split).
- No ASR for $\Theta$: per arXiv:2412.00848 discussion; we do **not** impose any $\int ds\,{\rm Im}\Theta(s)=0$ constraint.
- UV tail model: LO pQCD time-like ${\rm Im}\,\Theta(s)$ (arXiv:2412.00848 Eq. `imTh`) used as a fixed tail contribution beyond $s_{\max}=s_0$.
- GTB-style inequality (principal-minor consequence): always enforce the Im-only cone $\rho(s_i)\ge ({\rm Im}\,\hat\Theta(s_i))^2/c_{\rm fac}(s_i)$ with piecewise-constant $\eta(s)$ (`eta_floor_0p6`).
- PV dispersion reconstructs ${\rm Re}\,\hat\Theta(s_i)$ from ${\rm Im}\,\hat\Theta$ on the same grid, and enforces the full modulus cone
  $$({\rm Re}\,\hat\Theta)^2+({\rm Im}\,\hat\Theta)^2\le c_{\rm fac}(s)\,\rho(s)$$
  on a sparse subset (`n_enforce=30`).

New in W6-33 (physics input):
- UV value-band constraint at $Q^2=10\,\mathrm{GeV}^2$ on $\hat\Theta^\pi(-Q^2)$ using arXiv:2412.00848 Eq. `QTh` (LO) with a **derived uncertainty budget** and **gate-enforced binding**:
  - Budget artifact: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/assumptions/uv_theta_anchor_budget_v1.json`
  - Schema: `idea-runs/schemas/uv_theta_anchor_budget_v1.schema.json`
  - Builder: `idea-runs/scripts/build_uv_theta_anchor_budget_v1.py`
  - Gate: `idea-runs/scripts/validate_project_artifacts.py` (binding checks).

## Derived $D^\pi(-Q^2)$ band (exact algebra; conservative envelope)

Exact identity used:
$$
D^\pi(-Q^2)=\frac{2\hat\Theta^\pi(-Q^2)-(4+q^2)\,A^\pi(-Q^2)}{3q^2},\qquad q^2\equiv Q^2/m_\pi^2,\ q^2>0.
$$

Envelope rule:
- $D_{\min}$ uses $\hat\Theta_{\min}$ and $A_{\max}$.
- $D_{\max}$ uses $\hat\Theta_{\max}$ and $A_{\min}$.

Derived run (updated):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-20-d-band-v1d-from-a-v118-theta-v3/`

Inputs:
- $A^\pi(-Q^2)$ band (unchanged): Clarabel v118 (binding UV/ASR budget + derived UV anchor budget):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-20-a-bochner-k0-socp-v118-dispersion-grid200-enf200-multiq0to2gev-audit12-clarabel-asrbinding-uvbudget-derived-impliedf1-pqcdA10gev-anchorbudget-derived-bind/`
- $\hat\Theta^\pi(-Q^2)$ band: new v3 (this increment).

## Key numbers (audit point: $Q^2=2\,\mathrm{GeV}^2$)

At $Q^2=2\,\mathrm{GeV}^2$ ($q^2\simeq 102.6705$):
- $\hat\Theta^\pi(-Q^2)\in[-14.64,\ 11.67]$ (v3; PV-tightened + UV anchor binding)
- Previous (v2; PV-tightened but no UV anchor): $\hat\Theta^\pi(-Q^2)\in[-61.74,\ 61.99]$

Updated derived envelope:
- $D^\pi(-Q^2)\in[-0.1968,\ 0.0839]$ (v1d; updated)
- Previous (v1c): $D^\pi(-Q^2)\in[-0.503,\ 0.411]$

Anchor check at $Q^2=10\,\mathrm{GeV}^2$:
- v3 band gives $\hat\Theta^\pi(-Q^2)\in[-1.8677,\ -0.3629]$, saturating the derived budget interval around the LO pQCD central value.

Interpretation: this is a **physics-tightening** increment, but still **systematics-dominated** because the UV tolerance is a named proxy budget (not yet a full OPE/pQCD error propagation).

## Artifacts (plots)

- $\hat\Theta$ (full; includes UV anchor point):  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-20-theta-trace-s0-socp-v3-dispersion-grid200-enf30-multiq0to2gev-audit2-clarabel-pqcdTh-anchorbudget-derived-bind/Theta_hat_band_Q2_GeV2_0to10.png`
- $\hat\Theta$ (zoom; $Q^2\le 2\,\mathrm{GeV}^2$):  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-20-theta-trace-s0-socp-v3-dispersion-grid200-enf30-multiq0to2gev-audit2-clarabel-pqcdTh-anchorbudget-derived-bind/Theta_hat_band_Q2_GeV2_0to2_zoom.png`
- $D$ (full):  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-20-d-band-v1d-from-a-v118-theta-v3/D_band_Q2_GeV2_0.015625to10.png`
- $D$ (zoom; $Q^2\le 2\,\mathrm{GeV}^2$):  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-20-d-band-v1d-from-a-v118-theta-v3/D_band_Q2_GeV2_0to2_zoom.png`

## Evidence note (repro commands + budget)

- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/2026-02-20-w6-33-theta-uv-anchor-budget-binding-rerun-v1.md`

## Reviewer questions

1) Is the UV anchor budget/binding story clearly separated from solver/numerics knobs (no overclaiming)?
2) Is the new tightening “real physics input” (pQCD asymptotics with explicit budget) and not a hidden hand-tuning knob?
3) Are the budget components/conservativeness clearly stated and auditable?
4) What is the highest-leverage next tightening step within pion-only / no coupled-channel (additional low-energy input? alternative kernels? more UV constraints?)?

