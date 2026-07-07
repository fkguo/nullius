# literature-to-package — phase artifacts and gate contract

Every pipeline phase produces one JSON artifact; `scripts/gates/check_phase.py`
validates it (and, where the phase touches files, the package tree) and emits the
machine verdict. **The caller never self-judges a phase**: numeric comparisons are
recomputed by the gate, self-claimed pass fields are ignored, and every error path
fails closed (missing artifact / unreadable file / empty manifest is a failure or an
input error, never a silent pass).

## Gate invocation and verdict

```bash
python3 "${SKILL_DIR}/scripts/gates/check_phase.py" \
  --phase <survey|extraction|skeleton|reimplementation|reference-check|composite-gates|closeout> \
  --artifact <phase_artifact.json> \
  [--package-root <dir>]   # required for skeleton / reimplementation / reference-check / composite-gates / closeout
  [--out-json <verdict.json>]
```

Exit codes: `0` pass, `1` fail, `2` input / execution error. Verdict on stdout
(and `--out-json`), diagnostics on stderr:

```jsonc
// literature_to_package_gate_result_v1
{
  "schema_id": "literature_to_package_gate_result_v1",
  "schema_version": 1,
  "phase": "extraction",
  "status": "pass" | "fail" | "error",
  "exit_code": 0,                    // 0 <-> pass, 1 <-> fail, 2 <-> error
  "labels": ["MISSING_LOCATOR"],     // distinct falsification labels, sorted
  "reasons": ["MISSING_LOCATOR: item eq_dispersion: ..."],
  "checked": {"items": 12},          // phase-specific counts
  "generated_at": "2026-07-07T00:00:00Z"
}
```

All paths inside artifacts are **package-root-relative**; an absolute path in a
manifest is itself a finding (`ABSOLUTE_PATH_IN_MANIFEST`).

---

## Phase 1 · survey — `survey_decision_v1`

Reuse-vs-build decisions per component, before anything is built.

```jsonc
{
  "schema_id": "survey_decision_v1",
  "components": [
    {
      "id": "integral_equation_solver",
      "decision": "build" | "reuse" | "wrap",
      "searches": [                              // >=1 required
        {"query": "…", "venue": "arXiv|INSPIRE|GitHub|…", "date": "2026-07-07", "results": 14}
      ],
      "strongest_prior_art": [                   // the strongest EXISTING statement found
        {"statement": "…", "source": "arxiv:XXXX.XXXXX", "locator": "Sec. 3"}
      ],
      "originality_claim": false,                // claiming novelty?
      "no_public_code_found": true               // a search RESULT, never an originality argument
    }
  ]
}
```

Falsification labels: `EMPTY_SURVEY`, `MISSING_DECISION`, `MISSING_SEARCH_LOG`,
`ORIGINALITY_WITHOUT_STRONGEST_PRIOR` (an originality claim must name the strongest
existing statement a focused search produced), `ABSENCE_PROMOTED_TO_NOVELTY`
("no public code found" recorded together with an unsupported originality claim).

## Phase 2 · extraction — `extraction_manifest_v1`

Span-anchored extraction of everything the package will encode. **Model memory is
not a source.**

```jsonc
{
  "schema_id": "extraction_manifest_v1",
  "sources": [
    {"id": "paperA", "kind": "paper" | "book" | "code" | "dataset", "citation": "…", "doi_or_arxiv": "…"}
  ],
  "items": [
    {
      "id": "eq_kernel",
      "kind": "equation" | "algorithm" | "convention" | "constant" | "parameter",
      "verbatim": "…exact span from the source…",   // required, no paraphrase-only items
      "source": "paperA",                            // must resolve in sources[]
      "locator": "Eq. (12), p. 4",                   // required
      "units": "MeV",                                // REQUIRED for constant/parameter ("dimensionless" allowed)
      "normalized_form": "…the convention adopted by the package…"   // optional
    }
  ]
}
```

Falsification labels: `EMPTY_EXTRACTION`, `MISSING_VERBATIM`, `MISSING_LOCATOR`,
`UNKNOWN_SOURCE`, `UNKNOWN_ITEM_KIND`, `MISSING_UNITS`, `MEMORY_CITED_AS_SOURCE`.

Conventions and units are first-class extraction items: they are the most
error-prone, most load-bearing content a package inherits from a paper.

## Phase 3 · skeleton — `skeleton_manifest_v1`

Package skeleton hygiene plus the traceability ledger and the export map.

```jsonc
{
  "schema_id": "skeleton_manifest_v1",
  "traceability_ledger": "traceability_ledger.json",   // package-root-relative
  "reference_asset_dirs": ["reference_assets"],        // excluded from the skeleton-phase path scan
  "exports": [
    {"name": "solve_kernel", "doc_path": "docs/api.md", "test_path": "tests/test_solve_kernel.py"}
  ]
}
```

The ledger file:

```jsonc
// traceability_ledger.json
{
  "entries": [
    {
      "artifact": "src/kernel.jl#solve_kernel",
      "extraction_ids": ["eq_kernel", "conv_normalization"],  // OR:
      "reuse_source": "SomeUpstreamPackage v1.2",             // adopted from an existing package
      "status": "pending" | "verified" | "reused"
    }
  ]
}
```

Gate checks: no machine-specific absolute path anywhere in the package tree
(`ABSOLUTE_PATH_IN_PACKAGE`; the scan covers code/doc/text extensions, skips VCS and
cache dirs, and reports unreadable/oversized files as `SCAN_INCOMPLETE` — a blind
spot is a failure, not a pass); `MISSING_README`; `MISSING_TEST_SKELETON`;
`MISSING_TRACEABILITY_LEDGER` / `EMPTY_TRACEABILITY_LEDGER` / `UNTRACED_LEDGER_ITEM`
(every entry needs `extraction_ids` or `reuse_source` — nothing enters the package
without an origin); `MISSING_EXPORT_MAP` / `EXPORT_MISSING_DOC` /
`EXPORT_MISSING_TEST` (every export carries all three legs: code, documentation
anchor, test skeleton).

## Phase 4 · reimplementation — `independence_manifest_v1`

Each method is re-implemented from a clean-room SPEC, at least twice, independently.

```jsonc
{
  "schema_id": "independence_manifest_v1",
  "reference_code_paths": ["reference_assets/original_solver.jl"],
  "methods": [
    {
      "id": "kernel_solver",
      "spec_path": "specs/kernel_solver_spec.md",     // written from the literature, not the reference code
      "implementations": [
        {"path": "src/kernel.jl",        "origin": "fresh",                 "independent": true},
        {"path": "checks/kernel_alt.py", "origin": "fresh",                 "independent": true},
        {"path": "reference_assets/port.jl", "origin": "ported_from_reference", "independent": false}
      ],
      "review_verdicts": ["reviews/kernel_solver_verdict.md"]
    }
  ]
}
```

Gate checks:

- `MISSING_SPEC` / `SPEC_REFERENCES_SOURCE_CODE` — the SPEC must exist and must not
  mention the reference code (it is written from the literature).
- `INSUFFICIENT_INDEPENDENT_IMPLEMENTATIONS` — the floor is **2** implementations
  with `independent: true`; `PORT_CLAIMED_INDEPENDENT` — `independent: true`
  requires `origin: "fresh"`: a port or adaptation of reference code is a
  transcription of the thing under test, not an independent path.
- `IMPLEMENTATION_COUPLING` / `REFERENCE_CODE_COUPLING` — an independent
  implementation must not reference a sibling implementation or the reference code.
  (Textual stem matching; a **detector, not a proof** — see Approximations.)
- `MISSING_INDEPENDENT_REVIEW` / `REVIEW_NOT_APPROVED` — at least one independent
  review verdict file, and every recorded verdict must approve. Accepted verdict
  formats (the review-swarm output contract): a Markdown report whose first
  non-empty line is `VERDICT: READY`, or a JSON object with `"verdict": "PASS"`.
  Convergence is declared by the reviewer, never by the implementer.

When implementations disagree, locate the first diverging intermediate quantity by
tracing both paths — never settle by majority vote, never re-run until agreement.

## Phase 5 · reference-check — `reference_check_v1`

Numeric cross-validation against published values. The gate **recomputes** every
comparison; a `passed` field in the artifact carries no authority.

```jsonc
{
  "schema_id": "reference_check_v1",
  "checks": [
    {
      "id": "anchor_point_A",
      "quantity": "…physical quantity name…",
      "representation": "momentum_grid",       // which representation/basis produced it
      "computed":  {"value": 1.2345, "error": 0.0004},
      "reference": {"value": 1.2340, "error": 0.0006, "source": "paperA", "locator": "Table 2, row 3"},
      "tolerance": 0.001,                      // |computed - reference| must be within this
      "error_scale": 0.00072,                  // the uncertainty scale the tolerance must not exceed
      "error_scale_basis": "combined quoted uncertainties"
    }
  ],
  "reference_only": ["OriginalSolverPkg"],     // assets that must never enter runtime deps
  "runtime_dep_files": ["Project.toml"]        // scanned for the names above
}
```

Gate checks (all recomputed): `VALUE_MISMATCH` (`|computed − reference| > tolerance`
— a mismatch is a finding to resolve, not a "systematic" to be renamed);
`NON_DIAGNOSTIC_TOLERANCE` (`tolerance <= error_scale` required, with a declared
`error_scale_basis`: a tolerance coarser than the uncertainty scale cannot detect a
discrepancy at the scale that matters, so it proves nothing); `ERROR_SCALE_INFLATED`
(when both errors are quoted, `error_scale` must not exceed their quadrature sum —
inflating the scale would launder a loose tolerance); `SINGLE_REPRESENTATION`
(>= 2 distinct `representation` values across the checks: agreement within one
representation cannot expose a representation-level error);
`MISSING_REFERENCE_LOCATOR`, `MISSING_VALUES`, `EMPTY_REFERENCE_CHECK`;
`REFERENCE_IN_RUNTIME_DEPS` (declared reference-only assets must not appear in any
runtime dependency file — reference material feeds benchmarks and tests, never the
package runtime; declaring reference assets without dep files to scan is itself a
failure).

## Phase 6 · composite-gates — `composite_gates_v1`

The three existing verdicts, side by side. This phase does not re-run the sibling
skills; it verifies their emitted verdicts all pass.

```jsonc
{
  "schema_id": "composite_gates_v1",
  "gates": {
    "derivation":            "gates/derivation_verify_output.json",
    "numerical_reliability": "gates/reliability_matrix.json",
    "performance":           {"waived": true, "reason": "pure-Python package; no performance claim is made"}
  }
}
```

Pass semantics per verdict:

- `derivation` — a derivation-verify output: `total_claims >= 1`,
  `converged == total_claims`, `unconverged == []`.
- `numerical_reliability` — a numerical-reliability matrix: non-empty `matrix`,
  `not_reliable == []` (every item verdict `reliable`).
- `performance` — a performance-gate verdict object with `"verdict": "pass"`
  (an inconclusive / missing benchmark is not a pass).

Any of the three may instead carry an **explicit waiver**
`{"waived": true, "reason": "…"}`; a waiver without a reason is `SILENT_WAIVER`.
Other labels: `MISSING_GATE_VERDICT`, `UNPARSEABLE_GATE_VERDICT`, `GATE_NOT_PASSED`.

## Phase 7 · closeout — `closeout_v1`

```jsonc
{
  "schema_id": "closeout_v1",
  "readme_examples": [
    {"id": "quickstart", "log": "closeout/quickstart_run.log"}   // non-empty execution log required
  ],
  "readme_examples_none_reason": "",       // required text when readme_examples is empty
  "scrub_lexicon": ["…project-declared internal-process words…"],
  "scrub_lexicon_none_reason": "",         // required text when the lexicon is empty
  "traceability_ledger": "traceability_ledger.json"
}
```

Gate checks: `UNEXECUTED_README_EXAMPLE` (a README example that was never run is a
claim, not documentation); `SCRUB_LEXICON_HIT` (the project declares which
internal-process vocabulary must not reach the public package — e.g. words that
narrate the private construction history rather than the science; the gate sweeps
every text file, case-insensitive, whole-word); `ABSOLUTE_PATH_IN_PACKAGE`
(re-scan of the FINAL tree — unlike the skeleton phase, nothing is excluded here:
reference originals must not ship); `UNRESOLVED_TRACEABILITY` (every ledger entry
`verified` or `reused`; no `pending` provenance may ship); `MISSING_CLOSEOUT_FIELDS`;
`SCAN_INCOMPLETE`.

---

## Honesty invariants

- **The gate is the verdict.** A phase advances only on exit 0 from
  `check_phase.py`; prose claiming a phase "looks done" carries no authority.
- **Recompute, never trust.** Numeric comparisons are recomputed by the gate;
  self-claimed pass fields are ignored.
- **Blind spots fail.** Unreadable / oversized files in a package scan are
  `SCAN_INCOMPLETE` findings, not skips.
- **Waivers are explicit.** A gate that does not apply is waived with a recorded
  reason, never silently omitted.
- **No phase skipping.** Later phases build on earlier artifacts; running
  `closeout` without a `reference-check` verdict in the run record is a process
  violation even though each gate checks only its own artifact.

## Approximations (documented limits)

- The coupling checks in `reimplementation` use word-boundary stem matching over
  the implementation text. They catch load statements, path strings, and name
  reuse, but they are a **detector, not a proof of independence** — an
  implementation could be re-typed from the reference without naming it. The
  independent review requirement exists precisely because textual checks cannot
  certify provenance.
- The runtime-dependency scan is textual (word-boundary name match in declared dep
  files); ecosystem-specific manifests with exotic layouts should be listed
  explicitly in `runtime_dep_files`.
- The absolute-path scan covers common code/doc/text extensions up to 2 MB per
  file; binaries are out of scope and anything unreadable is reported as
  `SCAN_INCOMPLETE` rather than skipped.
