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

Pass-through options:
  --force
  --allow-nested
  --runtime-only
  --checkpoint-interval-seconds <seconds>

Use --project-root <path> to target a root explicitly.
`,
  run: `autoresearch run --workflow-id <id> [options]

Execute exactly one bounded step through the canonical TS run front door.

Options:
  --workflow-id <id>         "computation" or the persisted state.workflow_id
  --run-id <id>              Defaults to current state.run_id when set
  --run-dir <path>           Computation only; defaults to <project_root>/<run_id>
  --manifest <path>          Computation only; defaults to <run_dir>/computation/manifest.json
  --dry-run                  Validate only; do not execute steps

Behavior:
  Requires an initialized external project root (\`autoresearch init\`).
  Computation requests A3 approval when gate_satisfied.A3 is absent.
  Persisted workflow-plan steps execute one dependency-satisfied step at a time.
  Workflow-step execution requires a configured local MCP stdio server via \`AUTORESEARCH_RUN_MCP_COMMAND\`
  plus optional \`AUTORESEARCH_RUN_MCP_ARGS_JSON\` / \`AUTORESEARCH_RUN_MCP_ENV_JSON\`.

Output:
  JSON execution result is written to stdout.
`,
  status: `autoresearch status

Show the current lifecycle state for the nearest project root.

Options:
  --json   Emit machine-readable JSON.
`,
  approve: `autoresearch approve <approval_id>

Approve the pending gate for the current project root.

Options:
  --note "..."   Record a ledger note with the approval.
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
  Execution happens later through \`autoresearch run\`, one persisted step at a time.

Output:
  JSON workflow plan is still written to stdout.
`,
};

export function renderHelp(topic: string | null): string {
  if (!topic) return MAIN_HELP;
  return COMMAND_HELP[topic] ?? MAIN_HELP;
}
