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
  "reliable": 2,                      // count with verdict == "reliable"
  "not_reliable": ["pole_location_R1"],   // ids whose verdict != "reliable"
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

      // G7 — method-validity precondition at the production setting. null if the method carries no
      // operator/structural precondition; else REQUIRED for a `reliable` verdict (see the G7 field rule).
      // When present:
      // { "property": "operator O commutes with projector/symmetrizer P",
      //   "residual_def": "‖[P,O]ψ‖/‖Oψ‖ (or true-operator ‖Oψ−λψ‖/‖Oψ‖ for a projected eigenvalue)",
      //   "production_setting": "<the setting that produced recorded_value>",
      //   "tested_setting": "<MUST equal production_setting>",
      //   "residual": 1.3e-14, "threshold": 1e-10, "command": "<one-command repro>", "passed": true }
      "method_precondition": null,

      "notes": ""
    },
    {
      // The argument principle certifies a COUNT — this quantity is the count, and it is reliable.
      "id": "pole_count_R1",
      "quantity": "number of poles of a response/transfer function G(z) in region R1 (= zeros of its denominator D(z) there)",
      "verdict": "reliable",
      "recorded_value": "1",
      "recorded_setting": "rectangle Re[1.28,1.46] x Im[-0.18,-0.055] on the principal branch",
      "refinement": [
        { "setting": "contour samples = 512", "value": "0.991" },
        { "setting": "contour samples = 2048", "value": "0.998" }
      ],
      "converged": true,
      "mirage": false,
      "cross_method": [
        { "method": "argument-principle winding of D(z)", "value": "1" },
        { "method": "sign-change scan of the characteristic determinant", "value": "1" }
      ],
      "methods_agree": true,
      "tolerance": "|raw_winding - round| < 0.05",
      // G3 invariant — record the semantics, not just a boolean (an auditor must see WHAT was counted).
      "invariant_check": {
        "kind": "argument-principle winding number",
        "function": "D(z) — the denominator / characteristic function; analytic and pole-free in R1, so the winding number equals its zero count",
        "count_semantics": "zeros_of_D (= poles of G); D itself is pole-free (analytic) in R1 so P=0, giving (1/2pi i)∮ D'/D dz = Z. (The integrand D'/D still has simple poles AT the zeros of D, residue = multiplicity — that is exactly what the integral counts.)",
        "region": "Re[1.28,1.46] x Im[-0.18,-0.055]",
        "contour": "rectangle, positively oriented (CCW)",
        "sheet": "principal branch (name the sheet/branch explicitly when the function is multivalued)",
        "preconditions_checked": ["meromorphic in R1", "no zero/pole on the contour (min |D| on Gamma = 0.21)", "correct sheet"],
        "raw_winding": 0.998,
        "rounded_count": 1,
        "integer_residual": 0.002,
        "passed": true
      },
      "regression_anchor": null,
      "degeneracy": null,
      "notes": "fixed-seed search reported 'absent' (false negative: the pole moved off the seed); the winding number counts exactly 1 zero of D in R1. The COUNT is reliable; see pole_location_R1 for why the location is not."
    },
    {
      // Same feature, different quantity: the argument principle counts but does NOT locate — so the
      // location is NOT reliable just because the count is. This is the row the count must not certify.
      "id": "pole_location_R1",
      "quantity": "the pole's location z* in region R1 (the LOCATION of the pole counted in pole_count_R1)",
      "verdict": "fragile_method",
      "recorded_value": null,
      "recorded_setting": null,
      "refinement": [],
      "converged": false,
      "mirage": false,
      "cross_method": [],
      "methods_agree": false,
      "tolerance": null,
      // null: the winding number is a count, not a locator — no invariant validates the z* value here.
      "invariant_check": null,
      "regression_anchor": null,
      "degeneracy": null,
      "notes": "pole_count_R1 proves exactly one pole exists in R1 but does NOT locate it. The z* value came from a fixed-seed search that is fragile in this regime and is confirmed by no locating invariant — unpromotable until a robust locator agrees (e.g. a contour-moment estimate, or Newton from several seeds converging to the same point)."
    }
  ]
}
```

## `verdict` enum

| verdict | meaning | foldable? |
|---|---|---|
| `reliable` | passed **every applicable** G1–G7 check at the converged setting — including the G4 anchor, G6 non-staleness, and the G7 production-scale method-precondition, not only G1–G3 | **yes** |
| `mirage` | a candidate optimum/feature that did not survive G1 refinement | no |
| `unconverged` | value still moving as the resolution is refined (G1) | no |
| `method_disagreement` | orthogonal methods (G2) do not agree and the discrepancy is unexplained | no |
| `fragile_method` | result depended on a seed/threshold (or a method used outside its stable regime) and is not confirmed by an invariant/robust method (G2/G3) | no |
| `anchor_failed` | the reference/default configuration did not reproduce its known anchor (G4), so no variation built on it can be trusted | no |
| `degenerate` | a flat-direction parameter quoted as if determined (G5 violation) — report the robust observable instead | no |
| `stale_artifact` | the record's code/input version or timestamp does not match the current run (G6 provenance) — recompute before trusting | no |
| `precondition_violated` | a structural property the method's validity rests on (commutation with a projector/symmetrizer, Hermiticity, self-adjointness, idempotency, unitarity, variational/Galerkin-subspace invariance) fails — or was only tested at a smaller/cheaper setting than the value — at the production setting/config (G7); the value is **invalid**, not approximate, even if G1-converged | no |

Only `reliable` rows may be folded into `research_contract.md` / a paper / a conclusion. Every other row
is a **labeled candidate** kept for follow-up or discarded — never silently promoted.

## Field rules

- `refinement` MUST contain `>=2` settings spanning at least a 2–3× range of the dominant knob (resolution
  **or** size/extent/parity, whichever the value or its precondition could depend on) for any
  `converged: true`. A single setting can never establish convergence.
- **G7 method-precondition (when applicable)**: for any `reliable` verdict whose method's validity rests on
  a structural property (commutation with a projector/symmetrizer, Hermiticity, self-adjointness,
  idempotency, unitarity, variational-subspace invariance), the matrix MUST record that property's
  **disconfirming residual evaluated at the production setting/config** — not only at the smallest/cheapest
  setting; for a projected/effective eigenvalue, record the true-operator residual `‖Oψ − λψ‖/‖Oψ‖` and the
  variance. A precondition verified only at a smaller/cheaper setting than the recorded value does NOT
  satisfy G7 (verdict `precondition_violated`).
- `cross_method` MUST contain `>=2` genuinely independent methods for any `reliable` verdict that depends
  on a continuation/quadrature/search; record both values even when they agree. **Narrow exception**
  (mirrors G2): a single method MAY stand alone iff it carries a *rigorous a-posteriori / certified-interval
  error bound* that by itself establishes the value — then record that one method with its certificate in
  `tolerance`/`notes` and state why no second was required. Do not invoke this to excuse an
  un-cross-checked seed/heuristic search (which has no such bound).
- `invariant_check`, `regression_anchor`, `degeneracy` are `null` when not applicable; when present they
  carry the disconfirming evidence, not a bare boolean.
- A present `invariant_check` SHOULD record what was actually counted, not only `passed`: the `function`
  the invariant was applied to, the `count_semantics` (zeros, poles, or `Z − P`), the `contour`
  orientation and `sheet`/branch, the `preconditions_checked`, and the unrounded `raw_winding` with its
  `rounded_count` and `integer_residual`. A bare integer with no semantics is not auditable, and an
  argument-principle count certifies a **count, not a location** — do not let a passing count promote a
  separately-derived location (record the location as its own row).
- `recorded_value`/`recorded_setting` are `null` unless `verdict == "reliable"`.
