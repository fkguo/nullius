# Changelog

Notable changes to autoresearch-lab. The format follows
[Keep a Changelog](https://keepachangelog.com/). The project is **pre-1.0**: all
workspace packages move in lockstep on a single `0.x` version, breaking changes may
occur in any `0.x` release, and there is no API-stability promise yet. Dated, tagged
releases begin at the first published release; until then the current development
version is the lockstep number below.

## [Unreleased]

### Added
- **`research-writer`: manuscript result-traceability gate.** `check_result_traceability.py`
  binds every included figure and every origin-anchored result number in a manuscript to a
  traceability manifest entry carrying `run_id`, `code_rev` and `env_fingerprint`, with
  checksum verification and manuscript-root containment. Fails closed; exemptions are
  per-id only; structural failures are never exemptible. `figure-hygiene` cross-references
  the manifest as the figure-side instance of its reproduction bundle.
- **`research-harness`: opt-in independent reproduction check.** A manifest-declared entry
  command is re-run in a pristine checkout (worktree-first isolation) and declared expected
  values are compared under explicit tolerances; only full reproduction exits zero. Closes
  the accidental-contamination channels (uncommitted manifests, stale artifacts, environment
  leakage of original-tree code, escaping symlinks) and declares its threat model — accidental
  contamination, not adversarial manifests — on all limitation surfaces. Cross-referenced from
  `numerical-reliability-gate` G8 as that gate's strongest execution form.
- **`review-swarm`: opt-in two-phase review protocol.** With `--two-phase`, each reviewer
  first sees only a scope packet (no diff) and commits a declared-review-criteria block, then
  reviews the full diff against its own commitment; the contract checker requires every
  BLOCKING finding to land in a declared category or carry an explicit criteria-revision
  declaration. CLI-flag-only (project config cannot silently enable it); the single-phase
  default path is unchanged.
- **`citation-triangulation` skill.** Offline deterministic comparator for one citation's
  canonical metadata across two or more scholarly indexes (title folding across LaTeX/Unicode,
  author family-name sequences, year, normalized DOI); verdicts consistent / conflicted /
  insufficient_sources fail closed. Registered in the skills-market index and ecosystem manifest.
- **`numerical-reliability-gate` skill.** A convergence/reliability gate for numerical results (fits,
  integrals, eigenvalues, roots/poles): fold only values stable under refinement (G1, with coarse-grid
  mirage detection), agreed across `>=2` orthogonal methods (G2), validated by a method-agnostic
  invariant where available (G3, e.g. an argument-principle winding count over fixed-seed / threshold
  heuristics), regression-anchored to a known reference (G4), and degeneracy-honest (G5). Emits an
  auditable reliability matrix. The numerical sibling of `derivation-verify` (symbolic) and `julia-perf`
  (speed); registered in the skills-market index. Distilled from the f1(1420) three-body reproduction.

### Changed
- **`literature-survey` contract: saturation is now evidence-backed, not asserted.**
  `coverage.saturation = "saturated"` is only legal when recorded expansion rounds support it
  (final round screened at least one candidate and admitted zero new core papers); assemble and
  parse both mechanically downgrade unsupported claims to `coverage_incomplete` with a visible
  reason. `deep-literature-review` documents the per-round measurement procedure and lists
  fabricated round data as an integrity violation.
- **`claim-grounding` contract: `numeric_match` is now executable.** New
  `compareNumericClaim` helper (absolute / relative / uncertainty-multiple tolerance policies);
  a tolerance wider than the combined stated uncertainties yields `incomparable`, never
  `within_tolerance` (a falsification-gate instance). The stored `numeric_comparison` verdict is
  recomputed from recorded inputs on both assemble and parse; a computed mismatch mechanically
  downgrades the grounding verdict to `conflicting`; silently omitting uncertainties requires an
  explicit auditable attestation; stored numeric scalars must be finite.
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
