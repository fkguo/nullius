Scope: pion-only; no coupled-channel.
Deliverables: machine-checkable islands/opportunity artifacts + gate enforcement; reproducible bootstrap constraint stronger/different than current literature; NOT_FOR_CITATION draft report in idea-runs.
SSOT: idea-generator/docs/plans/2026-02-12-implementation-plan-tracker.md (Update Log + evidence).
Project: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15

Evidence (Phase D incremental, 2026-02-16):
- LP run: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-d0-spectral-lp-v2/
- Eta-envelope run: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-d0-eta-envelope-v1/
- Dual review convergence (LP): idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-d-review-convergence-v1.txt
- Dual review convergence (eta): idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-d-eta-envelope-review-convergence-v1.txt
- Gates: idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-d-idea-runs-validate-project-v2.txt
- Board snapshot (post-update): idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-d-board-sync-check-v2.txt

Evidence (Lit expansion + 2412 positivity intake, 2026-02-16):
- arXiv scout log: idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-d-arxiv-scout-v1.txt
- Related-work map: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/literature/related/2026-02-16-related-work-map.md
- Extraction cards: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/literature/extracts/2412.00848-extraction-card.md; idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/literature/extracts/2307.11707-extraction-card.md
- Island: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/islands/plans/island-ecosystem-benchmarks/idea_island_plan_v1.json
- Opportunity pool: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/opportunities/bootstrap_opportunity_pool_v1.jsonl
- Dual review convergence: idea-generator/docs/reviews/bundles/2026-02-16-w6-01-lit-expansion-review-convergence-v1.txt
- Gates: idea-generator/docs/reviews/bundles/2026-02-16-w6-01-lit-expansion-idea-runs-validate-project-v3.txt

Evidence (Bochner/K0 transverse-positivity LP, 2026-02-16):
- Compute kernel: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_lp.py
- v1 run: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-a-bochner-k0-lp-v1/
- v2 run (adds pQCD tail from 2412 Eq. imF): idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-a-bochner-k0-lp-v2/
- Dual review convergence: idea-generator/docs/reviews/bundles/2026-02-16-w6-01-bochner-pos-review-convergence-v1.txt
- Gates: idea-generator/docs/reviews/bundles/2026-02-16-w6-01-bochner-pos-idea-runs-validate-project-v4.txt

Evidence (Elastic-window ImA(s)>=0 tightening for Bochner/K0 LP, 2026-02-16):
- Constraint source: arXiv:2412.00848 (Elastic region and threshold behavior; Watson + attractive phase => ImA(s)>=0 up to 4 m_K^2)
- v3 config: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_lp_config_v3.json
- v3 run: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-a-bochner-k0-lp-v3-elastic-impos/
- Dual review convergence: idea-generator/docs/reviews/bundles/2026-02-16-w6-01-elastic-impos-review-convergence-v1.txt
- Gates: idea-generator/docs/reviews/bundles/2026-02-16-w6-01-elastic-impos-idea-runs-validate-project-v1.txt

Evidence (W6-04 IR-matched GTB envelope + stronger Bochner/K0 bounds, 2026-02-16):
- Review packet (Round-002): idea-generator/docs/reviews/bundles/2026-02-16-w6-04-review-packet-round-002.md
- Dual review convergence (review-swarm; Round-003): idea-generator/docs/reviews/bundles/2026-02-16-w6-04-review-convergence-v1.txt
- Gates (validate/validate-project/failure hook):
  - idea-generator/docs/reviews/bundles/2026-02-16-w6-04-idea-generator-validate-v2.txt
  - idea-generator/docs/reviews/bundles/2026-02-16-w6-04-idea-runs-validate-project-v2.txt
  - idea-generator/docs/reviews/bundles/2026-02-16-w6-04-failure-library-query-run-v2.txt
- New runs (idea-runs project):
  - D0 rho envelope with IR matching: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-d0-spectral-lp-v3-ir-match-v1/
  - Eta-envelope on IR-matched input: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-d0-eta-envelope-v2-ir-match-v1/
  - Bochner/K0 LP with IR-matched envelope: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-a-bochner-k0-lp-v4-ir-envelope-bmin0p08/
  - Robustness scans:
    - s_max scan: v6 (16), v7 (25), v8 (36), v4 (50)
    - IR scale_factor scan: 5000/8000/10000/12000 (both s_max=36 and s_max=50)
- Report updated (NOT_FOR_CITATION): idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/reports/draft.md

Evidence (W6-05 scale_factor=1 hardening + dashboards gate, 2026-02-16):
- Summary table: idea-generator/docs/reviews/bundles/2026-02-16-w6-05-scale1-regulator-scan-summary-v1.txt
- Dual review convergence: idea-generator/docs/reviews/bundles/2026-02-16-w6-05-review-convergence-v1.txt
- Gates:
  - idea-generator/docs/reviews/bundles/2026-02-16-w6-05-idea-generator-validate-v1.txt
  - idea-generator/docs/reviews/bundles/2026-02-16-w6-05-idea-runs-validate-project-v1.txt
  - idea-generator/docs/reviews/bundles/2026-02-16-w6-05-failure-library-query-run-v1.txt
- New runs (idea-runs project):
  - D0 spectral LP (scale=1): idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-d0-spectral-lp-v2-ir-scale1-cmax20000/
  - D0 eta-envelope (scale=1): idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-d0-eta-envelope-v3-scale1-cmax20000/
  - Bochner/K0 bounds (scale=1): idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-a-bochner-k0-lp-v10-eta-v3-scale1-cmax20000/
- Dashboards + validate-project enforcement:
  - renderer: idea-runs/scripts/render_project_dashboards.py
  - islands dashboard: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/islands/islands_dashboard_v1.md
  - opportunity dashboard: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/opportunities/opportunities_dashboard_v1.md
- Workflow/tooling notes: idea-generator/docs/plans/2026-02-16-w6-05-tooling-usage-and-gaps.md

Evidence (Phase H: eta-profile sensitivity + lattice overlay, 2026-02-16):
- Board sync preflight: idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-h-board-sync-preflight-v1.txt
- Gates (idea-generator): idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-h-idea-generator-validate-v1.txt
- Gates (idea-runs):
  - idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-h-idea-runs-validate-project-v2.txt
  - idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-h-failure-library-query-run-v2.txt
- Eta sensitivity summary (same tail+elastic sign; different envelope_profile_id):
  - idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-h-eta-sensitivity-summary-v1.txt
  - v11 run (elastic_only): idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-a-bochner-k0-lp-v11-eta-v3-scale1-cmax20000-elastic-only/
  - v12 run (eta_floor_0p8): idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-a-bochner-k0-lp-v12-eta-v3-scale1-cmax20000-eta-floor-0p8/
- Lattice overlay (benchmark-only; 2307.11707 monopole params):
  - run: idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-lattice-2307-overlay-v1/
  - plot: .../overlay_A_bounds_vs_lattice.png
- Report updated (NOT_FOR_CITATION): idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/reports/draft.md
- Dashboards refreshed:
  - idea-runs/.../artifacts/islands/islands_dashboard_v1.md
  - idea-runs/.../artifacts/opportunities/opportunities_dashboard_v1.md

Notes:
- New opportunity cards appended: Gram PSD SDP tightening; pinned Julia numerics stack; improved-positivity tail -> eta-envelope.

Evidence (W6-06: dispersion-coupled SOCP + numerics defect closure, 2026-02-16):
- Julia kernel (joint SOCP + PV ReA + modulus cone): idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/julia/bochner_k0_socp_dispersion_bounds.jl
- Configs:
  - idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2_dispersion.json (n_enforce=30)
  - idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2b_dispersion_n60.json (n_enforce=60, best Q2-range)
  - idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2c_dispersion_n90.json (n_enforce=90)
- Runs (idea-runs project):
  - Baseline (Im-only SOCP): .../runs/2026-02-16-a-bochner-k0-socp-v14-eta-v4-abs6e-06/
  - Dispersion-coupled: .../runs/2026-02-16-a-bochner-k0-socp-v15-dispersion-reF-eta-v4-abs6e-06/
  - Dispersion-coupled (n=60): .../runs/2026-02-16-a-bochner-k0-socp-v15b-dispersion-reF-n60/
  - Dispersion-coupled (n=90): .../runs/2026-02-16-a-bochner-k0-socp-v15c-dispersion-reF-n90/
- Key numbers (from results.json):
  - v14: Amin@Q2=10 -> 0.06653; Q2max with Amin>0 -> 13.8995
  - v15b: Amin@Q2=10 -> 0.07244; Q2max with Amin>0 -> 15.4381 (Amin=9.13e-4 at edge)
- Preflight + failure-library hook (post-change): idea-generator/docs/reviews/bundles/2026-02-16-w6-06-idea-runs-preflight-validate-and-failure-hook-v1.txt
- SciPy/HiGHS wrong-optimum repro (critical numerics defect): idea-generator/docs/reviews/bundles/2026-02-16-w6-06-highs-lp-wrong-optimum-repro-v1.txt
- Neg-result writeup + failure entry:
  - idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/neg_results/2026-02-16-highs-lp-wrong-optimum-repro.txt
  - idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/ideas/failed_approach_v1.jsonl
