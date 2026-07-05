# Changelog

Notable changes to nullius. The format follows
[Keep a Changelog](https://keepachangelog.com/). The project is **pre-1.0**: all
workspace packages move in lockstep on a single `0.x` version, breaking changes may
occur in any `0.x` release, and there is no API-stability promise yet. Dated, tagged
releases begin at the first published release; until then the current development
version is the lockstep number below.

## [0.5.0] - 2026-07-05

### Changed
- **idea-engine restarted from island-evolution search + heuristic scoring to a
  probability-managed idea portfolio.** The search/eval runtime is archived (the
  `search.step` / `eval.run` executors, the built-in DomainPack subsystem, and the
  island / distributor / failure-library machinery are removed); the idea contracts
  and store are retained and evolved. `idea_node_v1` gains `posterior`,
  `lifecycle_state`, and `activation_condition` and drops `eval_info`; the
  abstract-problem registry is now caller-provided at `campaign.init` (no built-in
  domain packs); `rank.compute` ranks by an externally computed belief-graph
  posterior instead of the heuristic multi-dimensional score.
- **`idea-mcp` narrowed to the six `idea_campaign_*` lifecycle tools**, aligned to
  the restarted runtime surface.

### Added
- **skill `idea-posterior`** — decompose a research idea into source-grounded
  sub-criteria, encode a Gaia argument graph (`gaia-lang==0.5.0a4`), run exact
  inference, and write the posterior back to the idea store, under a
  parameter-honesty discipline (three fixed likelihood grades, a mandatory anchor
  on every number, MaxEnt fallback when an anchor fails review).
- **skill `idea-pairwise-match`** — criteria-committed, cross-family judged pairwise
  comparison between two idea nodes; the outcome enters the belief layer as one
  capped, non-eliminating observation. Judge input is rebuilt from validated
  structure only (anchored arguments under committed-criteria headings), never from
  verbatim author prose.
- **skill `idea-allocation`** — Thompson-sampling investment allocation from the
  posterior, plus activation-condition monitoring for waiting-activation ideas.
- **contracts** — `pairwise_match_v1` and `allocation_decision_v1` schemas.

## [0.4.0] - 2026-07-05

### Changed
- **Repository renamed: `autoresearch-lab` → `nullius`** (after the Royal Society motto
  *Nullius in verba*). One mechanical, repo-wide rename with no compatibility layer —
  the project is pre-1.0 and carries no backward-compatibility burden. Renamed surfaces:
  - package scope `@autoresearch/*` → `@nullius/*` (all 13 workspace packages, imports,
    workspace dependencies);
  - CLI front door `autoresearch` → `nullius` (bin name, help text, command inventory);
  - project state directory `.autoresearch/` → `.nullius/`, including the project-local
    launcher `.nullius/bin/nullius`, the `HARNESS` sentinel (kind
    `nullius_project_harness`) and the `HARNESS_INVOCATION` receipt (kind
    `nullius_harness_invocation`);
  - environment/constant prefix `AUTORESEARCH_*` → `NULLIUS_*`;
  - JSON-schema `$id`/`$ref` namespace `https://autoresearch.dev/...` →
    `https://nullius.dev/...` (identifier namespace only; schema content unchanged);
  - global scratch data root `~/.autoresearch/` → `~/.nullius/`.

  Existing external projects: staying on `v0.3.0` is a supported resting point. To
  migrate, rename the state directory (`mv .autoresearch .nullius`), delete the old
  launcher, run `nullius init --runtime-only` then `nullius init --refresh` from the
  project root; lifecycle state (`state.json`, `ledger.jsonl`) carries over unchanged.
  See `docs/MIGRATION.md`.
- **`kimi-cli-runner`: long-verification hardening.** New `--timeout-secs` per-attempt
  hard timeout (default 900 s, `0` disables) and `--raw-out` / `--stderr-out` options
  that preserve the last attempt's raw stdout/stderr for an auditable trace of tool
  calls, provider warnings, and partial output on long reviewer/verification runs.

## [0.3.0] - 2026-07-05

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
