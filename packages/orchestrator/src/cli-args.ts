export type ParsedCliArgs =
  | { command: 'help'; projectRoot: string | null; topic: string | null }
  | { command: 'init' | 'export'; projectRoot: string | null; passthrough: string[] }
  | {
    command: 'run';
    projectRoot: string | null;
    workflowId: string | null;
    runId: string | null;
    runDir: string | null;
    manifestPath: string | null;
    dryRun: boolean;
  }
  | { command: 'status'; projectRoot: string | null; json: boolean }
  | { command: 'pause' | 'resume'; projectRoot: string | null; note: string | null }
  | { command: 'approve'; projectRoot: string | null; approvalId: string; note: string | null }
  | {
    command: 'workflow-plan';
    projectRoot: string | null;
    recipeId: string;
    phase: string | null;
    inputs: Record<string, unknown>;
    preferredProviders: string[];
    allowedProviders: string[];
    availableTools: string[];
  };

const HELP_FLAGS = new Set(['-h', '--help']);
const COMMANDS = new Set(['init', 'run', 'status', 'approve', 'pause', 'resume', 'export', 'workflow-plan']);

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

function parseRunArgs(args: string[]): Omit<Extract<ParsedCliArgs, { command: 'run' }>, 'command' | 'projectRoot'> {
  let workflowId: string | null = null;
  let runId: string | null = null;
  let runDir: string | null = null;
  let manifestPath: string | null = null;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--workflow-id') {
      workflowId = readOptionValue(args, index, '--workflow-id');
      index += 1;
      continue;
    }
    if (arg === '--run-id') {
      runId = readOptionValue(args, index, '--run-id');
      index += 1;
      continue;
    }
    if (arg === '--run-dir') {
      runDir = readOptionValue(args, index, '--run-dir');
      index += 1;
      continue;
    }
    if (arg === '--manifest') {
      manifestPath = readOptionValue(args, index, '--manifest');
      index += 1;
      continue;
    }
    throw new Error(`unknown run argument: ${arg}`);
  }
  return { workflowId, runId, runDir, manifestPath, dryRun };
}

function parseWorkflowPlanArgs(args: string[]): Omit<Extract<ParsedCliArgs, { command: 'workflow-plan' }>, 'command' | 'projectRoot'> {
  let recipeId: string | null = null;
  let phase: string | null = null;
  const inputs: Record<string, unknown> = {
    query: '',
    topic: '',
    seed_recid: '',
    analysis_seed: '',
    recids: [],
    project_id: '',
    paper_id: '',
    run_id: '',
  };
  const preferredProviders: string[] = [];
  const allowedProviders: string[] = [];
  const availableTools: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--recipe') {
      recipeId = readOptionValue(args, index, '--recipe');
      index += 1;
      continue;
    }
    if (arg === '--phase') {
      phase = readOptionValue(args, index, '--phase');
      index += 1;
      continue;
    }
    if (arg === '--query' || arg === '--topic' || arg === '--project-id' || arg === '--paper-id' || arg === '--run-id') {
      const key = arg.slice(2).replaceAll('-', '_');
      inputs[key] = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--seed-recid') {
      inputs.seed_recid = readOptionValue(args, index, '--seed-recid');
      index += 1;
      continue;
    }
    if (arg === '--analysis-seed') {
      inputs.analysis_seed = readOptionValue(args, index, '--analysis-seed');
      index += 1;
      continue;
    }
    if (arg === '--recid') {
      (inputs.recids as string[]).push(readOptionValue(args, index, '--recid'));
      index += 1;
      continue;
    }
    if (arg === '--preferred-provider') {
      preferredProviders.push(readOptionValue(args, index, '--preferred-provider'));
      index += 1;
      continue;
    }
    if (arg === '--allowed-provider') {
      allowedProviders.push(readOptionValue(args, index, '--allowed-provider'));
      index += 1;
      continue;
    }
    if (arg === '--available-tool') {
      availableTools.push(readOptionValue(args, index, '--available-tool'));
      index += 1;
      continue;
    }
    throw new Error(`unknown workflow-plan argument: ${arg}`);
  }
  if (!recipeId) {
    throw new Error('workflow-plan requires --recipe <recipe_id>');
  }
  return { recipeId, phase, inputs, preferredProviders, allowedProviders, availableTools };
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
    case 'run':
      return { command: 'run', projectRoot, ...parseRunArgs(rest) };
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
    case 'workflow-plan':
      return { command: 'workflow-plan', projectRoot, ...parseWorkflowPlanArgs(rest) };
    default:
      throw new Error(`unknown command: ${command}`);
  }
}
