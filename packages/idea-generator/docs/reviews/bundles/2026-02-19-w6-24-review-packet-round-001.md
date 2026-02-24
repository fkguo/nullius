# W6-24 Review Packet (Round-001) — $Q^2/m_\pi^2\in[0,16]$ band plot + constraints clarification

NOT_FOR_CITATION. Tools disabled for reviewers.

## What is new in W6-24 (vs W6-23)?

W6-24 is a **postfix** requested in review:

1) extend the multi-$Q^2$ Clarabel scan to cover **$Q^2/m_\pi^2\in[0,16]$** (include $Q^2=0$ and $Q^2=16$),  
2) save a **band plot** on that interval, and  
3) write an explicit note clarifying **what constraints** define the current band and what is actually “ad hoc” (the soft-ASR tolerance).

No new physics assumptions are introduced: the constraint stack is the same W6-22/23 “tightened stack” (soft ASR band tol=62 + slope input), only the scan grid is extended.

## Baseline numbers (v109; Clarabel)

Selected points from v109 `results.json`:

| $Q^2$ ($m_\pi^2$) | $A_{\min}$ | $A_{\max}$ |
|---:|---:|---:|
| 0.0 | 1.000000000 | 1.000000000 |
| 1.0 | 0.987172732 | 0.988922454 |
| 5.0 | 0.938747344 | 0.947008802 |
| 10.0 | 0.884001582 | 0.899127707 |
| $Q^*=15.438$ | 0.830684547 | 0.851753713 |
| 16.0 | 0.825512026 | 0.847161589 |

Solver-status note: v109 reports `termination_feasibility=ALMOST_OPTIMAL` because the endpoint $Q^2=0$ solve returns `ALMOST_OPTIMAL` (degenerate objective with $A(0)=1$ pinned). The constraint residual audits in `results.json` remain within tolerance; other interior points are `OPTIMAL`.

## Artifacts

Config:
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v4cbh_dispersion_grid200_enf200_multiq0to16_audit8_clarabel_asrband_slope_tmd_asrtol62p0.json`

Run outputs:
- v109 run: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-19-a-bochner-k0-socp-v109-dispersion-grid200-enf200-multiq0to16-audit8-clarabel-asrband-slope-tmd-asrtol62p0/results.json`
- Plot: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-19-a-bochner-k0-socp-v109-dispersion-grid200-enf200-multiq0to16-audit8-clarabel-asrband-slope-tmd-asrtol62p0/A_band_Q2_mpi2_0to16.png`

Clarification note (what constraints define the band / what is ad hoc):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/2026-02-19-w6-24-q2-0to16-band-plot-and-constraints-v1.md`

Manuscript updated:
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/reports/draft.md` (adds a W6-24 bullet referencing v109 + plot + note)

## Gates executed (PASS)

- `docs/reviews/bundles/2026-02-19-w6-24-idea-generator-validate-v1.txt`
- `docs/reviews/bundles/2026-02-19-w6-24-idea-runs-validate-v1.txt`
- `docs/reviews/bundles/2026-02-19-w6-24-idea-runs-validate-project-v1.txt`
- `docs/reviews/bundles/2026-02-19-w6-24-failure-library-index-build-v1.txt`
- `docs/reviews/bundles/2026-02-19-w6-24-failure-library-query-run-v1.txt`
- `docs/reviews/bundles/2026-02-19-w6-24-render-dashboards-v1.txt`

## Question for reviewers

Given the above artifacts, is W6-24 `READY` as a postfix deliverable (plot + constraints clarification), and is the “what is ad hoc vs what is physical” explanation appropriately cautious and accurate?

