# W6-04 Review Packet (Round 001) — IR-Matched GTB Envelope + Stronger Bochner/K0 Positivity Bounds on Pion $A^\pi(-Q^2)$

## Scope
W6-04 is a physics + numerics tightening stage for the pion-only / no-coupled-channel bootstrap campaign:

1) Incorporate a **new (latest GTB) ingredient** from arXiv:2505.19332: IR (low-energy) constraints on the D0 spectral density $\rho_2^0(s)$.
2) Propagate the tightened envelope into the **transverse-density positivity LP** (arXiv:2412.00848) to obtain strictly tighter numerical bounds on $A^\pi(-Q^2)$.
3) Record a machine-checkable negative result: naive absolute IR normalization matching is infeasible (normalization mismatch), and close the loop via `failed_approach_v1` + failure-library retrievability.

Hard constraints to keep in mind:
- pion-only; **no coupled-channel execution**
- laptop-only; NOT_FOR_CITATION
- key conclusions must be traceable to code/numerics/literature evidence

## Deliverables (What Exists Now)

### 1) New IR-matching knob for $\rho_2^0(s)$ envelope (latest GTB ingredient)

- Code (now supports `--config` and config-driven `output.run_slug`):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/d0_spectral_lp.py`
- Config implementing IR constraints (scaled pointwise bounds near threshold):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/d0_spectral_lp_config_v2.json`
- Output run (immutable):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-d0-spectral-lp-v3-ir-match-v1/`

Key new input extracted from 2505.19332 (Sec. `Low energy spectral density`):
- $\rho_2^0(s)\sim s^2(1-4/s)^{5/2}$ (in their conventions), encoded as an optional constraint family.

### 2) Eta-envelope postprocess recomputed on the IR-matched input

- Code (now supports `--config` and config-driven run slugs):
  - `idea-runs/.../compute/d0_eta_envelope_postprocess.py`
- Config:
  - `idea-runs/.../compute/d0_eta_envelope_config_v2.json`
- Output run:
  - `idea-runs/.../runs/2026-02-16-d0-eta-envelope-v2-ir-match-v1/`

### 3) Stronger Bochner/K0 LP bounds on $A^\pi(-Q^2)$ using IR-matched envelope

Main run:
- Config:
  - `idea-runs/.../compute/a_bochner_k0_lp_config_v4.json`
- Output:
  - `idea-runs/.../runs/2026-02-16-a-bochner-k0-lp-v4-ir-envelope-bmin0p08/`

Key results (from v4 `results.json`):
- $Q^2=10 m_\pi^2$: $A^\pi(-Q^2)\in[0.0547,\ 0.8588]$
- $Q^2=50 m_\pi^2$: $A^\pi(-Q^2)\in[-0.0600,\ 0.5189]$
- $Q^2=200 m_\pi^2$: $A^\pi(-Q^2)\in[-0.0374,\ 0.1657]$
- **Positive lower bound region (nontrivial):** $A^\pi(-Q^2)\ge 0$ for $Q^2\lesssim 13.9\,m_\pi^2\approx 0.27$ GeV$^2$.

Robustness scan vs elastic-window sign cutoff $s_{\max}$:
- $s_{\max}=16$: `runs/2026-02-16-a-bochner-k0-lp-v6-ir-envelope-smax16/` (at $Q^2=10$: min=-0.0718)
- $s_{\max}=25$: `runs/2026-02-16-a-bochner-k0-lp-v7-ir-envelope-smax25/` (at $Q^2=10$: min=-0.0163)
- $s_{\max}=36$: `runs/2026-02-16-a-bochner-k0-lp-v8-ir-envelope-smax36/` (at $Q^2=10$: min=+0.0211)
- $s_{\max}=50\approx 4(m_K/m_\pi)^2$: v4 (at $Q^2=10$: min=+0.0547)

### 4) Machine-checkable tracking + avoid-repeat closure updated

- Island progress stream appended (3 events):
  - `idea-runs/.../artifacts/islands/idea_island_progress_v1.jsonl`
- Opportunity pool appended (new IR constraint opportunity):
  - `idea-runs/.../artifacts/opportunities/bootstrap_opportunity_pool_v1.jsonl`
  - new ID: `627de170-5220-4549-b711-5d1356bd8fd3`
- Negative result appended (absolute IR normalization infeasible) with evidence note:
  - evidence note: `idea-runs/.../evidence/neg_results/2026-02-16-d0-ir-absolute-matching-infeasible.txt`
  - structured record: `idea-runs/.../artifacts/ideas/failed_approach_v1.jsonl` (tag `failure:normalization_mismatch`)

### 5) Campaign report updated (NOT_FOR_CITATION)

- `idea-runs/.../reports/draft.md` updated with:
  - IR matching description + caveat
  - v4 bounds + positive-lower-bound region
  - s_max robustness scan table

## DoD Checklist (W6-04)
- [x] New constraint wiring implemented as code + configs + immutable runs.
- [x] Bounds are strictly tighter than v3 (documented in report; runs preserved).
- [x] Negative result recorded (failed_approach) and retrievable via failure library hook.
- [x] Gates pass (validate + validate-project + failure library hook).

## Verification Commands + Results

- `idea-generator`: `make validate` => PASS  
  Evidence: `docs/reviews/bundles/2026-02-16-w6-04-idea-generator-validate-v1.txt`

- `idea-runs`: `make validate` => PASS  
  Evidence: `docs/reviews/bundles/2026-02-16-w6-04-idea-runs-validate-v1.txt`

- `idea-runs`: `PROJECT=projects/pion-gff-bootstrap-positivity-pilot-2026-02-15 make validate-project` => PASS  
  Evidence: `docs/reviews/bundles/2026-02-16-w6-04-idea-runs-validate-project-v1.txt`

- `idea-runs`: `make build-failure-library-index` => PASS  
  Evidence: `docs/reviews/bundles/2026-02-16-w6-04-failure-library-index-build-v1.txt`

- `idea-runs`: `PROJECT=projects/pion-gff-bootstrap-positivity-pilot-2026-02-15 make run-failure-library-query` => PASS  
  Evidence: `docs/reviews/bundles/2026-02-16-w6-04-failure-library-query-run-v1.txt`

## Review Focus (What could still be wrong)
1) **Normalization mapping risk**: IR matching currently uses a `scale_factor` knob; is this clearly scoped as a temporary assumption and does the negative-result record close the loop?
2) **Load-bearing assumptions**: are the assumptions for the positive lower bound region (tail model + elastic sign window) explicitly stated and stress-tested enough for NOT_FOR_CITATION claims?
3) **Numerical soundness**: any obvious discretization/solver pathologies (grid dependence, tail integration stability) that should be addressed next?
4) **Novelty**: does combining latest GTB IR constraints with 2412 transverse positivity yield a genuinely “new” constraint pattern worth pursuing to publication-grade (after normalization hardening)?

## Required verdict format
Use strict contract. First line must be exactly `VERDICT: READY` or `VERDICT: NOT_READY`.
