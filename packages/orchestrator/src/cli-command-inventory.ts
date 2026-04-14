export const AUTORESEARCH_PUBLIC_COMMAND_INVENTORY = [
  { command: 'init', usage: 'autoresearch init [options]' },
  { command: 'run', usage: 'autoresearch run --workflow-id <id> [options]' },
  { command: 'final-conclusions', usage: 'autoresearch final-conclusions --run-id <id> [--note "..."]' },
  { command: 'status', usage: 'autoresearch status [--json]' },
  { command: 'approve', usage: 'autoresearch approve <approval_id> [--note "..."]' },
  { command: 'pause', usage: 'autoresearch pause [--note "..."]' },
  { command: 'resume', usage: 'autoresearch resume [--note "..."] [--force]' },
  { command: 'export', usage: 'autoresearch export [options]' },
  { command: 'workflow-plan', usage: 'autoresearch workflow-plan --recipe <recipe_id> [options]' },
] as const;

export type AutoresearchPublicCommand =
  (typeof AUTORESEARCH_PUBLIC_COMMAND_INVENTORY)[number]['command'];

export const AUTORESEARCH_PUBLIC_COMMANDS: readonly AutoresearchPublicCommand[] =
  AUTORESEARCH_PUBLIC_COMMAND_INVENTORY.map(entry => entry.command);

const AUTORESEARCH_PUBLIC_COMMAND_SET = new Set<string>(AUTORESEARCH_PUBLIC_COMMANDS);

export function isAutoresearchPublicCommand(command: string): command is AutoresearchPublicCommand {
  return AUTORESEARCH_PUBLIC_COMMAND_SET.has(command);
}
