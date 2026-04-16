import { AUTORESEARCH_PUBLIC_COMMAND_INVENTORY } from './cli-command-inventory.js';

const MAIN_COMMAND_USAGE = AUTORESEARCH_PUBLIC_COMMAND_INVENTORY
  .map(entry => `  ${entry.usage}`)
  .join('\n');

const MAIN_HELP = `autoresearch

Canonical generic lifecycle and workflow-plan entrypoint for the Autoresearch control plane.

Commands:
${MAIN_COMMAND_USAGE}

Global options:
  --project-root <path>   Override the target external project root.
  -h, --help              Show help.

Notes:
  - workflow-plan resolves checked-in literature workflow recipes into bounded steps.
  - workflow-plan persists executable planning metadata into \`.autoresearch/state.json#/plan\`.
  - \`run\` remains the only execution front door: computation manifests run natively, while persisted workflow-plan steps execute through a configured MCP tool caller.
  - Pipeline A parser support commands \`doctor\`, \`bridge\`, and \`literature-gap\` are deleted.
  - Retired-public maintainer helpers \`method-design\` and \`run-card\` are deleted; only \`branch\` remains on the provider-local internal parser.
`;

const COMMAND_HELP: Record<string, string> = {
  init: `autoresearch init

Bootstrap a real external project root and initialize .autoresearch state.

Behavior:
  Always writes the project-local fallback launcher at \`.autoresearch/bin/autoresearch\`.
  That wrapper keeps \`autoresearch status --json\` as the canonical recovery command even when
  \`autoresearch\` is unavailable on PATH for a fresh external project.

Pass-through options:
  --force
  --allow-nested
  --runtime-only
  --checkpoint-interval-seconds <seconds>

Use --project-root <path> to target a root explicitly.
`,
  run: `autoresearch run --workflow-id <id> [options]

Execute a bounded run slice through the canonical TS run front door.

Options:
  --workflow-id <id>         "computation" or the persisted state.workflow_id
  --run-id <id>              Defaults to current state.run_id when set
  --run-dir <path>           Computation only; defaults to <project_root>/<run_id>
  --manifest <path>          Computation only; defaults to <run_dir>/computation/manifest.json
  --dry-run                  Validate only; do not execute steps

Behavior:
  Requires an initialized external project root (\`autoresearch init\`).
  Computation requests A3 approval when gate_satisfied.A3 is absent.
  Persisted workflow-plan steps advance in a bounded loop until completion or a blocking failure is reached.
  A \`connection_scan\` step with an empty \`recids\` paper set is skipped with a structured no-input result instead of being reported as a tool failure.
  Workflow-step execution requires a configured local MCP stdio server via \`AUTORESEARCH_RUN_MCP_COMMAND\`
  plus optional \`AUTORESEARCH_RUN_MCP_ARGS_JSON\` / \`AUTORESEARCH_RUN_MCP_ENV_JSON\`.

Output:
  JSON execution result is written to stdout.
`,
  verify: `autoresearch verify --run-id <id> --status <passed|failed|blocked> --summary "..." --evidence-path <path> [options]

Record one decisive verification result for an existing computation run.

Options:
  --run-id <id>                 Required run identifier whose canonical computation_result_v1 should be updated
  --status <passed|failed|blocked>
                                Required decisive verification result to record
  --summary "..."               Required human-readable verification summary
  --evidence-path <path>        Required; repeatable evidence file path(s) within the run dir
  --check-kind <kind>           Optional check kind; defaults to decisive_verification
  --confidence-level <level>    Optional low|medium|high; defaults to medium
  --confidence-score <0..1>     Optional confidence score
  --notes "..."                 Optional operator note recorded into the verification check artifact

Behavior:
  Requires an initialized external project root (\`autoresearch init\`).
  Materializes \`verification_check_run_v1\`, refreshes verdict/coverage truth, and enriches \`computation_result_v1.verification_refs.check_run_refs\`.
  This is a local single-user verification front door, not a REP / multi-agent interaction surface.

Output:
  JSON verification result summary is written to stdout.
`,
  'final-conclusions': `autoresearch final-conclusions --run-id <id> [options]

Evaluate whether a completed run is ready for the higher-conclusion A5 boundary.

Options:
  --run-id <id>         Required run identifier whose canonical computation_result_v1 should be checked
  --note "..."          Optional operator note recorded if an A5 approval request is created

Behavior:
  Requires an initialized external project root (\`autoresearch init\`).
  Reads the canonical \`artifacts/computation_result_v1.json\` and its typed verification refs.
  Only a decisive gate \`pass\` creates a pending A5 approval request.
  \`hold\`, \`block\`, and \`unavailable\` fail closed and do not create pending approval state.
  After the request exists, \`autoresearch approve <approval_id>\` consumes A5 into a local \`final_conclusions_v1\` artifact instead of resuming the run.

Output:
  JSON readiness or approval-request result is written to stdout.
`,
  'proposal-decision': `autoresearch proposal-decision --proposal-kind <repair|skill|optimize|innovate> --proposal-id <id> --decision <accepted_for_later|dismissed|already_captured> [options]

Record one local decision for the current run's current proposal.

Options:
  --proposal-kind <repair|skill|optimize|innovate>
  --proposal-id <id>
  --decision <accepted_for_later|dismissed|already_captured>
  --note "..."          Optional operator note

Behavior:
  Requires an initialized external project root (\`autoresearch init\`).
  Validates that the current run has a matching current proposal artifact for the requested kind.
  Writes local decision memory into \`.autoresearch/proposal_decisions_v1.json\`.
  Does not mutate the proposal artifact itself.
`,
  status: `autoresearch status

Show the current lifecycle state for the nearest project root.

Options:
  --json   Emit machine-readable JSON.

Behavior:
  Includes current-run lifecycle truth plus a thin project-level recent digest for recent runs,
  latest final conclusions, latest proposals, and the latest active team summary when readable.
  When \`state.json#/plan\` exists but derived \`.autoresearch/plan.md\` is missing or stale, status rebuilds the plan view from state and reports a structured warning instead of showing an empty plan.
  Status JSON also includes the legacy-stable \`resume_context\`, the richer \`recovery_context\`,
  and \`current_run_workflow_outputs\` so a reconnecting agent can recover the current run,
  reuse bounded workflow outputs, and fall back to \`.autoresearch/bin/autoresearch status --json\`
  when the canonical \`autoresearch\` command is not available on PATH.
`,
approve: `autoresearch approve <approval_id>

Approve the pending gate for the current project root.

Options:
  --note "..."   Record a ledger note with the approval.

Behavior:
  Non-A5 approvals resume the run as before.
  An A5 approval consumes the first post-A5 higher-conclusion consumer, writes \`artifacts/runs/<run_id>/final_conclusions_v1.json\`, and leaves the run \`completed\`.
`,
  pause: `autoresearch pause

Pause the current run for the current project root.

Options:
  --note "..."   Record a ledger note with the pause.
`,
  resume: `autoresearch resume

Resume the current paused run for the current project root.

Options:
  --note "..."   Record a ledger note with the resume.
  --force        Allow resume from terminal states (idle/completed/failed).
`,
  export: `autoresearch export

Bundle run artifacts into a zip archive for the current project root.

Pass-through options:
  --run-id <id>
  --out <zip-path>
  --include-kb-profile

Behavior:
  Export summary output includes the same project-level recent digest carried by status/export read models
  when ledger and recent artifacts are readable.
  Current-run export also includes \`current_run_workflow_outputs\`, \`current_run_resume_context\`,
  and \`current_run_recovery_context\` when a run is active.
`,
  'workflow-plan': `autoresearch workflow-plan --recipe <recipe_id> [options]

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
  --run-id <id>
  --preferred-provider <id>   Repeatable
  --allowed-provider <id>     Repeatable
  --available-tool <name>     Repeatable

Behavior:
  Requires an initialized external project root (\`autoresearch init\`).
  Persists the resolved plan into \`.autoresearch/state.json#/plan\`.
  Derives \`.autoresearch/plan.md\` from the persisted plan.
  Execution happens later through \`autoresearch run\`, which advances ready persisted steps in a bounded loop.

Output:
  JSON workflow plan is still written to stdout.
`,
};

export function renderHelp(topic: string | null): string {
  if (!topic) return MAIN_HELP;
  return COMMAND_HELP[topic] ?? MAIN_HELP;
}
