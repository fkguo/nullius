# Changelog

Notable changes to autoresearch-lab. The format follows
[Keep a Changelog](https://keepachangelog.com/). The project is **pre-1.0**: all
workspace packages move in lockstep on a single `0.x` version, breaking changes may
occur in any `0.x` release, and there is no API-stability promise yet. Dated, tagged
releases begin at the first published release; until then the current development
version is the lockstep number below.

## [Unreleased]

### Added
- **`numerical-reliability-gate` skill.** A convergence/reliability gate for numerical results (fits,
  integrals, eigenvalues, roots/poles): fold only values stable under refinement (G1, with coarse-grid
  mirage detection), agreed across `>=2` orthogonal methods (G2), validated by a method-agnostic
  invariant where available (G3, e.g. an argument-principle winding count over fixed-seed / threshold
  heuristics), regression-anchored to a known reference (G4), and degeneracy-honest (G5). Emits an
  auditable reliability matrix. The numerical sibling of `derivation-verify` (symbolic) and `julia-perf`
  (speed); registered in the skills-market index. Distilled from the f1(1420) three-body reproduction.

### Changed
- **`research-harness`: "anchor on the final adopted version" + reliability-gated fold-back.** Recovery
  First now resolves the *current adopted* parameters/method/configuration from the durable record (and
  any `superseded`/`voided` markers) and regression-anchors — the reference reproduces its known result —
  before trusting any variation; Fold Results Back folds in only `numerical-reliability-gate`-passing
  numbers.
- **Version lockstep at `0.3.0`.** Unified every workspace package version — plus the
  exported `VERSION` constants and the MCP server/client identity strings — to a single
  `0.3.0`, replacing ad-hoc drift across `0.0.1` / `0.1.0` / `0.3.0` (the front-door
  `@autoresearch/orchestrator` had been stuck at `0.0.1`, looking earlier than the
  libraries it owns). Versions now move together.
- Added `scripts/check-version-consistency.mjs` (CI-enforced) to keep package versions
  and `VERSION` constants locked in step.
