const MAIN_HELP = `autoresearch

Canonical generic lifecycle entrypoint for the Autoresearch control plane.

Commands:
  autoresearch init [options]
  autoresearch status [--json]
  autoresearch approve <approval_id> [--note "..."]
  autoresearch pause [--note "..."]
  autoresearch resume [--note "..."]
  autoresearch export [options]

Global options:
  --project-root <path>   Override the project root for lifecycle commands.
  -h, --help              Show help.

Notes:
  - This surface is intentionally lifecycle-only in this batch.
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
};

export function renderHelp(topic: string | null): string {
  if (!topic) return MAIN_HELP;
  return COMMAND_HELP[topic] ?? MAIN_HELP;
}
