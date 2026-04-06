export type ParsedCliArgs =
  | { command: 'help'; projectRoot: string | null; topic: string | null }
  | { command: 'init' | 'export'; projectRoot: string | null; passthrough: string[] }
  | { command: 'status'; projectRoot: string | null; json: boolean }
  | { command: 'pause' | 'resume'; projectRoot: string | null; note: string | null }
  | { command: 'approve'; projectRoot: string | null; approvalId: string; note: string | null };

const HELP_FLAGS = new Set(['-h', '--help']);
const COMMANDS = new Set(['init', 'status', 'approve', 'pause', 'resume', 'export']);

function isHelpFlag(value: string): boolean {
  return HELP_FLAGS.has(value);
}

function readOptionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`missing value for ${name}`);
  }
  return value;
}

function extractProjectRoot(argv: string[]): { args: string[]; projectRoot: string | null } {
  const args: string[] = [];
  let projectRoot: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]!;
    if (current.startsWith('--project-root=')) {
      projectRoot = current.slice('--project-root='.length);
      continue;
    }
    if (current !== '--project-root') {
      args.push(argv[index]!);
      continue;
    }
    projectRoot = readOptionValue(argv, index, '--project-root');
    index += 1;
  }
  return { args, projectRoot };
}

function ensureKnownCommand(command: string): void {
  if (!COMMANDS.has(command)) {
    throw new Error(`unknown command: ${command}`);
  }
}

function parseStatusArgs(args: string[]): { json: boolean } {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    throw new Error(`unknown status argument: ${arg}`);
  }
  return { json };
}

function parseNoteArgs(command: 'pause' | 'resume', args: string[]): { note: string | null } {
  let note: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--note') {
      note = readOptionValue(args, index, '--note');
      index += 1;
      continue;
    }
    throw new Error(`unknown ${command} argument: ${arg}`);
  }
  return { note };
}

function parseApproveArgs(args: string[]): { approvalId: string; note: string | null } {
  let approvalId: string | null = null;
  let note: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--note') {
      note = readOptionValue(args, index, '--note');
      index += 1;
      continue;
    }
    if (!arg.startsWith('-') && approvalId === null) {
      approvalId = arg;
      continue;
    }
    throw new Error(`unknown approve argument: ${arg}`);
  }
  if (!approvalId) {
    throw new Error('approve requires an approval_id');
  }
  return { approvalId, note };
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const { args, projectRoot } = extractProjectRoot(argv);
  if (args.length === 0) {
    return { command: 'help', projectRoot, topic: null };
  }
  if (isHelpFlag(args[0]!)) {
    return { command: 'help', projectRoot, topic: null };
  }

  const [rawCommand, ...rest] = args;
  const command = rawCommand!;
  ensureKnownCommand(command);
  if (rest.some(isHelpFlag)) {
    return { command: 'help', projectRoot, topic: command };
  }

  switch (command) {
    case 'init':
      return { command: 'init', projectRoot, passthrough: rest };
    case 'export':
      return { command: 'export', projectRoot, passthrough: rest };
    case 'status':
      return { command: 'status', projectRoot, ...parseStatusArgs(rest) };
    case 'pause':
      return { command: 'pause', projectRoot, ...parseNoteArgs('pause', rest) };
    case 'resume':
      return { command: 'resume', projectRoot, ...parseNoteArgs('resume', rest) };
    case 'approve':
      return { command: 'approve', projectRoot, ...parseApproveArgs(rest) };
    default:
      throw new Error(`unknown command: ${command}`);
  }
}
