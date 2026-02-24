# W6-22 Review Packet (Round-013) — **Discretization check added** + **asymmetric status policy enforced** + **all artifacts path-cited**

NOT_FOR_CITATION. Tools disabled for reviewers.

## What changed since Round-011

1) **Discretization sensitivity evidence added (Clarabel; tightened endpoint)**:
   - b-grid refinement: v82 (`n_b=35`) → v95 (`n_b=70`) shifts $A_{\max}$ by only $2.6\\times 10^{-5}$.
   - aggressive refinement (s-grid + Re-dispersion enforcement): v94 is **INFEASIBLE** (recorded negative result; treated as a separate modeling axis).

2) **Cross-solver gate now enforces asymmetric status policy per-run**:
   - implemented via `accepted_statuses_a` / `accepted_statuses_b` (Clarabel must be `OPTIMAL`; ECOS may be `ALMOST_OPTIMAL` only where explicitly allowed).

3) **Concrete run artifact paths are now cited** for the tail-envelope runs and discretization runs (see below).

## Primary evidence file (instance repo)

- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/2026-02-18-w6-22-asrband-scan-summary-v1.md`

## Tail-envelope raw artifacts (Clarabel; tol=62; slope input)

- v92: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-18-a-bochner-k0-socp-v92-dispersion-grid200-enf200-qstar-audit7-clarabel-asrband-slope-tmd-asrtol62p0-tail0p8/results.json`
- v93: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-18-a-bochner-k0-socp-v93-dispersion-grid200-enf200-qstar-audit7-clarabel-asrband-slope-tmd-asrtol62p0-tail1p2/results.json`

## Discretization raw artifacts (Clarabel; tol=62; slope input; tail=1.0)

- b-grid refinement:
  - baseline v82: `.../runs/2026-02-18-a-bochner-k0-socp-v82-dispersion-grid200-enf200-qstar-audit7-clarabel-asrband-slope-tmd-asrtol62p0/results.json`
  - refined v95 (`n_b=70`): `.../runs/2026-02-18-a-bochner-k0-socp-v95-dispersion-grid200-enf200-qstar-audit7-clarabel-asrband-slope-tmd-asrtol62p0-nb70/results.json`
- aggressive refinement negative result:
  - v94 (`n_points=400`, `n_enforce=400`): `.../runs/2026-02-18-a-bochner-k0-socp-v94-dispersion-grid400-enf400-qstar-audit7-clarabel-asrband-slope-tmd-asrtol62p0/results.json`

## Cross-solver gate (policy + tolerances; machine-checkable)

Config excerpt:
```json
{
  \"check_id\": \"...tol150...\",
  \"accepted_statuses_a\": [\"OPTIMAL\", \"ALMOST_OPTIMAL\"],
  \"accepted_statuses_b\": [\"OPTIMAL\"],
  \"abs_tolerance\": 0.004,
  \"rel_tolerance\": 0.005
}
```

Validate-project log proving enforcement ran (design repo evidence):
- `idea-generator/docs/reviews/bundles/2026-02-18-w6-22-idea-runs-validate-project-v4.txt`

## Question for reviewers

With (i) tail-systematic headline reporting, (ii) b-grid discretization stability evidence, and (iii) asymmetric status policy enforced in validation, is W6-22 now `READY` at pilot claim level?

