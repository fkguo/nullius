# W6-23 Review Packet (Round-002) — cross-solver + tail + ASR-tol robustness added

NOT_FOR_CITATION. Tools disabled for reviewers.

## Additions since Round-001 (addresses Opus blockers)

1) **ECOS cross-check at interior $Q^2$ points** (v101): sparse $Q^2\\in\\{1,5,10,Q^*\\}$ with eps_abs=eps_rel=1e-9.
2) **Tail-scale propagation across $Q^2$** (v102/v103): `tail.scale_factor∈{0.8,1.2}` on the same 4-point set (Clarabel).
3) **ASR tolerance spot-check** (v104/v105): `asr_absolute_tolerance∈{50,80}` at $Q^2\\in\\{1,Q^*\\}$ (Clarabel).
4) **Solver-status audit**: for the baseline v100 52-point curve, all points report `OPTIMAL` for both min/max solves.
5) Evidence note v2 with full tables.

## Baseline (Clarabel v100; tol=62; tail=1.0)

Selected points from v100 `results.json`:

| $Q^2$ ($m_\pi^2$) | $A_{\min}$ | $A_{\max}$ |
|---:|---:|---:|
| 1.0 | 0.987172732 | 0.988922454 |
| 5.0 | 0.938747344 | 0.947008802 |
| 10.0 | 0.884001582 | 0.899127707 |
| $Q^*=15.438$ | 0.830684547 | 0.851753713 |

## (1) ECOS cross-check (v101; tol=62; tail=1.0)

ECOS v101 vs Clarabel v100 deltas in $A_{\max}$:

| $Q^2$ | Clarabel v100 $A_{\max}$ | ECOS v101 $A_{\max}$ | $\Delta A_{\max}$ |
|---:|---:|---:|---:|
| 1.0 | 0.988922454 | 0.988234869 | $-6.88\\times 10^{-4}$ |
| 5.0 | 0.947008802 | 0.946516699 | $-4.92\\times 10^{-4}$ |
| 10.0 | 0.899127707 | 0.899814891 | $+6.87\\times 10^{-4}$ |
| $Q^*$ | 0.851753713 | 0.852443270 | $+6.90\\times 10^{-4}$ |

Interpretation: cross-solver deltas at these interior points are $\\mathcal{O}(10^{-4}\\text{–}10^{-3})$, consistent with the known W6-22 cross-solver spread at $Q^*$, and smaller than the dominant UV/model systematics (tail + ansatz, few $10^{-3}$ near $Q^*$).

## (2) Tail-scale propagation (Clarabel v102/v103; tol=62)

Tail envelope for $A_{\max}$ at representative points:

| $Q^2$ | $A_{\max}$ (tail=0.8) | $A_{\max}$ (tail=1.0) | $A_{\max}$ (tail=1.2) |
|---:|---:|---:|---:|
| 1.0 | 0.988666482 | 0.988922454 | 0.989137512 |
| 5.0 | 0.945821343 | 0.947008802 | 0.948019480 |
| 10.0 | 0.896878633 | 0.899127707 | 0.900973160 |
| $Q^*$ | 0.848622730 | 0.851753713 | 0.854507878 |

Observation: tail sensitivity grows with $Q^2$ and becomes a few-$10^{-3}$ effect on $A_{\max}$ near $Q^*$.

## (3) ASR tolerance spot-check (Clarabel v104/v105)

$A_{\max}$ at two points for tol=50/62/80:

| $Q^2$ | $A_{\max}$ (tol=50) | $A_{\max}$ (tol=62) | $A_{\max}$ (tol=80) |
|---:|---:|---:|---:|
| 1.0 | 0.987744340 | 0.988922454 | 0.989423504 |
| $Q^*$ | 0.837407609 | 0.851753713 | 0.868490167 |

Interpretation: ${\rm tol}_{\rm ASR}$ is a **dominant UV knob** for $A_{\max}$ near $Q^*$ (tens of $10^{-3}$ shifts), so all tight bands remain explicitly conditional on this UV assumption until replaced by a physics-motivated UV/OPE estimate.

## Artifacts

Baseline:
- v100 config: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v4cay_dispersion_grid200_enf200_multiq_audit8_clarabel_asrband_slope_tmd_asrtol62p0.json`
- v100 run: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-18-a-bochner-k0-socp-v100-dispersion-grid200-enf200-multiq-audit8-clarabel-asrband-slope-tmd-asrtol62p0/results.json`

Cross-check/systematics runs:
- v101: `.../runs/2026-02-18-a-bochner-k0-socp-v101-.../results.json`
- v102: `.../runs/2026-02-18-a-bochner-k0-socp-v102-.../results.json`
- v103: `.../runs/2026-02-18-a-bochner-k0-socp-v103-.../results.json`
- v104: `.../runs/2026-02-18-a-bochner-k0-socp-v104-.../results.json`
- v105: `.../runs/2026-02-18-a-bochner-k0-socp-v105-.../results.json`

Evidence note (tables + interpretation):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/2026-02-18-w6-23-multiq-asrband-slope-summary-v2.md`

Manuscript:
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/reports/draft.md` (W6-23 bullet updated to reference v2 note)

## Gates executed (PASS)

- v100 run log: `idea-generator/docs/reviews/bundles/2026-02-18-w6-23-v100-multiq-clarabel-asrband-slope-run-v1.txt`
- v101–v105 run logs: `idea-generator/docs/reviews/bundles/2026-02-18-w6-23-v101-...-v1.txt` etc.
- `idea-generator/docs/reviews/bundles/2026-02-18-w6-23-idea-runs-validate-v1.txt`
- `idea-generator/docs/reviews/bundles/2026-02-18-w6-23-render-dashboards-v1.txt`
- `idea-generator/docs/reviews/bundles/2026-02-18-w6-23-idea-runs-validate-project-v1.txt`

## Question for reviewers

With (i) sparse ECOS cross-check, (ii) tail envelope propagated across $Q^2$, (iii) ASR tolerance sensitivity spot-checked, and (iv) v100 solver status all-OPTIMAL, is W6-23 now `READY`?

