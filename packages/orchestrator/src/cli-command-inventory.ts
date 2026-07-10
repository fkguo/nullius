export const NULLIUS_PUBLIC_COMMAND_INVENTORY = [
  { command: 'init', usage: 'nullius init [options]' },
  { command: 'run', usage: 'nullius run --workflow-id <id> [options]' },
  { command: 'verify', usage: 'nullius verify --run-id <id> --status <passed|failed|blocked> --summary \"...\" --evidence-path <path> [--evidence-path <path> ...]' },
  { command: 'final-conclusions', usage: 'nullius final-conclusions --run-id <id> [--note "..."]' },
  { command: 'proposal-decision', usage: 'nullius proposal-decision --proposal-kind <repair|skill|optimize|innovate> --proposal-id <id> --decision <accepted_for_later|dismissed|already_captured> [--note "..."]' },
  { command: 'decision', usage: 'nullius decision <record|pending|list> ["<text>"] [--by <who>] [--resolves <id>] [--json]' },
  { command: 'status', usage: 'nullius status [--json]' },
  { command: 'approve', usage: 'nullius approve <approval_id> [--note "..."]' },
  { command: 'integrity-record', usage: 'nullius integrity-record --approval-id <id> --modes <M1[,M2,...]> --notes "<summary>" [--skip <Mx:reason>[,Mx:reason]...]' },
  { command: 'pause', usage: 'nullius pause [--note "..."]' },
  { command: 'resume', usage: 'nullius resume [--note "..."] [--force]' },
  { command: 'export', usage: 'nullius export [options]' },
  { command: 'workflow-plan', usage: 'nullius workflow-plan --recipe <recipe_id> [options]' },
  { command: 'graph', usage: 'nullius graph --kind <claims|progress|literature|roadmap> [--claims <path> --edges <path> | --plan <path> | --input <path> | --spec <path>] [--out-dir <dir>] [--format dot|png|svg] [--rank-dir LR|TB] [--legend auto|embedded|none] [--no-color] [--json]' },
] as const;

export type NulliusPublicCommand =
  (typeof NULLIUS_PUBLIC_COMMAND_INVENTORY)[number]['command'];

export const NULLIUS_PUBLIC_COMMANDS: readonly NulliusPublicCommand[] =
  NULLIUS_PUBLIC_COMMAND_INVENTORY.map(entry => entry.command);

const NULLIUS_PUBLIC_COMMAND_SET = new Set<string>(NULLIUS_PUBLIC_COMMANDS);

export function isNulliusPublicCommand(command: string): command is NulliusPublicCommand {
  return NULLIUS_PUBLIC_COMMAND_SET.has(command);
}
