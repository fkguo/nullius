const MAIN_HELP = `autoresearch

Canonical generic lifecycle and workflow-plan entrypoint for the Autoresearch control plane.

Commands:
  autoresearch init [options]
  autoresearch status [--json]
  autoresearch approve <approval_id> [--note "..."]
  autoresearch pause [--note "..."]
  autoresearch resume [--note "..."]
  autoresearch export [options]
  autoresearch workflow-plan --recipe <recipe_id> [options]

Global options:
  --project-root <path>   Override the target external project root.
  -h, --help              Show help.

Notes:
  - workflow-plan resolves checked-in generic literature workflow recipes into bounded steps.
  - Workflow shells such as run/doctor/bridge remain on the transitional Pipeline A surface for now.
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

Output:
  JSON workflow plan is still written to stdout.
`,
};

export function renderHelp(topic: string | null): string {
  if (!topic) return MAIN_HELP;
  return COMMAND_HELP[topic] ?? MAIN_HELP;
}
