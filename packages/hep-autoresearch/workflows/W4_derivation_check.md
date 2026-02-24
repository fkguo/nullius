# W4 — Derivation + consistency checks

Chinese version: `workflows/W4_derivation_check.zh.md`.

## Goal

Make upstream analytic definitions (that feed numerics) verifiable by default:
- no skipped steps (when doing an independent derivation), OR
- deterministic “SSOT extraction → structured representation → element-by-element compare” artifacts.

Downstream numerical checks are not meaningful if the upstream analytic object is wrong.

## Inputs

- a target definition (e.g., potential matrix, Green’s function, matching equation)
- the claimed source of truth (LaTeX snapshot, notebook derivation, or both)

## Outputs (artifacts)

Required:
- structured representation of the derived object (e.g. matrix elements)
- comparison artifacts (element-by-element; include symmetry/invariants)

## Gates (acceptance)

- If the object should satisfy invariants (symmetry/trace/limits), enforce them as nontrivial diagnostics.
- If the check is purely trivial bookkeeping, it must not be the only regression anchor.

## Extension roadmap

- v1: richer SSOT extraction from TeX sources (and optional PDF evidence).
- v2: cross-tool symbolic checks (e.g. via `hep-calc`) to reduce human algebra errors.

