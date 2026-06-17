# numerical-reliability-gate — contract

Backend-agnostic contract for the reliability matrix. Any implementation (a hand-applied checklist, a
host-native loop, a future script) must emit an artifact that satisfies this schema so a reviewer can
audit *why* a number was trusted.

## Artifact

`numerical_reliability_matrix_v1.json` — name conforms to ART-01
(`^[a-z]+_[a-z_]+(_\d{3})?_v\d+\.(json|tex|jsonl)$`). Top-level `schema_version` MUST be the first field
and MUST equal the filename's `_vN` (ART-02). Write atomically (ART-03).

```jsonc
{
  "schema_version": 1,
  "total": 3,                         // quantities gated
  "reliable": 1,                      // count with verdict == "reliable"
  "not_reliable": ["pole_extra", "I_thr"],   // ids whose verdict != "reliable"
  "matrix": [
    {
      "id": "chi2_ref",               // stable id for the gated quantity
      "quantity": "chi2/dof of the reference fit",
      "verdict": "reliable",          // see enum below
      "recorded_value": "1.92",       // the value folded into the durable record (only if reliable)
      "recorded_setting": "grid=(24,16,16,10), nodes=36, method=AAA",

      // G1 — discretization convergence. value MUST be stable as setting refines.
      "refinement": [
        { "setting": "grid=(12,10,10,8)", "value": "1.913" },
        { "setting": "grid=(24,16,16,10)", "value": "1.920" }
      ],
      "converged": true,              // measured plateau, not assumed
      "mirage": false,                // true if a coarse-setting optimum did not survive refinement

      // G2 — orthogonal-method cross-check. >=2 independent methods; agree within tolerance.
      "cross_method": [
        { "method": "AAA continuation", "value": "1.920" },
        { "method": "Thiele continuation", "value": "1.929" }
      ],
      "methods_agree": true,
      "tolerance": "abs < 0.02",

      // G3 — invariant / topological validation (null if not applicable to this quantity).
      "invariant_check": null,

      // G4 — regression anchor (null if this IS the reference, not a variation).
      "regression_anchor": {
        "reference": "adopted 188 fit",
        "expected": "1.9",
        "observed": "1.92",
        "reproduced": true
      },

      // G5 — degeneracy honesty (null if no flat directions).
      "degeneracy": null,

      "notes": ""
    },
    {
      "id": "pole_extra",
      "quantity": "third pole sqrt(s) [MeV]",
      "verdict": "fragile_method",
      "recorded_value": null,
      "recorded_setting": null,
      "refinement": [],
      "converged": false,
      "mirage": false,
      "cross_method": [],
      "methods_agree": false,
      "tolerance": null,
      // G3 invariant beats the fragile seed search:
      "invariant_check": {
        "kind": "argument-principle winding",
        "region": "Re[1.28,1.46] x Im[-0.18,-0.055], contour V0=-0.3",
        "expected_integer": true,
        "observed": 1.0,
        "passed": true
      },
      "regression_anchor": null,
      "degeneracy": null,
      "notes": "fixed-seed search reported 'absent' (false negative: the pole moved); winding count found exactly 1 zero. Quote the invariant, not the seed search."
    }
  ]
}
```

## `verdict` enum

| verdict | meaning | foldable? |
|---|---|---|
| `reliable` | passed every applicable G1–G3 at the converged setting | **yes** |
| `mirage` | a candidate optimum/feature that did not survive G1 refinement | no |
| `unconverged` | value still moving as the resolution is refined | no |
| `method_disagreement` | orthogonal methods (G2) do not agree | no |
| `fragile_method` | result depended on a seed/threshold; not confirmed by an invariant/robust method | no |
| `degenerate` | a flat-direction parameter quoted as if determined (G5 violation) — report the robust observable instead | no |

Only `reliable` rows may be folded into `research_contract.md` / a paper / a conclusion. Every other row
is a **labeled candidate** kept for follow-up or discarded — never silently promoted.

## Field rules

- `refinement` MUST contain `>=2` settings spanning at least a 2–3× range of the dominant knob for any
  `converged: true`. A single setting can never establish convergence.
- `cross_method` MUST contain `>=2` genuinely independent methods for any `reliable` verdict that depends
  on a continuation/quadrature/search; record both values even when they agree.
- `invariant_check`, `regression_anchor`, `degeneracy` are `null` when not applicable; when present they
  carry the disconfirming evidence, not a bare boolean.
- `recorded_value`/`recorded_setting` are `null` unless `verdict == "reliable"`.
