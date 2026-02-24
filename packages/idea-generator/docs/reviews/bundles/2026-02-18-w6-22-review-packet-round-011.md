# W6-22 Review Packet (Round-011) — **Status policy + justified gates** + **tail systematic propagated** + **auditable validate-project proof**

NOT_FOR_CITATION. Tools disabled for reviewers.

## What changed since Round-009

1) **Machine-checkable solver-status policy** is now encoded in the cross-solver gate config via `accepted_statuses`:
   - tol=62 check requires `OPTIMAL` for both solvers (runs v76/v82).
   - tol=150 check allows ECOS `ALMOST_OPTIMAL` (run v89) while keeping Clarabel `OPTIMAL` (run v83); Clarabel is treated as primary.

2) **Gate tolerances tightened and justified**:
   - now `abs_tolerance=0.004`, `rel_tolerance=0.005`,
   - rationale: solver deltas must be subdominant to the observed tail systematic at the tightened endpoint (ΔA_max≈3.2e-3 for ±20% tail scaling).

3) **Tail sensitivity is propagated into the quoted pilot headline bounds** (Clarabel-primary):
   - report A_max as an envelope over `tail.scale_factor∈{0.8,1.0,1.2}`.

4) **Auditable validate-project proof updated**:
   - new log: `idea-generator/docs/reviews/bundles/2026-02-18-w6-22-idea-runs-validate-project-v3.txt`

## Key artifacts

Canonical scan note (instance repo; updated):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/2026-02-18-w6-22-asrband-scan-summary-v1.md`

Cross-solver gate (instance repo; policy + tolerances):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/pipeline/cross_solver_check_v1.json`

Gate enforcement (tooling):
- `idea-runs/schemas/cross_solver_check_v1.schema.json`
- `idea-runs/scripts/validate_project_artifacts.py`

## Pilot headline bound at tightened endpoint (now includes tail systematic)

At tol_ASR=62 with slope input $f_1=0.01198\\pm0.001$:

- Clarabel baseline (tail.scale_factor=1.0): v82 gives
  $$
  A^\\pi(-Q^*)\\in[0.8306845,\\,0.8517537].
  $$
- Tail envelope (Clarabel; scale_factor∈{0.8,1.0,1.2}): v92/v82/v93 imply
  $$
  A_{\\min}(-Q^*)\\approx 0.83068,\\qquad
  A_{\\max}(-Q^*)\\in[0.84862,\\,0.85451].
  $$

## Cross-solver gate evidence (now self-documenting)

Excerpt from `pipeline/cross_solver_check_v1.json` (policy + rationale included in-file):
```json
{
  "checks": [
    {
      "check_id": "w6-22-asrband-slope-qstar-tol62-ecos-vs-clarabel",
      "abs_tolerance": 0.004,
      "rel_tolerance": 0.005,
      "accepted_statuses": ["OPTIMAL"]
    },
    {
      "check_id": "w6-22-asrband-slope-qstar-tol150-ecos-vs-clarabel",
      "abs_tolerance": 0.004,
      "rel_tolerance": 0.005,
      "accepted_statuses": ["OPTIMAL", "ALMOST_OPTIMAL"]
    }
  ]
}
```

Validation log (design repo evidence; proves enforcement ran and passed):
- `idea-generator/docs/reviews/bundles/2026-02-18-w6-22-idea-runs-validate-project-v3.txt`

## Questions for reviewers

1) With explicit status policy + justified tolerances + tail-systematic headline reporting, is W6-22 now `READY` at pilot claim level?
2) Any further gate you require before proceeding to UV/OPE anchoring (e.g., enforce Clarabel-only headline outputs, or add a discretization refinement check)?

