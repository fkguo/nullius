import { NULLIUS_PUBLIC_COMMAND_INVENTORY } from './cli-command-inventory.js';

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
  init: `nullius init

Bootstrap a real external project root and initialize .nullius state.

Behavior:
  Always writes the project-local fallback launcher at \`.nullius/bin/nullius\`.
  That wrapper keeps \`nullius status --json\` as the canonical recovery command even when
  \`nullius\` is unavailable on PATH for a fresh external project.
  --refresh re-applies the current managed scaffold doc (AGENTS.md),
  backing up any changed file under \`.nullius/backups/<timestamp>/\` before overwriting it.
  Refresh never writes user-owned files (research_plan.md, research_notebook.md,
  research_contract.md, project_charter.md, project_index.md,
  reports/main_research_report_template.md). Pair with --dry-run to preview.

Existing-project main-report migration:
  Checkpoint the project first. Refresh AGENTS.md, then render a fresh scaffold
  in a separate temporary external root with \`nullius init --project-root <temporary-root>\`.
  Copy only a missing reports/main_research_report_template.md from that root;
  never overwrite an existing copy. Manually merge the temporary
  project_index.md#Main research report section and empty registry into the
  existing user-owned project_index.md. Refresh does not perform either step.
  Until the registry exists and points to a populated current report,
  \`nullius report-validate\` fails closed with invalid_registry_markers or
  no_current_report.

Pass-through options:
  --force
  --refresh
  --dry-run        With --refresh: preview what would change without writing.
  --allow-nested
  --runtime-only
  --checkpoint-interval-seconds <seconds>
  --mode <engine|file>   Declare where project truth lives. engine: the nullius
                         run/approve lifecycle drives the project. file: work is
                         executed by hand or external runners, durable truth lives in
                         research_plan.md / research_contract.md and dated run
                         directories, and run_status legitimately stays idle.
                         Works on an already-initialized root (including with
                         --runtime-only) to declare or change the mode; recorded in
                         .nullius/state.json and surfaced by the status receipt.
                         Without --mode the project stays undeclared and status may
                         hint when the evidence looks file-mode.

Use --project-root <path> to target a root explicitly.
`,
  run: `nullius run --workflow-id <id> [options]

Execute a bounded run slice through the canonical TS run front door.

Options:
  --workflow-id <id>         "computation" or the persisted state.workflow_id
  --run-id <id>              Defaults to current state.run_id when set
  --run-dir <path>           Computation only; defaults to <project_root>/<run_id>
  --manifest <path>          Computation only; defaults to <run_dir>/computation/manifest.json
  --dry-run                  Validate only; do not execute steps

Behavior:
  Requires an initialized external project root (\`nullius init\`).
  Computation requests A3 approval when gate_satisfied.A3 is absent.
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
  'final-conclusions': `nullius final-conclusions --run-id <id> [options]

Evaluate whether a completed run is ready for the higher-conclusion A5 boundary.

Options:
  --run-id <id>         Required run identifier whose canonical computation_result_v1 should be checked
  --note "..."          Optional operator note recorded if an A5 approval request is created

Behavior:
  Requires an initialized external project root (\`nullius init\`).
  Reads the canonical \`artifacts/computation_result_v1.json\` and its typed verification refs.
  The consumer currently supports exactly one canonical subject, verdict, and coverage artifact.
  Every current validation binding declares an incomplete dependency/import closure, so A5 currently returns \`unavailable\` and creates no approval request even when the checker self-reports pass.
  \`hold\`, \`block\`, and \`unavailable\` fail closed and do not create pending approval state.
  The generic A5 approval consumer remains implemented for a future complete-closure path; it is not reachable from current validation bindings.

Output:
  JSON readiness or approval-request result is written to stdout.
`,
  'report-validate': `nullius report-validate

Validate the single promoted main research report for an external project.

Behavior:
  Reads the main-report registry in project_index.md and fails closed when no
  current report is promoted, a checkpoint/status summary is structurally
  incomplete, a historical report no longer matches its registered SHA-256,
  the supersession chain or current pointer is stale, human-readable evidence
  is replaced by machine references, authoring instructions remain in the
  researcher-facing report, or same implementation plus same input is labeled
  independent. Environment differences do not make that replay independent.
  Report and registry structure counts only when it is visible Markdown;
  fenced code and ordinary HTML comments cannot supply markers, fields,
  validation records, current pointers, or registry rows. Required report
  fields must occur exactly once in their authoritative section.
  The check is structural. A pass does not establish scientific sufficiency.

Output:
  main_research_report_v1 validation JSON is written to stdout.
`,
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
  decision: `nullius decision <record|pending|list>

Record human decisions made in conversation into an append-only project ledger.

Actions:
  record "<what was decided>" [--by <who>] [--resolves <id>]
                         Append a decided entry; --resolves closes an open pending entry.
  pending "<open question>" [--by <who>]
                         Append an open item that still needs a decision.
  list [--json]          Print the ledger with open items partitioned out.

Behavior:
  record and pending require an initialized external project root (\`nullius init\`);
  list reads permissively and reports "no decisions recorded" on an uninitialized root.
  Appends one JSON line per event to \`.nullius/decisions.jsonl\` (ids D1, D2, ...); never
  rewrites, and takes a short cross-process lock so concurrent recordings get distinct ids.
  --resolves only accepts a currently OPEN pending entry (unknown, decided, and
  already-resolved targets are rejected).
  Works in both execution modes and never gates any command: it replaces hand-built
  decision ledgers, giving file-mode projects an engine-visible record of conversational
  approvals. Open entries surface in the status receipt until a later
  \`decision record --resolves <id>\` closes them (all counted; the oldest ten itemized,
  the remainder via \`decision list\`).
  --by defaults to "user". Text beginning with a hyphen goes after the conventional
  end-of-options terminator: \`nullius decision record -- "-keep the negative branch"\`.
`,
  status: `nullius status

Show the current lifecycle state for the nearest project root.

Options:
  --json   Emit machine-readable JSON.

Behavior:
  Includes current-run lifecycle truth plus a thin project-level recent digest for recent runs,
  latest final conclusions, latest proposals, and the latest active team summary when readable.
  When \`state.json#/plan\` exists but derived \`.nullius/plan.md\` is missing or stale, status rebuilds the plan view from state and reports a structured warning instead of showing an empty plan.
  Status JSON also includes the legacy-stable \`resume_context\`, the richer \`recovery_context\`,
  and \`current_run_workflow_outputs\` so a reconnecting agent can recover the current run,
  reuse bounded workflow outputs, and fall back to \`.nullius/bin/nullius status --json\`
  when the canonical \`nullius\` command is not available on PATH.
  Status JSON also includes \`project_surface_drift\`, a diagnostic-only warning block for stale legacy scaffold surfaces or optional host-local guidance noise in the current project root.
  Status JSON also includes \`execution_mode\` (declared via \`nullius init --mode=<engine|file>\`; null when never declared) and \`decision_ledger\`, the conversational-decision record with any still-open items.
  When durable workflow outputs are missing for an older run, status rebuilds a best-effort legacy workflow projection from ledger/artifact conventions and reports the projection source.
`,
approve: `nullius approve <approval_id>

Approve the pending gate for the current project root.

Options:
  --note "..."   Record a ledger note with the approval.

Behavior:
  Non-A5 approvals resume the run as before.
  A generic A5 consumer exists for a future complete-dependency-closure path, but current validation bindings leave A5 unavailable and cannot create that pending approval.
`,
  pause: `nullius pause

Pause the current run for the current project root.

Options:
  --note "..."   Record a ledger note with the pause.
`,
  resume: `nullius resume

Resume the current paused run for the current project root.

Options:
  --note "..."   Record a ledger note with the resume.
  --force        Allow resume from terminal states (idle/completed/failed).
`,
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
