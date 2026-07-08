---
name: literature-to-package
description: "Build the initial framework of a software package FROM LITERATURE — a 7-phase pipeline (survey, extraction, skeleton, reimplementation, reference-check, composite-gates, closeout), each phase closed by a deterministic fail-closed gate. Orchestrates deep-literature-review, claim-grounding, citation-triangulation, derivation-verify, numerical-reliability-gate, julia-perf, and review-swarm; adds the literature-to-code bridge they do not cover: span-anchored extraction manifests, a traceability ledger, clean-room independent reimplementation, and reference-value cross-validation. Use when turning one or more papers into a new package skeleton whose every equation, convention, constant, and algorithm must be traceable and independently verified."
---

# Literature to Package (verified initial framework)

Turn a body of literature into the **initial framework of a package** — directory
skeleton, typed API stubs, equation inventory, conventions-and-units table,
frozen reference-value table, test skeleton, and a traceability ledger — with a
deterministic gate after every phase. The pipeline exists because the failure
modes of agent-built packages are known and specific:

| AI failure mode | Phase that blocks it |
| --- | --- |
| hallucinated algorithm / equation ("from memory") | extraction (verbatim + locator per item; memory is not a source) |
| wrong convention / units / normalization | extraction (conventions and units are first-class items) |
| a port of reference code presented as an independent check | reimplementation (origin=fresh required; ports never count) |
| citation from memory, prior art never searched | survey (novelty must name the strongest prior statement found) |
| numbers never cross-validated against published values | reference-check (recomputed comparisons, diagnostic tolerances) |
| performance / reliability asserted, never gated | composite-gates (three sibling verdicts must pass or be explicitly waived) |
| internal construction narrative leaking into the public artifact | closeout (scrub-lexicon sweep, executed README examples, resolved ledger) |

This skill is an **orchestration layer**. It does not re-implement literature
search, derivation checking, numerical gating, benchmarking, or multi-model
review — it sequences the existing skills and adds the bridge artifacts plus
one gate executor.

## What it composes (and what is genuinely new)

| Phase | Existing skill doing the work | This skill adds |
| --- | --- | --- |
| survey | `deep-literature-review` (systematic sweep), `citation-triangulation` (verify prior-art statements resolve) | the reuse-vs-build decision record + its gate |
| extraction | `claim-grounding` (statement-support verification of extracted items) | the span-anchored extraction manifest + its gate |
| skeleton | — | package hygiene gate, traceability ledger, export map |
| reimplementation | `derivation-verify` (symbolic pieces of the SPEC), `review-swarm` (independent reviewer verdicts) | clean-room SPEC discipline + independence gate |
| reference-check | `numerical-reliability-gate` (reference-reproduction discipline) | recomputed value-vs-published gate + reference-asset isolation |
| composite-gates | `derivation-verify`, `numerical-reliability-gate`, `julia-perf` | one gate that refuses to close while any verdict is missing, failed, or silently waived |
| closeout | `review-swarm` (final review) | executed-README gate, scrub sweep, ledger resolution |

Deduplication: `deep-literature-review` ends at a survey — it does not produce
code. `research-harness` governs an existing project — it does not bridge
literature to a new package skeleton. The genuinely new content is the bridge:
extraction manifests, the traceability ledger, the clean-room independent
reimplementation gate, and the reference cross-validation gate.

## The gate executor

Every phase produces one JSON artifact (schemas: `references/contract.md`) and
is closed by:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/literature-to-package" ] && echo "$r/skills/literature-to-package" && break; done || true)}"
python3 "${SKILL_DIR}/scripts/gates/check_phase.py" \
  --phase <survey|extraction|skeleton|reimplementation|reference-check|composite-gates|closeout> \
  --artifact <phase_artifact.json> \
  --package-root <package_dir> \
  --out-json <verdict.json>
```

Exit 0 pass / 1 fail / 2 input error; machine verdict
(`literature_to_package_gate_result_v1`) on stdout. **The caller never
self-judges a phase** — numeric comparisons are recomputed by the gate, and a
phase advances only on exit 0. Templates for every artifact live in
`assets/templates/`.

## The seven phases

**1 · survey (reuse-vs-build).** Run `deep-literature-review` over the target
papers and the surrounding method literature; for every component the package
would contain, record searches, the strongest existing statement found, and a
build/reuse/wrap decision (`survey_decision_v1`). Verify prior-art statements
resolve with `citation-triangulation`. Discipline: an originality claim must
name the strongest prior statement a focused search produced; "no public code
found" is a search result and never becomes an originality argument.

**2 · extraction (span-anchored).** Extract every equation, algorithm,
convention, constant, and parameter the package will encode into
`extraction_manifest_v1`: verbatim span + source + locator per item, units
mandatory for constants and parameters. Conventions and units are the most
error-prone, most load-bearing content a package inherits — extract them as
first-class items, not as footnotes. Run `claim-grounding` on load-bearing
items to verify the spans actually support the normalized forms the package
adopts. Model memory is not a source.

**3 · skeleton.** Generate the package skeleton: directory layout, typed API
stubs, README, test skeleton, and the **traceability ledger**
(`traceability_ledger.json`) in which every artifact entry points to
extraction items or to a reuse source — nothing enters the package without an
origin. The gate (`skeleton_manifest_v1`) enforces zero machine-specific paths,
README + test skeleton presence, a non-empty ledger, and the export map:
every export carries a documentation anchor and a test-skeleton leg.

**4 · reimplementation (clean-room, independent).** For each method: write a
clean-room SPEC **from the literature** (never from reference code), then
produce at least two implementations with `origin: "fresh"` that do not load
each other or the reference code. Route symbolic pieces of the SPEC through
`derivation-verify`; obtain an independent reviewer verdict via `review-swarm`
(Markdown `VERDICT: READY` or JSON `PASS`). The gate
(`independence_manifest_v1`) refuses ports claiming independence — a port is a
transcription of the thing under test, not an independent path. When two
implementations disagree, locate the first diverging intermediate quantity by
tracing both paths; never settle by majority vote, never re-run until
agreement.

**5 · reference-check.** Cross-validate computed values against published
reference values (`reference_check_v1`): the gate recomputes every comparison,
requires a diagnostic tolerance (no coarser than the declared uncertainty
scale, which itself must not exceed the combined quoted errors), and requires
at least two distinct representations across the checks — agreement within one
representation cannot expose a representation-level error. Reference originals
(the paper's supplemental code, an upstream solver used only for comparison)
may feed benchmarks and tests but must never appear in runtime dependencies.
Freeze the passing values into the package's committed reference-value table:
they become the regression anchors of the new package.

**6 · composite-gates.** Collect the three sibling verdicts side by side
(`composite_gates_v1`): the `derivation-verify` output (all claims converged),
the `numerical-reliability-gate` matrix (nothing not-reliable), and the
performance verdict (`julia-perf` for Julia packages; the equivalent
performance gate elsewhere). Any gate that does not apply is waived
**explicitly with a reason** — a silent omission fails.

**7 · closeout.** The public boundary: README examples exist **and were
executed** (non-empty logs); the project-declared scrub lexicon (words that
narrate the private construction history rather than the science) appears
nowhere in the public tree; no machine-specific path anywhere in the final
tree — with nothing excluded, so reference originals must not ship; every
traceability-ledger entry is `verified` or `reused`, never `pending`. Publish
only fully re-derived code; the origin narrative cites the primary literature.

## Honesty invariants

- Phase order is the pipeline order; later phases assume earlier verdicts
  exist. Do not skip phases; do not run gates on stale artifacts.
- Waivers are explicit and carry reasons. Blind spots (unreadable files,
  truncated scans) are findings, not skips.
- The coupling checks are detectors, not proofs — that is exactly why the
  independent reviewer verdict is part of the reimplementation gate
  (see `references/contract.md`, Approximations).

## Products (the "initial framework")

Directory skeleton · typed API stubs · equation inventory (extraction items of
kind equation/algorithm) · conventions-and-units table (kind
convention/constant/parameter) · frozen reference-value table (the passing
reference-check rows) · test skeleton (one leg per export) · traceability
ledger (every artifact → extraction items or reuse source, with verification
status).
