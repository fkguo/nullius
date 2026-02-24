# W6-26 Review Packet (Round-001) — UV/ASR budget gate + extend tightened band to $Q^2=2\,\mathrm{GeV}^2$

NOT_FOR_CITATION. Tools disabled for reviewers.

## What is new in W6-26 (vs W6-25)?

W6-26 is a targeted increment to address two review concerns:

1) **“soft-ASR tol is a knob” needs to be explicit and gate-enforced**  
   Add a machine-checkable UV/ASR budget artifact + schema and enforce it via `validate-project` whenever ASR is used in `compute/*.json`.

2) **Extend the tightened-stack multi-$Q^2$ band to $Q^2=2\,\mathrm{GeV}^2$**  
   Produce a reproducible run + plot(s) reaching $Q^2=2\,\mathrm{GeV}^2$ (and a solver cross-check at the endpoint).

No new physics assumptions are introduced for the band itself: the constraint stack remains the W6-22/23/24 tightened stack (soft ASR tol=62 + slope input). The UV/ASR budget artifact is currently a **placeholder** that makes the knob explicit and quantifies the tail cutoff remainder, but still contains an explicitly unassigned gap to be replaced by an evidence-backed OPE/pQCD budget.

## UV/ASR budget: new schema + artifact + gate

New schema:
- `idea-runs/schemas/uv_asr_budget_v1.schema.json`

New project artifact:
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/assumptions/uv_asr_budget_v1.json`

Gate enforcement:
- `idea-runs/scripts/validate_project_artifacts.py` now requires the budget artifact (and schema-validity) whenever any `compute/*.json` enables `constraints.sum_rules.enforce_asymptotic_sum_rule=true`.

## Literature intake (pQCD chain for 2412)

Added LaTeX-first extraction cards for pQCD sources cited by arXiv:2412.00848:
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/literature/extracts/2101.02395-extraction-card.md`
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/literature/extracts/2203.13493-extraction-card.md`

Local (non-committed) LaTeX caches:
- `/tmp/w6-26-literature/arxiv_src/2101.02395/main.tex`
- `/tmp/w6-26-literature/arxiv_src/2203.13493/mainlong0.tex`

## New computations: extend band to $Q^2=2\,\mathrm{GeV}^2$

Clarabel primary multi-$Q^2$ run:
- Config: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v4cci_dispersion_grid200_enf200_multiq0to2gev_audit9_clarabel_asrband_slope_tmd_asrtol62p0.json`
- Run: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-19-a-bochner-k0-socp-v110-dispersion-grid200-enf200-multiq0to2gev-audit9-clarabel-asrband-slope-tmd-asrtol62p0/results.json`
- Plot: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-19-a-bochner-k0-socp-v110-dispersion-grid200-enf200-multiq0to2gev-audit9-clarabel-asrband-slope-tmd-asrtol62p0/A_band_Q2_GeV2_0to2.png`

ECOS endpoint cross-check:
- Config: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v4ccj_dispersion_grid200_enf200_q2_2gev_audit9_ecos_asrband_slope_tmd_asrtol62p0.json`
- Run: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-19-a-bochner-k0-socp-v111-dispersion-grid200-enf200-q2-2gev-audit9-ecos-asrband-slope-tmd-asrtol62p0/results.json`

Selected endpoint numbers at $Q^2=2\,\mathrm{GeV}^2$:

| solver | $A_{\min}$ | $A_{\max}$ | status |
|---|---:|---:|---|
| Clarabel (v110) | 0.4074603 | 0.4505559 | OPTIMAL/OPTIMAL |
| ECOS (v111) | 0.4122900 | 0.4447687 | OPTIMAL/OPTIMAL |

Relative deltas are at the $\sim 1\%$ level (see evidence note below).

Plotting helper (new, project-local):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/plot_socp_band.py`

Evidence note (plot paths + cross-solver numbers + reproduction commands):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/2026-02-19-w6-26-q2-0to2gev-band-plot-and-crosscheck-v1.md`

Manuscript updated:
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/reports/draft.md` (adds W6-26 bullet)

## Gates executed (PASS)

- `docs/reviews/bundles/2026-02-19-w6-26-idea-generator-validate-v1.txt`
- `docs/reviews/bundles/2026-02-19-w6-26-idea-runs-validate-v1.txt`
- `docs/reviews/bundles/2026-02-19-w6-26-idea-runs-validate-project-v1.txt`
- `docs/reviews/bundles/2026-02-19-w6-26-failure-library-index-build-v1.txt`
- `docs/reviews/bundles/2026-02-19-w6-26-failure-library-query-run-v1.txt`

## Questions for reviewers

1) Is the new UV/ASR budget gate correctly scoped and fail-closed (without accidentally forbidding legitimate sensitivity scans)?
2) Is the “placeholder budget with explicit unassigned gap” phrasing sufficiently cautious to prevent over-claiming from tightened bands?
3) Is the $Q^2=2\,\mathrm{GeV}^2$ extension + ECOS cross-check adequate as a first deliverable, or are additional robustness checks required before marking W6-26 `READY`?

