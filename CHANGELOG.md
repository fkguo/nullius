# Changelog

Notable changes to nullius. The format follows
[Keep a Changelog](https://keepachangelog.com/). The project is **pre-1.0**: all
workspace packages move in lockstep on a single `0.x` version, breaking changes may
occur in any `0.x` release, and there is no API-stability promise yet. Dated, tagged
releases begin with 0.6.0, the first release archived on Zenodo; `CITATION.cff` names
the version to cite.

## [Unreleased]

## [0.6.0] - 2026-10-16

First archived release. Nullius is positioned as an evidence-first harness for
agent-assisted research; this release gathers everything since 0.5.0 (the lockstep
version was never tagged). Headline themes: result traceability from run to commit,
a machine-enforced closeout discipline for notebooks and results, fail-closed review
and delegation contracts, and consolidated run authority under one canonical
`artifacts/runs/<run_id>/` layout.
### Removed
- **hep-mcp modules no entry reaches.** The hep-mcp source modules that no
  declared entry or launcher imported (the removed discovery, preprocessing,
  survey and research pipelines, with their discovery contracts in
  `@nullius/shared`) are deleted.
- **hep-mcp keeps no runs of its own.** Runs, approvals and lifecycle belong to
  the orchestrator (`<project_root>/artifacts/runs/<run_id>/`). Removed tools:
  `hep_run_create`, `hep_run_read_artifact_chunk`, `hep_run_clear_manifest_lock`,
  `hep_run_stage_content`, `hep_run_build_writing_evidence`,
  `hep_run_build_measurements`, `hep_run_build_citation_mapping`,
  `hep_run_ingest_skill_artifacts`, `hep_project_compare_measurements`,
  `hep_project_query_evidence_semantic`, `hep_render_latex`, `hep_export_project`,
  `hep_export_paper_scaffold` and `hep_import_paper_bundle`, with the modules only
  they used, the `hep://runs/...` identifiers, the workflow recipes
  `derivation_cycle` and `review_cycle`, the `computation_evidence_catalog_item_v1`
  schema and the `WRITING_PROGRESS_DIR` setting. A `run_id` argument is refused by
  every hep-mcp tool. Historical hep run directories stay readable in place;
  `docs/URI_REGISTRY.md` gives the rule for resolving historical `hep://runs/...`
  references to files.
- **hep-mcp keeps no paper/evidence projects, evidence catalogs or papers cache.**
  Removed tools: `hep_project_create`, `hep_project_get`, `hep_project_list`,
  `hep_project_build_evidence`, `hep_project_query_evidence`,
  `hep_project_playback_evidence`, `hep_admin_import_paper`,
  `hep_admin_migrate_papers_cache`, `hep_admin_prune_paper_cache` and
  `hep_admin_link_kb_notes` (with their command-line entry points), the
  user-global papers cache, the `hep://projects/...` identifiers, the
  `literature_to_evidence` workflow recipe with its `materialize.evidence_build`
  action, the `evidence_catalog_item_v1` schema and the
  `HEP_BUDGET_EVIDENCE_MAX_PARAGRAPH_LENGTH` setting. Paper sources are read with
  `arxiv_paper_source` / `inspire_paper_source`; `literature_landscape` takes the
  recipe's place in the documented literature entry point. Historical project
  directories and evidence catalogs stay readable in place; `docs/URI_REGISTRY.md`
  gives the rule for resolving historical `hep://projects/...` references to files
  and where to read the catalog item format.


### Added
- **Large run outputs outside git history.** `skills/research-harness/scripts/run_storage.py`
  gains `check`, `stow`, `verify`, `materialize` and `inventory`: bulk outputs under
  the run roots are stowed in a content store outside any git worktree, the
  originals become read-only, and a tracked hash manifest records them; `verify`
  and `materialize` restore or check them in another worktree. Research outputs
  are classified before a commit or a pinned snapshot admits them, so bulk run
  products stay out of history behind the manifest; a reserved file name alone
  grants no exemption, only a validated stow record does. Two read-only commands
  measure before anything is deleted: `worktree-check` says whether removing a
  linked worktree loses anything (uncommitted and hidden tracked changes, a
  changed executable bit even with `core.filemode` off, untracked and unique
  ignored files, per-worktree refs, commits only its own records remember unless
  their patch text is byte-identical to a base commit, private git state it
  does not understand) and prints the removal command only when it does not;
  `report` estimates the bytes removal may free (duplicate content by allocated
  blocks, regenerable directories, git copies and bundles whose reachable
  objects a reference repository already holds, with unreachable objects in a
  copy counted but not compared, stale temporary roots) and lists every path it
  could not examine.
- **Per-package test temp roots.** Every vitest package runs in a private temp
  root that is removed on a clean pass, kept on failure or interruption, and swept
  only when it carries the package's own marker.
- **Julia package and performance standards.** The `julia-package` skill covers
  modules and extensions, public APIs, numerical contracts, dependencies,
  concurrency, tests, documentation and release readiness; `julia-perf` reworks
  its benchmark protocol and environment references, adds a structured/device-work
  reference and a test suite, rewrites the `run_perf.jl` driver with its suite
  template and config, and validates the origin of the baseline that benchmark
  evidence is compared against; the optimization-equivalence lock pins the skill's
  new error-budget wording.
- **Final display semantics gate for figures and tables.** `figure-hygiene` checks
  the final rendered output after overrides, conversions, rounding and
  translations (extending `check_display_acceptance.py` with the
  `display_semantics.py` helper and a reference on reader selection and quantity
  identity); a lock ties the gate's coverage to the skill text.
- **DeepSeek Harness task runner.** `dsh-cli-runner` dispatches a bounded
  file-prompt task through the installed `dsh` headless CLI to an explicitly
  selected provider/model, captures the raw session, rejects incomplete output,
  and refuses CLI versions whose contracts have not been checked; running
  through it does not make the model DeepSeek or establish family independence.
- **Unreachable-module check for hep-mcp.** `check:unreachable-modules` (in CI)
  fails when a source module is reached from no declared entry or allowlisted
  root, following imports through extensionless launchers.
- **Repository positioning, citation, and license.** The identity sentence on every
  public surface (READMEs, positioning document, status page, root package
  description, and the front-door wording lock) now reads "an evidence-first harness
  for agent-assisted research"; "monorepo" remains only where it describes the
  repository layout. A Citation section in both READMEs and a root `CITATION.cff`
  support "Cite this repository" and Zenodo archiving. The MIT license that
  `package.json` and the README had declared is now present as a `LICENSE` file.
- **Result traceability (`nullius trace`, `nullius result`, `nullius current`).** Every
  run binds to the exact code state at launch through origin stamps written at every
  mandatory machine moment (computation front door, team-cycle run creation, result
  registration at convergence); an append-only validity ledger records `void` /
  `supersede` / `reinstate` rulings with normalized, existence-checked run ids; a
  results registry (`nullius result set-current`) names the producing run per headline
  result; `nullius current` renders the whole current-version answer as prose.
  Exploratory runs are organized into code-state episodes and slug-stem families.
- **Attempt/run separation.** A run id is an experiment slot; each execution is an
  attempt with its own launch-time code capture. Resultless crashes retry under the
  same id through one atomic ledger event; anything that delivered never takes the
  cheap path.
- **Browsable run index.** A machine-owned `RUN_INDEX` block in `project_index.md`
  renders the ledger per slug family (counts, validity split, latest run, starred
  current results with verdicts), refreshed by every ledger-writing verb and adoptable
  via `nullius index sync`; its honesty footer reports conflicting stamps, chain
  defects, and vanished directories unconditionally.
- **Notebook discipline, machine layer.** A managed current-state block in the
  research notebook (`nullius notebook sync`), drift detection between notebook and
  registered results, and dead-link confirmation; `nullius notebook check` reports
  structural links and current full-text content review separately.
- **Human notebook integration at result closeout.** Scientific result closeout now
  requires the human notebook to be updated and an executed whole-notebook review
  (`nullius notebook review`) accepted; automatic tables, links, and checklists cannot
  supply that verdict. Review inputs are bound completely (notebook intervals, original
  dependencies, capacity and execution limits) and reproduction evidence must be blind,
  separately constructed, and separately executed; historical evidence stays readable
  without granting current acceptance.
- **`nullius release`** exports a public code snapshot with pinned bookkeeping,
  excluding run products and internal notes.
- **Decision ledger** (`nullius decision record|pending|land|list`): conversational
  decisions and open questions recorded with branch-safe minted ids, landed to durable
  `D<n>` ids on the trunk; open questions stay counted in every status receipt.
- **Launch authorization gate (A3) for production compute** (research-harness): a
  frozen plan hash, hash-bound review verdicts, and an exact environment fingerprint
  must agree before a large production run may start; voided verdicts neither count
  nor veto.
- **Delegation budget contract** (research-team / research-harness): every delegated
  workstream declares a tolerance ceiling with its anchor, a time box, an attempt cap,
  a scope negative list, and a memory estimate (measured dry-run peak RSS for compute
  launches, or a declared cap for short bounded workstreams); the gate fails closed on
  missing or malformed fields.
- **Verification granularity reform** (research-team): severity-graded convergence
  with mandatory dispositions, two retry regimes with bounded rounds and stall
  detection, delta-scoped confirmation rounds bound to a baseline, scoped cross-family
  review, and a fold-boundary disposition gate wired into the cycle runner; reviewer
  unavailability is a dispatch failure, not a consumed round. The follow-up
  process-audit batches add candidate-commit binding (OID pinning, range refusal,
  artifact byte comparison), review-lane independence accounting (credit decided from
  the resolved post-fallback backend; failed lanes hold no comparison seat), a
  machine-enforced bounded-rounds brake, and delegations-directory hygiene.
- **Verification provenance and hep-calc handoffs** hardened across the orchestrator,
  shared contracts, schemas, and the `hep-calc` skill.
- **Literature bibliography reconciliation**: literature identity provenance and a
  trace gate shared by research-team, idea-posterior, and literature-workflows.
- **File-mode projects as first-class citizens** (`nullius init --mode=engine|file`):
  projects whose work is executed by hand or by external runners declare that mode,
  keep status receipts honest about an idle engine, and record decisions made in
  conversation in the ledger described below.
- **Event-to-workflow verification routing**: the scaffold's `AGENTS.md` carries a
  domain-agnostic table from observable research events to the verification workflow
  each one triggers.
- **Source-transcription fidelity** (review-swarm): candidate-withheld source
  extraction, an input manifest with SHA-256 digests, and a review-freshness gate.
- **Idea lifecycle state machine**: a first-class state enum with legal-transition
  validation, entry preconditions wired to the close-prior gate, and single-writer
  posterior derivation; idea-allocation and idea-posterior follow the machine's states.
- **skill `literature-to-package`**: turn a literature survey into the verified initial
  framework of a software package (skeleton, typed API stubs, equation inventory,
  conventions table, frozen reference values).
- **Cross-family review by construction**: review-swarm, derivation-verify, and
  paper-reviser stop hard-coding a claude+gemini pair and frame reviewers as "the
  host's own family plus a different family"; Kimi Code is a first-class runner and a
  supported skills-market host.
- **Reuse-or-deviate gate and review-verification contract clauses**: per-asset
  reuse-or-deviate decisions, independent recomputation from blind inputs with the
  probed axes recorded, and discriminating power computed before a check is trusted.
- **Figure-hygiene display-acceptance gate**: durable or outward-facing figures are
  refused until every plotted quantity is bound to a verification verdict and an
  all-component human-review overview is archived; continuity, knob-threading,
  optimization-equivalence, and post-correction-recomputation gates join the
  numerical-reliability contract, each with an anti-drift lock.
- **Verification-methodology lessons in the skills**: a transcription-audit axis,
  certified-domain discipline, defect impact maps with identity controls, fail-closed
  display substitution, and the knob-invariance blind spot (analytic-layer decisions
  invisible to discretization axes) are now operationalized in research-integrity and
  numerical-reliability-gate.
- **Citation-verification hardening**: `citation-triangulation` gains a one-command
  record fetch (`fetch_citation_records.py`), fail-closed identity checks,
  relation-aware title folding, and a book path; `claim-grounding` treats attribution
  and priority claims as their own claim type; `hep-mcp` makes author-list truncation
  explicit in every paper view and author omissions are preserved rather than
  silently completed.
- **Portable installations.** Skills compose with the project, literature, and idea
  MCP services through the installed runtime; per-user paths and credentials stay out
  of distributed payloads, sensitive files are rejected during installation, and
  runtime configuration lives in a host-private `runtime.json`.
- **Delegated agent runtime hardening**: attempts recorded as `not_started` /
  `outcome_unknown` / `committed`, unknown side effects stop for reconciliation,
  committed MCP results replayed without re-dispatch, exact delegation stopping
  predicates, and separate journal namespaces for direct and team runs.
- **Idea-engine: grounding-audit write path and scoped provenance correction**
  (RPC contract 2.1.0). `node.set_grounding_audit` becomes the only sanctioned
  write path for node grounding-audit records — it stores the result of an
  independently produced grounding check with a mandatory `report_ref` naming
  the record it summarizes, stamps the timestamp engine-side, and is legal in
  the same review window as posterior writes; honest fail/partial results are
  recordable data, and `node.promote` keeps gating on `pass`. A campaign-store
  audit had flagged that promotion was unreachable without direct store edits,
  which are not a sanctioned path. `node.rewrite_provenance` corrects a single
  allowlisted provenance field on generated nodes — currently
  `novelty_delta.closest_prior`, whose contract requires a URI or survey ref
  key of the closest prior work rather than a campaign node id (the recorded
  defect that motivated the method). The corrected value is validated against
  the node's own retrieval receipts (URI-shaped values must be receipted; node
  and idea ids are rejected), the engine-assembled novelty-delta card claim is
  rewritten in the same mutation so card and trace cannot diverge, and every
  correction is appended to the engine-owned, import-reserved
  `operator_trace.inputs.provenance_rewrites` history while the archived
  generation pack retains the original value — original (content-pinned) →
  corrections → current stays auditable. Both methods carry prepared/committed
  idempotency with crash-recovery probes; node `grounding_audit` records (and
  the C2 handoff embedding them) gain an optional `report_ref`.
- **Citation-triangulation: benchmark-validated admission and identifier
  disciplines.** The comparator now folds a trailing version suffix on
  preprint-registry (`10.48550/arxiv.`) DOIs, whose DataCite identifier is
  version-agnostic, with negative controls locking that distinct identifiers
  never merge and that the fold never fires outside that registrant prefix.
  SKILL.md gains three operating rules validated in a public benchmark
  evaluation of the skill as a citation-hallucination detector: a same-work
  admission rule for fetched records (identifier equality, or a strong title
  match, or a weak title match plus a shared author family name — retrieval
  admission at least as strict as the comparison it feeds), interpretation
  guidance for identifier-only disagreement (a preprint-registry DOI and a
  publisher DOI are two legitimate identifiers of one work), and an advisory
  preprint-presented-as-published check that stays outside the verdict. The
  comparator's test suite is now wired into CI.
- **Evidence-first idea-posterior reasoning and complete IR binding.** The
  standalone detailed page now reconstructs static evidence-to-conclusion
  paths from the compiled IR, showing concrete observations, authored
  likelihood rationales, structural criterion updates, and both supporting
  and lowering effects before Gaia's raw model report. Raw Gaia diagrams are
  labelled as generative probability-model graphs whose hypothesis-to-evidence
  arrows are distinct from reader evidence flow. The package contract now
  requires `__all__ = ["worth"]` and checks that `worth` is the unique exported
  conclusion at extraction, rendering, and writeback. Package references and
  detailed-page manifests bind the exact `.gaia/ir.json` bytes, covering
  exported-root metadata omitted by Gaia 0.5.0a4's internal `ir_hash`; older
  packages and references migrate by setting the export, marking authored
  infer explanations with `reader_reasoning:`, declaring each observation's
  evidence family and correlation model, and re-extracting.
  Infer rationales use an explicit `reader_reasoning:` authorship sentinel;
  generic criterion prose and anchor-only notes cannot satisfy that contract.
  Raising `tension_resolution` updates now require an explicit idea-specific
  `resolution_evidence` class, so evidence that merely establishes an open
  tension or proposes a future check cannot masquerade as successful
  resolution. Writeback cross-checks the matrix's recorded tension grade(s)
  against the compiled IR and rejects matrices that declare themselves stale;
  reviewer guidance also treats repeated observations with a shared cause as
  one evidential source rather than independent votes. Observe rationales now
  carry explicit `evidence_family` and `correlation_model` declarations;
  a family can contribute only one composite observation on one path to the
  exported conclusion because Gaia's separate likelihoods otherwise multiply
  even when their arrows meet at one claim. The reader page discloses every
  family occurrence and whether it can affect the posterior.
- **Argument-graph field-audit fixes + generation-bound deep-dive links.**
  From the first real-project render audit (data fidelity fully clean; all
  defects presentation-layer): grade chips are placed collision-free by a
  deterministic post-routing pass; card statements are never shortened
  (cards grow with their text — the audit's clipped statements were scope
  limits); narrow viewports open at a readable scale floor and pan; source
  anchors are whitelist-classified into links (http(s) and relative
  Markdown paths only, fragment-aware, plain character set) versus plain
  machine-readable text. Each card's detail panel now deep-links its exact
  case-preserving node section in a self-contained,
  directly local-file-readable `docs/detailed-reasoning.html`. A PEP 723
  standalone renderer uses Pandoc for Markdown and MathML, Mermaid CLI for
  static embedded SVG, and pinned nh3/Ammonia sanitization; raw HTML, active
  URL schemes, event handlers, and scripts cannot enter the page. A manifest
  written last binds
  exact SHA-256 digests of current beliefs, compiled IR, Markdown, and HTML.
  The graph independently verifies all four, so missing, edited, malformed, or stale
  artifacts yield no deep-dive link. Editing the Markdown requires the
  documented HTML-then-argument-graph regeneration order; every optional
  render remains non-fatal to posterior extraction.
- **Statement-first argument-graph render (`argument-graph.html`).**
  `skills/idea-posterior/scripts/render_argument_graph.py` renders a compiled
  and inferred Gaia package (`.gaia/ir.json` + `.gaia/beliefs.json`) into one
  self-contained interactive HTML page: every node card carries the node's
  full statement (variable labels only as small card headers), each `infer`
  is drawn as an arrow from the evidence into the claim it updates — solid
  blue when it raises belief, dashed warm red when it lowers it, line width
  plus a weak/substantial/strong chip carrying the likelihood ratio — and
  clicking a card opens the statement, posterior, likelihoods P(e|h) and
  P(e|not h), rationale, and source anchors. Deterministic layout computed at
  render time (observed evidence → intermediate claims → root claim), no
  external dependencies, light/dark themes. `run_infer_and_extract.py` now
  emits this page after inference instead of gaia's `starmap.html` (the
  superseded page is removed; `starmap.svg` and the detailed-reasoning
  `docs/` render are unchanged), and the portfolio status report links
  `argument-graph.html`.
- **Third-party agent roster (`agents.json`) + roster-wired review panels.**
  A user-level (`~/.nullius/agents.json`) or project-level
  (`.nullius/agents.json`) file declares each model family's execution runner
  and model strings, a `cross_family_minimum` policy floor, and an honest
  degradation to native subagents when the roster cannot field that floor —
  documented in `docs/AGENTS_FILE.md` with a template at
  `docs/examples/agents.example.json`. `review-swarm`, `derivation-verify`, and
  `idea-pairwise-match` resolve their panel composition from the roster;
  explicit CLI arguments still win, a missing file behaves exactly as
  native-only, and unavailable families are recorded absent rather than
  silently substituted. The `pairwise_match_v1` artifact records the panel
  independence level (cross-family vs single-family native).
- **`node.import_generated` — the derived-node entry point of the idea engine.**
  One `generation_pack_v1` per generation burst (candidates with full provenance
  PLUS the operator's own rejected candidates with reasons); a committed
  operator-family arity table (`LiteratureMining` / `Mutation` / `Recombination` /
  `AnalogyTransfer` / `FailureRouting`); retrieval-receipt coverage of every
  evidence URI and a hard ban on the seed placeholder URI; survey-tension anchors
  and re-anchored gap anchors; non-novel `delta_type` rejection; engine-side
  deterministic idea-card assembly sharing the seed import's sanitize/hash
  authority (promote-gate compatible by construction); batch-atomic `max_nodes`
  budget enforcement; verbatim pack archival; and import-specific crash recovery
  that completes partially landed effects from the archived pack instead of
  re-minting ids.
- **skill `idea-generation`** — the Explain-stage generation discipline:
  evidence-delta triggers (`survey_updated` / `failure_recorded` / `manual`
  enabled; the rest reserved vocabulary), one candidate per structurally distinct
  anchor with per-anchor and per-burst quotas, mechanical dedup against every
  campaign node AND within the burst (deterministic hashed char-3-gram cosine
  with an exact normalized-text short-circuit; ≥ 0.95 auto-drop, ≥ 0.80 flagged
  pending human override), novelty stated as a falsifiable closest-prior delta
  claim (never an LLM novelty score), and pack assembly + submission scripts
  (stdlib Python ≥ 3.9) with anti-drift locks that read the engine contract at
  test time.
- **Adversarial-review hardening of the import path** (six-lens review, every
  confirmed finding fixed): the placeholder ban now scans every string in a
  candidate ("anywhere" means anywhere — gap anchors, receipts, references,
  novelty fields); `rationale_draft.references` and URI-shaped
  `novelty_delta.closest_prior` join the receipt-coverage rule; non-V0 operator
  families (`Mutation` / `Recombination` / `AnalogyTransfer`) are
  engine-rejected (`operator_family_not_enabled`) until their evidence
  disciplines land — prose is not a gate; LiteratureMining packs must pin the
  mined survey (`evidence_snapshot_missing`); recorded parent revisions must be
  ones the parent actually had (`parent_revision_invalid`); exact intra-pack
  twins (`intra_pack_duplicate`) and self-contradictory dedup records
  (`dedup_inconsistent`) are refused; prompt snapshots are now real
  end-to-end — archived inside the pack and hash-verified at import
  (`prompt_snapshot_missing`); the engine copies `novelty_delta`, the dedup
  record, and `target_admission_route` onto the node's trace and restates the
  delta as an auditable `llm_inference` card claim; pack artifact filenames are
  collision-guarded; node-log appends heal torn trailing lines instead of
  gluing onto them; stale campaign locks from provably dead processes are
  reclaimed and genuinely held locks surface as `store_locked` instead of a
  misleading schema error; `build_pack.py` fails closed on unknown dedup
  decisions, misaligned report indexes, and overrides that match nothing.

### Changed
- **Staged writes at fresh exclusive names.** Shared atomic writes, the openalex
  bulk export and content download, the idea-engine store and recovery log,
  arxiv-mcp extraction, download and rate-limit state, and graph-viz output stage
  at an unpredictable name created exclusively, check file identity before commit
  and cleanup, and commit by rename then directory fsync (new
  `writeChunksAtomicDurable`); the atomic-write lock scans every package,
  recognises import-bound write calls, and excuses the remaining sites line by
  line. Path containment at the remaining two-dot sites (idea-mcp, idea-engine,
  openalex-mcp, hep-mcp) uses the exact escape test; openalex-mcp compares real
  candidate with real parent.
- **The home directory is never a project root.** The shared harness-invocation
  verifier skips it (its `~/.nullius/` holds user-level data, not project state),
  and the CLI project-root search compares real paths so an alias of the home
  directory is still the home directory.
- **Process groups are signalled only while their leader is unreaped.** The
  orchestrator's MCP client runs each server under a Node anchor that owns the
  server's process group and stops it (SIGTERM, grace, SIGKILL) when the client
  goes away, so a reused group number is never signalled; a transport failure is
  reported with its cause on every tool-call path, and a server ended by a signal
  is named. The Python supervisors (the claude, kimi and opencode process budgets,
  the gemini runner, the independent reproduction check, `run_multi_task.py` and
  its smoke helper) wait for a CLI without reaping it (kqueue on macOS, `waitid`
  with `WNOWAIT` on Linux), signal its group, reap last on every path, own
  `SIGCHLD`, and treat a child reaped elsewhere as unsupervisable.
- **hep-mcp research-output tools take a caller-chosen `output_dir`.**
  `hep_inspire_search_export`, `hep_inspire_resolve_identifiers`,
  `hep_import_from_zotero`, `inspire_parse_latex`, `inspire_theoretical_conflicts`
  and `inspire_search` (export mode, formerly triggered by `run_id`) write into an
  `output_dir` inside the admitted project root, reached through real directories
  only and never under `.nullius/`, `team/runs/` or `artifacts/hep-mcp/`, and return
  project-relative paths. A call never replaces an existing file, and a call that
  fails removes what it had published; if it cannot, the error names what is left
  (published files in `files_left` with an "outputs are incomplete" error, staging
  files in `staging_left` or `staging_path`, unflushed removals in
  `unflushed_directories`), and only a crash during publication
  can leave part of a set unreported (later calls naming those files are refused). These tools refuse a
  numeric limit that is not a whole number in range instead of using the default.
- Oversized hep-mcp tool results are truncated by UTF-8 bytes on a character
  boundary.
- **The computation bridge tools work only in the run's own directory.**
  `orch_run_stage_idea`, `orch_run_stage_content`, `orch_run_plan_computation`,
  `orch_run_execute_manifest` and `orch_run_progress_followups` admit
  `project_root` as every other front door does and require `run_dir` to be
  `<project_root>/artifacts/runs/<run_id>`, where the run's approval packets,
  proposals and team state are kept, so a run's records are never split; it may
  be spelled through an alias above the root, while a symbolic link below the
  root is refused, and so is one anywhere in the run directory, including every
  entry directly under `computation/`; only entries nested below the method's
  own real workspace directories under `computation/` are left to the manifest
  checks at materialization and preparation. The two staging tools
  take a required `project_root`. Workspace paths in manifests and method specs are
  refused for a `..` segment rather than for any two dots, so names such as
  `..data.csv` are accepted, and a method's files are never written through a
  symbolic link in the run directory.
- **hep-mcp reports failures that are not the caller's under their own codes.**
  A file-system failure while writing outputs or using the INSPIRE response
  cache (a full or read-only disk, a name too long, an unusable cache entry) is
  `UNSAFE_FS`; an INSPIRE answer that fails the checks of the search export or
  identifier resolution (a malformed page or record as the INSPIRE client returns
  it, a malformed recid, inconsistent pagination) is `UPSTREAM_ERROR`, marked
  `invalid_provider_answer`, and still ends the whole call instead of being
  recorded for one identifier. A
  search export that does not export every reported record gives one warning for
  the cause: `max_results` stopped it, or INSPIRE's pages ended before its total.
- **Run authority consolidated.** All newly created managed runs live under
  `artifacts/runs/<run_id>/`, with team and draft executor payloads in
  `research_team/` beneath the run. The team runner refuses any `--out-dir` other
  than the project's `artifacts` directory; the research-team RUNBOOK, project-map
  template, and prompt generators now say `--out-dir artifacts`. Historical
  `team/runs/<run_id>/` remains read-only evidence: listed, indexed, linked, and
  exported in place, never migrated or rewritten, and no new execution may reuse a
  historical id.
- **Project root is derived from the notebook's tree**, not from the physical location
  of a (possibly symlinked) team config; the config is still read through the resolved
  symlink.
- **Registration gate on projects without a launcher** reports current acceptance as
  unavailable and withholds the automatic fold instead of skipping; a missing launcher
  never grants an exemption.
- **Workflow recovery**: dispatch outcomes are persisted; pause, approval, and user
  constraints survive recovery; incomplete model output is rejected; call and deadline
  budgets are shared across retries; INSPIRE project context matches the advertised
  schema. Native computation binds an enabled A3 approval to
  the manifest, scripts, declared inputs, resolved executable bytes, environment, and
  policy; same-run continuation in place is unsupported.
- **Harness lightening** (two waves): delegation weight tiers, a science-object stall
  clock across run roots, violation quarantine that never destroys computation,
  health-aware same-tag resume, and a round-advance guard. The OMX salvage batch adds
  a manifest failure policy (`on_failure fail-fast|continue`) with fail-closed step
  gates and characterization locks for six previously untested live gate scripts.
- **Idea layer**: lifecycle demotion marks the posterior stale atomically, `rank.compute`
  is store-state aware, batched evidence-event RPCs, the Mutation operator family, a
  research-report contract, durable idea-card revision, citation-identity grounding,
  bound symbolic post-processing, and an interactive reader-surface validation
  contract; Gaia packages render without upstream Mermaid and SDK references are
  shared by version.
- **Version surfaces** move in lockstep to 0.6.0 (all workspace packages, the Python
  project-contracts package, MCP server descriptors, the compatibility matrix, and the
  skills-market catalog ranges).

### Fixed
- **A case-folded name stands in for a recorded file only when it is that file.**
  `run_storage.py check` and `stow` treated a name differing only in letter case
  from a recorded entry as that entry whenever `core.ignorecase` was set, so a
  distinct file on a case-sensitive file system carrying that setting was neither
  reported nor stowed; the fold now requires the same device and inode.
- **Complete reviewer output through capacity checks.** The Claude CLI runner
  assembles the complete, ordered assistant text from its stream log (raw tool and
  thinking events stay in the log), and the review-capacity checks in research-team,
  derivation-verify, and the notebook review batches bind that complete output by
  hash to the frozen runtime capture; a capacity verdict is unavailable unless the
  complete original output is bound.
- **Forty-nine test regressions** introduced by the run-authority consolidation
  (canonical project roots, plan timestamps, raw dispatch) are fixed at the source in
  the CLI run path, execution-plan materialization, path safety, verification, and the
  workflow runtime; eight research-team runner integration tests are brought onto the
  current contract.
- **Trace verbs** normalize path-shaped run ids, refuse ids neither disk nor ledger
  knows (nearest real ids named), and print the post-write validity, so a misaddressed
  `void` can no longer strand a run silently; control-plane paths under `.nullius/` and
  the project's own `backups/` no longer demote stamp honesty.
- **Atomic writes** across parents satisfy the durability contract (quarantine moves).
- **project-mcp** enforces harness invocation before dispatch and stops the whole
  process group on timeout.
- **Dead TeX label/reference/figure extractor** repaired (broken raw-string regexes had
  disabled that preflight); markdown-hygiene no longer flags code-labelled links as
  bare references; julia-perf suites load under Julia 1.12 world-age semantics.
- **Pairwise judge panel: votes are bound to the exact rendering they answered,
  and independence claims are mechanically backed.** Two review-driven lanes
  (six rounds and a three-round follow-up of dual cross-family review; ~19
  independently verified findings fixed between them). The panel report records
  a composite prompt digest (rendered body + judge system prompt + native
  binding-block template) that assembly recomputes and injected native replies
  must echo, failing the seat on a missing or mismatched echo; stale
  panel_valid reports are invalidated the moment execution starts. The roster's
  uniqueness rules (one dedicated route = one family; no duplicate
  (runner, model) pairs) are enforced at parse time; direct-runner execution
  identity is keyed on the physical file (device+inode), so case aliases,
  hardlinks, and env-redirected paths of one script collide; any --runner
  override among counted votes stamps independent_runners=false; project
  roster discovery stops at the git root and reports a user-level file as
  user-level even when \$HOME is itself a git repository; panel shape follows
  the documented usable-family definition (declared available AND runner
  executable present), so missing CLIs trigger the honest native degradation.
- **All three agents.json parsers reject unknown keys at every level**
  (top/family/policy, with top-level `_notes` as the one sanctioned comment
  carrier), closing the strictness split where a misspelled family field was a
  parse error for one consumer and a silently vanished field for the other two.
- **Skill artifact ids converged to the engine 8-char short-id convention.**
  `idea-pairwise-match` (validator, minting, docs, fixtures) and
  `idea-allocation` (deterministic sha256-derived `decision_id`, id validation,
  fixtures) both matched the engine schemas' `^[0123456789abcdefghjkmnpqrstvwxyz]{8}$`
  contract only on paper before; each now carries an anti-drift test that reads
  the engine schema pattern at test time, and Python-side validation uses
  `fullmatch` so a trailing newline cannot slip past the `$` anchor.
- **Cross-suite pytest collection defect**: allocation tests no longer import
  `conftest` as a module (first-loaded conftest shadowed the rest when several
  skills' suites ran in one pytest invocation).

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
