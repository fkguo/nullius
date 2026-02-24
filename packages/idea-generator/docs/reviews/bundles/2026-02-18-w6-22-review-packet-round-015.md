# W6-22 Review Packet (Round-015) — **s-grid/ansatz sensitivity evidenced** + **paths fully resolvable** + **gate PASS shown with deltas**

NOT_FOR_CITATION. Tools disabled for reviewers.

## What changed since Round-013 (addresses remaining Opus blockers)

1) **All run artifact paths are now explicit (no ellipses)** for baseline/refinement/tail runs.
2) **s-grid discretization story is now evidenced**:
   - poly18: grid200 feasible (v82), grid250 infeasible (v96).
   - poly24: grid200 feasible (v98) and grid250 feasible (v97), with a quantified A_max shift at the few $10^{-3}$ level.
3) **Cross-solver gate evidence includes numerical deltas + PASS**, not just mechanism/log pointers.

## Discretization / ansatz evidence (Clarabel; tol_ASR=62; slope input; tail=1.0)

Baseline (grid200, poly18):
- v82: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-18-a-bochner-k0-socp-v82-dispersion-grid200-enf200-qstar-audit7-clarabel-asrband-slope-tmd-asrtol62p0/results.json`
  - $A_{\\max}(-Q^*)\\approx 0.851754$

s-grid refinement (poly18) negative result:
- v96 (grid250, poly18): `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-18-a-bochner-k0-socp-v96-dispersion-grid250-enf200-qstar-audit7-clarabel-asrband-slope-tmd-asrtol62p0/results.json` (`INFEASIBLE`)

Ansatz refinement (poly24) restores feasibility:
- v98 (grid200, poly24): `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-18-a-bochner-k0-socp-v98-dispersion-grid200-poly24-enf200-qstar-audit7-clarabel-asrband-slope-tmd-asrtol62p0/results.json`
  - $A_{\\max}(-Q^*)\\approx 0.854434$ (shift $\\approx +2.68\\times 10^{-3}$ vs v82)
- v97 (grid250, poly24): `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-18-a-bochner-k0-socp-v97-dispersion-grid250-poly24-enf200-qstar-audit7-clarabel-asrband-slope-tmd-asrtol62p0/results.json`
  - $A_{\\max}(-Q^*)\\approx 0.854851$ (additional shift $\\approx +4.18\\times 10^{-4}$ vs v98)

Conclusion (pilot framing): b-grid discretization is stable (v95); s-grid refinement is currently **ansatz-limited** and induces a few $10^{-3}$ modeling systematic once the ansatz is expanded.

## Tail-envelope artifacts (Clarabel; tol=62; slope input)

- v92 (tail=0.8): `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-18-a-bochner-k0-socp-v92-dispersion-grid200-enf200-qstar-audit7-clarabel-asrband-slope-tmd-asrtol62p0-tail0p8/results.json`
- v93 (tail=1.2): `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-18-a-bochner-k0-socp-v93-dispersion-grid200-enf200-qstar-audit7-clarabel-asrband-slope-tmd-asrtol62p0-tail1p2/results.json`

## Cross-solver gate (machine-checkable) — PASS with deltas

Gate config:
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/pipeline/cross_solver_check_v1.json`

Gate validation proof:
- `idea-generator/docs/reviews/bundles/2026-02-18-w6-22-idea-runs-validate-project-v4.txt`

Per-check numerical deltas (computed from the cited run `results.json`):

1) tol_ASR=62 endpoint (ECOS v76 vs Clarabel v82):
   - $\\Delta A_{\\min}\\approx 1.12\\times 10^{-3}$
   - $\\Delta A_{\\max}\\approx 3.81\\times 10^{-3}$ (rel $\\approx 4.47\\times 10^{-3}$)
   - PASS under (abs≤0.004, rel≤0.005)

2) tol_ASR=150 endpoint (ECOS v89 vs Clarabel v83):
   - $\\Delta A_{\\min}\\approx 1.30\\times 10^{-4}$
   - $\\Delta A_{\\max}\\approx 1.41\\times 10^{-4}$ (rel $\\approx 1.54\\times 10^{-4}$)
   - PASS under (abs≤0.004, rel≤0.005)

## Question for reviewers

With explicit (i) ansatz-limited s-grid sensitivity evidence, (ii) b-grid stability, (iii) tail envelope, and (iv) cross-solver gate PASS shown numerically, is W6-22 now `READY` at pilot claim level?

