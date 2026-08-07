import { NULLIUS_PUBLIC_COMMAND_INVENTORY } from './cli-command-inventory.js';
import { FINAL_CONCLUSIONS_HELP, REPORT_VALIDATE_HELP } from './cli-conclusion-help.js';
import { APPROVE_HELP, PAUSE_HELP, RESUME_HELP, STATUS_HELP } from './cli-lifecycle-help.js';
import { INIT_HELP } from './cli-scaffold-help.js';

const MAIN_COMMAND_USAGE = NULLIUS_PUBLIC_COMMAND_INVENTORY
  .map(entry => `  ${entry.usage}`)
  .join('\n');

const MAIN_HELP = `nullius

Canonical generic lifecycle and workflow-plan entrypoint for the Nullius control plane.

Commands:
${MAIN_COMMAND_USAGE}

Global options:
  --project-root <path>   Override the target external project root.
  -h, --help              Show help.

Notes:
  - \`nullius\` is the stateful CLI front door; \`orch_*\` is the MCP/operator counterpart of the same control plane.
  - Provider MCP surfaces stay bounded atomic operators instead of being mirrored into provider-local CLI shells.
  - workflow-plan resolves checked-in literature workflow recipes into bounded steps.
  - workflow-plan persists executable planning metadata into \`.nullius/state.json#/plan\`.
  - \`run\` remains the only execution front door: computation manifests run natively, while persisted workflow-plan steps execute through a configured MCP tool caller.
  - Pipeline A parser support commands \`doctor\`, \`bridge\`, and \`literature-gap\` are deleted.
  - Retired-public maintainer helpers \`method-design\` and \`run-card\` are deleted; only \`branch\` remains on the provider-local internal parser.
`;

const COMMAND_HELP: Record<string, string> = {
  init: INIT_HELP,
  run: `nullius run --workflow-id <id> [options]

Execute a bounded run slice through the canonical TS run front door.

Options:
  --workflow-id <id>         "computation" or the persisted state.workflow_id
  --run-id <id>              Defaults to current state.run_id when set
  --run-dir <path>           Computation only; defaults to <project_root>/artifacts/runs/<run_id>
  --manifest <path>          Computation only; defaults to <run_dir>/computation/manifest.json
  --dry-run                  Validate only; do not execute steps

Behavior:
  Requires an initialized external project root (\`nullius init\`).
  Computation requests A3 approval when gate_satisfied.A3 is absent.
  Computation stamps the run's code origin automatically at launch (after approval, before the first step) when the run dir sits under artifacts/runs/ or team/runs/; the outcome is reported as \`origin_stamp\` in the result and never blocks execution. A same-tree relaunch is not re-stamped; a relaunch on changed code reports \`stale_stamp\` and asks for a fresh run id.
  Persisted workflow-plan steps advance in a bounded loop until completion or a blocking failure is reached.
  A \`connection_scan\` step with an empty \`recids\` paper set is skipped with a structured no-input result instead of being reported as a tool failure.
  Workflow-step execution requires a configured local MCP stdio server via \`NULLIUS_RUN_MCP_COMMAND\`
  plus optional \`NULLIUS_RUN_MCP_ARGS_JSON\` / \`NULLIUS_RUN_MCP_ENV_JSON\`.

Output:
  JSON execution result is written to stdout.
`,
  verify: `nullius verify --run-id <id> --status <passed|failed|blocked> --summary "..." --evidence-path <path> --checker-path <path> --checker-runtime python3 --quantity-id <id> --layer-id <id> --reference-provenance-json <object> --disputed-dimension <name> --required-negative-control-id <id> [options]

Record one decisive verification result for an existing computation run.

Options:
  --run-id <id>                 Required run identifier whose canonical computation_result_v1 should be updated
  --status <passed|failed|blocked>
                                Required operator expectation; must exactly match the checker verdict
  --summary "..."               Required non-authoritative operator note; it cannot replace the checker summary
  --evidence-path <path>        Required; repeatable evidence file path(s) within the run dir
  --checker-path <path>          Required Python or Node checker script within the run dir
  --checker-runtime <token>     Required bare native runtime token: python, python3[.X], or node
  --checker-helper-path <path>  Optional; repeat for every top-level local checker helper
  --quantity-id <id>            Required identifier for the exact checked quantity
  --layer-id <id>               Required identifier for the implementation/representation layer checked
  --reference-provenance-json <object>
                                Required; repeatable JSON object with reference_id, uri, and sha256
  --disputed-dimension <name>   Required; repeatable normalization/component/etc. dimension under dispute
  --required-negative-control-id <id>
                                Required; repeatable negative-control identifier the verdict must report
  --check-kind <kind>           Requested checker-kind expectation; defaults to decisive_verification; the emitted matching value is recorded
  --confidence-level <level>    Optional low|medium|high; defaults to medium
  --confidence-score <0..1>     Optional confidence score
  --notes "..."                 Optional operator note recorded into the verification check artifact

Behavior:
  Requires an initialized external project root (\`nullius init\`).
  Nullius resolves and hashes the canonical native runtime, directly spawns the checker without a shell under a sanitized fixed environment, and appends fixed \`--nullius-request\` and \`--nullius-verdict\` arguments. For a Python checker with declared helpers, the checker directory is recorded as the sanitized Python module search path while unsafe implicit path insertion remains disabled. Runtime paths, wrappers, aliases, shells, eval, pipelines, redirects, and extra argv are rejected.
  Quantity, layer, reference provenance, disputed dimensions, and negative controls have no implicit defaults and must be supplied explicitly. The checker must emit \`validation_checker_verdict_v1\` whose request hash matches the Nullius-generated request and whose self-reported output observations match the requested production paths and internally held hashes. A recorded pass does not prove that the checker actually opened those paths or executed the named negative controls. The CLI status is only an expectation that must equal the checker verdict; the CLI summary is a non-authoritative note; the canonical summary and matching check kind are read from the checker verdict. Nullius then writes and later revalidates \`validation_chain_binding_v1\`.
  The receipt contains adjacent production snapshots and a literal incomplete dependency-closure status; it is not a syscall/import/installed-byte closure. A5 currently remains unavailable. The final-conclusions consumer also supports exactly one canonical subject, verdict, and coverage artifact.
  Legacy caller-authored \`--validation-chain-receipt\` input is rejected for decisive verification.
  This is a local single-user verification front door, not a REP / multi-agent interaction surface.

Output:
  JSON verification result summary is written to stdout.
`,
  'final-conclusions': FINAL_CONCLUSIONS_HELP,
  'report-validate': REPORT_VALIDATE_HELP,
  'proposal-decision': `nullius proposal-decision --proposal-kind <repair|skill|optimize|innovate> --proposal-id <id> --decision <accepted_for_later|dismissed|already_captured> [options]

Record one local decision for the current run's current proposal.

Options:
  --proposal-kind <repair|skill|optimize|innovate>
  --proposal-id <id>
  --decision <accepted_for_later|dismissed|already_captured>
  --note "..."          Optional operator note

Behavior:
  Requires an initialized external project root (\`nullius init\`).
  Validates that the current run has a matching current proposal artifact for the requested kind.
  Writes local decision memory into \`.nullius/proposal_decisions_v1.json\`.
  Does not mutate the proposal artifact itself.
`,
  decision: `nullius decision <record|pending|list|land>

Record human decisions made in conversation into a project ledger.

Actions:
  record "<what was decided>" [--by <who>] [--resolves <id>] [--relates <id>]
                         Append a decided entry. --resolves closes one open pending
                         entry; --relates adds independent non-closing context.
  pending "<open question>" [--by <who>] [--relates <id>]
                         Append an open item; --relates does not close its target.
  list [--json]          Print the ledger with open items partitioned out.
  land [--json]          On the authoritative trunk, assign durable D<n> ids,
                         canonicalize retained handle references, and print mappings.

Behavior:
  record, pending, and land require an initialized external project root (\`nullius init\`);
  list reads permissively and reports "no decisions recorded" on an uninitialized root.
  record and pending append one JSON line to \`.nullius/decisions.jsonl\` under a short
  cross-process lock. Each new entry gets a six-character random Crockford-base32 handle.
  Its raw draw has 30 unbiased bits (32^6 = 2^30 ≈ 1.07 billion), chosen without
  coordination as a branch-local, machine-facing identity, never a durable prose citation.
  Candidates spelling durable D<n> ids, current ids, or retained mappings are redrawn, so
  exact pair-collision probability depends on the local exclusions. With none it is
  1/(2^30 - 90,000) ≈ 9.314e-10, slightly above 1/2^30: probabilistic, not structural,
  and merged collisions fail closed below. The timestamp stays in \`ts\`, not the handle.
  Existing D<n> ledgers remain valid with zero migration: their entries stay readable,
  counted in status, and resolvable by the ids already cited elsewhere.
  land is the sole rewrite: after branch tails are integrated on the authoritative trunk,
  it assigns the next D<n> values in trunk file order, rewrites relation targets that name
  provisional ids, retains each old identity as \`provisional_id\`, self-validates the
  complete result, and commits it with one durable atomic replacement. It also cleans up
  late handle-valued relations through retained mappings; re-running it on an already
  canonical ledger is a no-op. ULIDs emitted by the immediately preceding release are
  accepted as provisional ids and land the same way.
  A non-no-op land refuses a ledger with no write permission bit. A last-moment source
  check catches edits made while the replacement is prepared, but POSIX has no portable
  compare-and-swap rename, so a non-cooperating writer can still race that final check.
  If replacement succeeds but parent-directory durability cannot be confirmed, land
  reports the commit status as uncertain: inspect with \`decision list\` using the same
  project root, then rerun land there. A canonical no-op retry fsyncs the parent directory,
  confirming the visible entry instead of merely observing it.
  --resolves only accepts a currently OPEN pending entry (unknown, decided, and
  already-resolved targets are rejected), and refuses an id the file carries twice.
  --relates accepts any earlier readable entry, including a decided standing directive,
  and never changes open_count. record may carry both links; pending may carry --relates.
  On read, a malformed, ambiguous, forward, replayed, or semantically inapplicable
  persisted relation is reported under \`unrecognized_relations\` and ignored, while its
  containing entry remains counted, listed, and addressable. The reader fails closed on
  the link, not the record. Persisted legacy or unknown string kinds likewise remain
  readable: only exact \`pending\` creates an open obligation; every other unknown spelling
  is conservatively normalized to current \`decided\` semantics, including an otherwise
  valid closing relation, with \`source_kind\` and \`normalized_kinds\` making the
  compatibility mapping explicit.
  Duplicate detection is form-agnostic: list exits non-zero and names the lines when the
  ledger carries an id twice, or when one retained provisional id maps to more than one
  entry (including reuse as a current id). New relations refuse an ambiguous target, and
  land changes no bytes until the ambiguity is repaired. Provisional entries are valid
  and remain in every status count.
  The status receipt is diagnostic and does not gate the run/approve lifecycle.
  Works in both execution modes: it replaces hand-built decision ledgers, giving
  file-mode projects an engine-visible record of conversational
  approvals. Open entries surface in the status receipt until a later
  \`decision record --resolves <id>\` closes them (all counted; the oldest ten itemized,
  the remainder via \`decision list\`).
  --by defaults to "user". Text beginning with a hyphen goes after the conventional
  end-of-options terminator: \`nullius decision record -- "-keep the negative branch"\`.
`,
  status: STATUS_HELP,
  trace: `nullius trace stamp <run_dir> [--dep name=path] [--event-id <ulid>] [--actor <who>]
nullius trace supersede <old_run_id> --by <new_run_id> --reason "..." [--scope <name>] [--event-id <ulid>] [--actor <who>]
nullius trace void <run_id> --reason "..." [--scope <name>] [--event-id <ulid>] [--actor <who>]
nullius trace reinstate <run_id> --reason "..." [--event-id <ulid>] [--actor <who>]

Write surface of run origin stamps and the project validity ledger
(artifacts/runs/validity_ledger.jsonl, append-only, never rewritten).

stamp: bind a run directory to the exact code state that produced it.
  Records baseline commit, a pinned snapshot of tracked modifications
  (refs/nullius/runs/*), the snapshot tree hash, and honest binding quality:
  exact_clean | exact_tracked_snapshot | head_plus_untracked | unbound.
  Untracked files are counted and sampled, never auto-ignored and never
  silently treated as exact. The ledger event is authoritative; the
  run-directory run_origin.json is a browsing mirror.
  Run stamp at run creation, before the run loads code.

supersede / void / reinstate: validity beyond execution status.
  supersede is declared by the NEW run's author about the OLD run
  (superseded_by is derived at read time; old run directories are never
  edited). --reason is required prose: why the result no longer counts
  (or counts again). --scope other than "full" records a named partial
  supersession that annotates but never flips overall validity.

--event-id reuses a previously minted ULID when retrying the SAME logical
  event (crash recovery); a payload mismatch under a reused id is refused.

backfill: retroactive origin stamps for legacy runs, by timestamp alignment
  against the commit history. HEURISTIC by construction — every record is
  binding_quality aligned_heuristic (never exact) with its alignment
  evidence (window, nominal-timestamp flag, ambiguous candidates), or
  honestly unbound with a reason. Validity is NEVER backfilled.

propose-chains / confirm-chains: same-slug round chains (r1 → r2 → …, the
  measured review-driven redo pattern) become a PROPOSAL file
  (artifacts/runs/round_chain_proposal.json). Nothing touches the ledger
  until you review it (delete pairs you reject) and run confirm-chains,
  which appends the supersede events under your actor identity.
`,
  current: `nullius current [--json]

Answer, as prose a human reads directly: what the current best result is,
which exact code revision produced it, where the current manuscript is,
which notebook sections are current vs stale, and which runs are still
valid vs superseded or void.

Clauses the project cannot answer are stated explicitly every time (no
repository; unclassified legacy runs; stages not yet delivered) — honest
unanswerability instead of silent or false precision. --json emits the same
read model that \`nullius status --json\` carries as its traceability block.
`,
  result: `nullius result set-current <result-id> --run <run_id> --artifact <path> [--description "..."] [--supersedes <result-id>]

Register or update a row of the current-results registry in project_index.md
(the RESULT_REGISTRY block): the project's answer to "what is the current
best result". Selection is research judgment, made at milestone convergence;
the machine enforces structure and liveness:
  - the named run must carry an origin stamp and be ACTIVE in the validity
    ledger (not superseded, not void, not quarantined);
  - the artifact must exist; its SHA-256 is computed and registered;
  - --supersedes updates both direction columns, keeping the chain
    consistent like the report registry;
  - result ids are unique; a superseding row leaves exactly one current row
    per chain.
Hand edits stay legal; \`nullius status --json\` / \`nullius current\`
validate the block either way.
`,
  release: `nullius release <target-dir> [--commit <sha>] [--tag <name>] [--actor <who>] [--dry-run]

Export a public snapshot of the project's CODE at a chosen commit into an
empty directory outside the project root, so it can seed a public repository
whose history starts clean at version one. The internal repository keeps the
full history; the exported commit gets a local tag (default public-vN,
auto-incremented, never reused or moved) and the release is recorded on the
decisions ledger — the mapping between public version and internal revision
is pinned twice.

Defaults to HEAD and then requires a clean working tree; --commit names any
exact revision (including a run's snapshot commit) and skips that check.

A fixed exclusion list keeps run products, machine state, and internal
process files out of the export — and the receipt PRINTS which of them were
actually present in the exported tree, so nothing is dropped silently:
  artifacts/, team/runs/, .nullius/, host-agent dirs (.claude/ etc.),
  research_plan.md, research_notebook.md, research_contract.md,
  project_index.md, AGENTS.md, CLAUDE.md

No network side effects: creating the public repository, adding a
reader-facing README and LICENSE, and pushing remain explicit human steps
(the receipt lists them). --dry-run previews the commit, tag, and
exclusions without writing anything.
`,
  approve: APPROVE_HELP,
  pause: PAUSE_HELP,
  resume: RESUME_HELP,
  export: `nullius export

Bundle run artifacts into a zip archive for the current project root.

Pass-through options:
  --run-id <id>
  --out <zip-path>
  --include-kb-profile

Behavior:
  Export summary output includes the same project-level recent digest carried by status/export read models
  when ledger and recent artifacts are readable.
  Current-run export also includes \`current_run_workflow_outputs\`, \`current_run_workflow_outputs_source\`, \`current_run_resume_context\`,
  and \`current_run_recovery_context\` when a run is active.
  Export summary also includes \`project_surface_drift\`, mirroring the status read model's diagnostic-only project-root warnings.
  Export fails closed when no substantive payload is available, instead of reporting a hollow success.
`,
  'workflow-plan': `nullius workflow-plan --recipe <recipe_id> [options]

Resolve a checked-in literature workflow recipe into a bounded executable plan.

Options:
  --phase <phase>
  --query <text>
  --topic <text>
  --seed-recid <recid>
  --analysis-seed <value>
  --recid <recid>              Repeatable
  --project-id <id>
  --paper-id <id>
  --run-id <run_id>            Recommended for meaningful external research runs
  --preferred-provider <id>   Repeatable
  --allowed-provider <id>     Repeatable
  --available-tool <name>     Repeatable

Behavior:
  Requires an initialized external project root (\`nullius init\`).
  Use a safe, readable project-local run_id such as \`20260502T023000Z-m3-branch-scan-r1\`.
  If omitted, workflow-plan derives \`<recipe>-<phase>\` only as a planning placeholder.
  Persists the resolved plan into \`.nullius/state.json#/plan\`.
  Derives \`.nullius/plan.md\` from the persisted plan.
  Execution happens later through \`nullius run\`, which advances ready persisted steps in a bounded loop.

Output:
  JSON workflow plan is still written to stdout.
`,
  graph: `nullius graph --kind <claims|progress|literature|roadmap> [options]

Render a domain-neutral dependency graph from research artifacts via the shared
graph-viz engine. Output is Graphviz DOT (the portable source of truth) plus an
optional PNG/SVG when Graphviz \`dot\` is installed.

Kinds and their required inputs:
  --kind claims      Claim DAG (what we believe): requires --claims <claims.jsonl> --edges <edges.jsonl>
  --kind progress    Plan / progress dependency graph (milestones + tasks): requires --plan <research_plan.md|progress.json>
  --kind literature  Citation / reference network: requires --input <records+edges JSON>
  --kind roadmap     Milestone/lane roadmap dependency-map (planning view): requires --spec <roadmap JSON>

Options:
  --out-dir <dir>          Output directory (default: current directory). Writes <kind>.dot (+ .png/.svg).
  --format <dot|png|svg>   Raster/vector format to also emit; DOT is always written. Default: dot.
  --rank-dir <LR|TB>       Graph direction. Default: LR.
  --legend <auto|embedded|none>
                           Legend placement; auto embeds for small graphs. Default: auto.
  --no-color               Disable color styling (accessibility encodings remain).
  --json                   Emit graph metadata + DOT as JSON to stdout instead of writing files.

Behavior:
  Each kind maps to one adapter in @nullius/shared/graph-viz; node fill encodes
  status and edge style encodes the relationship kind. PNG/SVG are best-effort: when
  Graphviz is absent the DOT is still written and a warning is printed.

Output:
  Writes <out-dir>/<kind>.dot (+ optional .png/.svg), or JSON to stdout with --json.
`,
};

export function renderHelp(topic: string | null): string {
  if (!topic) return MAIN_HELP;
  return COMMAND_HELP[topic] ?? MAIN_HELP;
}
