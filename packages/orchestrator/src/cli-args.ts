import { isAutoresearchPublicCommand } from './cli-command-inventory.js';

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
  | {
    command: 'verify';
    projectRoot: string | null;
    runId: string;
    status: 'passed' | 'failed' | 'blocked';
    summary: string;
    evidencePaths: string[];
    checkKind: string;
    confidenceLevel: 'low' | 'medium' | 'high';
    confidenceScore: number | null;
    notes: string | null;
  }
  | { command: 'final-conclusions'; projectRoot: string | null; runId: string; note: string | null }
  | {
    command: 'proposal-decision';
    projectRoot: string | null;
    proposalKind: 'repair' | 'skill' | 'optimize' | 'innovate';
    proposalId: string;
    decision: 'accepted_for_later' | 'dismissed' | 'already_captured';
    note: string | null;
  }
  | { command: 'status'; projectRoot: string | null; json: boolean }
  | { command: 'pause'; projectRoot: string | null; note: string | null }
  | { command: 'resume'; projectRoot: string | null; note: string | null; force: boolean }
  | { command: 'approve'; projectRoot: string | null; approvalId: string; note: string | null }
  | {
    command: 'integrity-record';
    projectRoot: string | null;
    approvalId: string;
    modes: string[];
    notes: string;
    skipped: Array<{ mode: string; reason: string }>;
  }
  | {
    command: 'workflow-plan';
    projectRoot: string | null;
    recipeId: string;
    phase: string | null;
    inputs: Record<string, unknown>;
    preferredProviders: string[];
    allowedProviders: string[];
    availableTools: string[];
  }
  | {
    command: 'graph';
    projectRoot: string | null;
    kind: 'claims' | 'progress' | 'literature';
    inputs: Record<string, string>;
    outDir: string | null;
    format: 'dot' | 'png' | 'svg';
    rankDir: 'LR' | 'TB';
    noColor: boolean;
    json: boolean;
  };

const HELP_FLAGS = new Set(['-h', '--help']);
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
  if (!isAutoresearchPublicCommand(command)) {
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

function parseResumeArgs(args: string[]): { note: string | null; force: boolean } {
  let note: string | null = null;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--note') {
      note = readOptionValue(args, index, '--note');
      index += 1;
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    throw new Error(`unknown resume argument: ${arg}`);
  }
  return { note, force };
}

function parseIntegrityRecordArgs(args: string[]): {
  approvalId: string;
  modes: string[];
  notes: string;
  skipped: Array<{ mode: string; reason: string }>;
} {
  let approvalId: string | null = null;
  let modesRaw: string | null = null;
  let notes: string | null = null;
  let skipRaw: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--approval-id') {
      approvalId = readOptionValue(args, index, '--approval-id');
      index += 1;
      continue;
    }
    if (arg === '--modes') {
      modesRaw = readOptionValue(args, index, '--modes');
      index += 1;
      continue;
    }
    if (arg === '--notes') {
      notes = readOptionValue(args, index, '--notes');
      index += 1;
      continue;
    }
    if (arg === '--skip') {
      skipRaw = readOptionValue(args, index, '--skip');
      index += 1;
      continue;
    }
    throw new Error(`unknown integrity-record argument: ${arg}`);
  }
  if (!approvalId) throw new Error('integrity-record requires --approval-id');
  if (!modesRaw) throw new Error('integrity-record requires --modes (comma-separated, e.g. M3,M5,M6)');
  if (notes === null) throw new Error('integrity-record requires --notes "<summary>"');
  const modes = modesRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (modes.length === 0) {
    throw new Error('integrity-record --modes must list at least one mode');
  }
  const skipped: Array<{ mode: string; reason: string }> = [];
  if (skipRaw && skipRaw.trim().length > 0) {
    for (const part of skipRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)) {
      const colonAt = part.indexOf(':');
      if (colonAt < 1 || colonAt === part.length - 1) {
        throw new Error(`integrity-record --skip entry must be "Mx:reason"; got: ${part}`);
      }
      skipped.push({ mode: part.slice(0, colonAt).trim(), reason: part.slice(colonAt + 1).trim() });
    }
  }
  return { approvalId, modes, notes, skipped };
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

function parseFinalConclusionsArgs(args: string[]): { runId: string; note: string | null } {
  let runId: string | null = null;
  let note: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--run-id') {
      runId = readOptionValue(args, index, '--run-id');
      index += 1;
      continue;
    }
    if (arg === '--note') {
      note = readOptionValue(args, index, '--note');
      index += 1;
      continue;
    }
    throw new Error(`unknown final-conclusions argument: ${arg}`);
  }
  if (!runId) {
    throw new Error('final-conclusions requires --run-id <id>');
  }
  return { runId, note };
}

function parseProposalDecisionArgs(args: string[]): {
  proposalKind: 'repair' | 'skill' | 'optimize' | 'innovate';
  proposalId: string;
  decision: 'accepted_for_later' | 'dismissed' | 'already_captured';
  note: string | null;
} {
  let proposalKind: 'repair' | 'skill' | 'optimize' | 'innovate' | null = null;
  let proposalId: string | null = null;
  let decision: 'accepted_for_later' | 'dismissed' | 'already_captured' | null = null;
  let note: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--proposal-kind') {
      const raw = readOptionValue(args, index, '--proposal-kind');
      if (raw !== 'repair' && raw !== 'skill' && raw !== 'optimize' && raw !== 'innovate') {
        throw new Error(`proposal-decision requires --proposal-kind repair|skill|optimize|innovate, got: ${raw}`);
      }
      proposalKind = raw;
      index += 1;
      continue;
    }
    if (arg === '--proposal-id') {
      proposalId = readOptionValue(args, index, '--proposal-id');
      index += 1;
      continue;
    }
    if (arg === '--decision') {
      const raw = readOptionValue(args, index, '--decision');
      if (raw !== 'accepted_for_later' && raw !== 'dismissed' && raw !== 'already_captured') {
        throw new Error(`proposal-decision requires --decision accepted_for_later|dismissed|already_captured, got: ${raw}`);
      }
      decision = raw;
      index += 1;
      continue;
    }
    if (arg === '--note') {
      note = readOptionValue(args, index, '--note');
      index += 1;
      continue;
    }
    throw new Error(`unknown proposal-decision argument: ${arg}`);
  }
  if (!proposalKind) throw new Error('proposal-decision requires --proposal-kind <repair|skill|optimize|innovate>');
  if (!proposalId) throw new Error('proposal-decision requires --proposal-id <id>');
  if (!decision) throw new Error('proposal-decision requires --decision <accepted_for_later|dismissed|already_captured>');
  return { proposalKind, proposalId, decision, note };
}

function parseVerifyArgs(args: string[]): {
  runId: string;
  status: 'passed' | 'failed' | 'blocked';
  summary: string;
  evidencePaths: string[];
  checkKind: string;
  confidenceLevel: 'low' | 'medium' | 'high';
  confidenceScore: number | null;
  notes: string | null;
} {
  let runId: string | null = null;
  let status: 'passed' | 'failed' | 'blocked' | null = null;
  let summary: string | null = null;
  const evidencePaths: string[] = [];
  let checkKind = 'decisive_verification';
  let confidenceLevel: 'low' | 'medium' | 'high' = 'medium';
  let confidenceScore: number | null = null;
  let notes: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--run-id') {
      runId = readOptionValue(args, index, '--run-id');
      index += 1;
      continue;
    }
    if (arg === '--status') {
      const raw = readOptionValue(args, index, '--status');
      if (raw !== 'passed' && raw !== 'failed' && raw !== 'blocked') {
        throw new Error(`verify requires --status passed|failed|blocked, got: ${raw}`);
      }
      status = raw;
      index += 1;
      continue;
    }
    if (arg === '--summary') {
      summary = readOptionValue(args, index, '--summary');
      index += 1;
      continue;
    }
    if (arg === '--evidence-path') {
      evidencePaths.push(readOptionValue(args, index, '--evidence-path'));
      index += 1;
      continue;
    }
    if (arg === '--check-kind') {
      checkKind = readOptionValue(args, index, '--check-kind');
      index += 1;
      continue;
    }
    if (arg === '--confidence-level') {
      const raw = readOptionValue(args, index, '--confidence-level');
      if (raw !== 'low' && raw !== 'medium' && raw !== 'high') {
        throw new Error(`verify requires --confidence-level low|medium|high, got: ${raw}`);
      }
      confidenceLevel = raw;
      index += 1;
      continue;
    }
    if (arg === '--confidence-score') {
      const raw = readOptionValue(args, index, '--confidence-score');
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(`verify requires --confidence-score between 0 and 1, got: ${raw}`);
      }
      confidenceScore = parsed;
      index += 1;
      continue;
    }
    if (arg === '--notes') {
      notes = readOptionValue(args, index, '--notes');
      index += 1;
      continue;
    }
    throw new Error(`unknown verify argument: ${arg}`);
  }
  if (!runId) throw new Error('verify requires --run-id <id>');
  if (!status) throw new Error('verify requires --status <passed|failed|blocked>');
  if (!summary) throw new Error('verify requires --summary "..."');
  if (evidencePaths.length === 0) throw new Error('verify requires at least one --evidence-path <path>');
  return {
    runId,
    status,
    summary,
    evidencePaths,
    checkKind,
    confidenceLevel,
    confidenceScore,
    notes,
  };
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
    recid: '',
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
      const recid = readOptionValue(args, index, '--recid');
      if (!inputs.recid) {
        inputs.recid = recid;
      }
      (inputs.recids as string[]).push(recid);
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

const GRAPH_KINDS = new Set(['claims', 'progress', 'literature']);
const GRAPH_FORMATS = new Set(['dot', 'png', 'svg']);
const GRAPH_RANK_DIRS = new Set(['LR', 'TB']);
const GRAPH_INPUT_FLAGS = new Set(['--claims', '--edges', '--plan', '--input']);

function parseGraphArgs(args: string[]): Omit<Extract<ParsedCliArgs, { command: 'graph' }>, 'command' | 'projectRoot'> {
  let kind: 'claims' | 'progress' | 'literature' | null = null;
  const inputs: Record<string, string> = {};
  let outDir: string | null = null;
  let format: 'dot' | 'png' | 'svg' = 'dot';
  let rankDir: 'LR' | 'TB' = 'LR';
  let noColor = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--kind') {
      const raw = readOptionValue(args, index, '--kind');
      if (!GRAPH_KINDS.has(raw)) {
        throw new Error(`graph requires --kind <claims|progress|literature>; got: ${raw}`);
      }
      kind = raw as 'claims' | 'progress' | 'literature';
      index += 1;
      continue;
    }
    if (arg === '--out-dir') {
      outDir = readOptionValue(args, index, '--out-dir');
      index += 1;
      continue;
    }
    if (arg === '--format') {
      const raw = readOptionValue(args, index, '--format');
      if (!GRAPH_FORMATS.has(raw)) {
        throw new Error(`graph requires --format <dot|png|svg>; got: ${raw}`);
      }
      format = raw as 'dot' | 'png' | 'svg';
      index += 1;
      continue;
    }
    if (arg === '--rank-dir') {
      const raw = readOptionValue(args, index, '--rank-dir');
      if (!GRAPH_RANK_DIRS.has(raw)) {
        throw new Error(`graph requires --rank-dir <LR|TB>; got: ${raw}`);
      }
      rankDir = raw as 'LR' | 'TB';
      index += 1;
      continue;
    }
    if (arg === '--no-color') {
      noColor = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (GRAPH_INPUT_FLAGS.has(arg)) {
      inputs[arg.slice(2)] = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown graph argument: ${arg}`);
  }

  if (!kind) {
    throw new Error('graph requires --kind <claims|progress|literature>');
  }
  return { kind, inputs, outDir, format, rankDir, noColor, json };
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
    case 'verify':
      return { command: 'verify', projectRoot, ...parseVerifyArgs(rest) };
    case 'final-conclusions':
      return { command: 'final-conclusions', projectRoot, ...parseFinalConclusionsArgs(rest) };
    case 'proposal-decision':
      return { command: 'proposal-decision', projectRoot, ...parseProposalDecisionArgs(rest) };
    case 'export':
      return { command: 'export', projectRoot, passthrough: rest };
    case 'status':
      return { command: 'status', projectRoot, ...parseStatusArgs(rest) };
    case 'pause':
      return { command: 'pause', projectRoot, ...parseNoteArgs('pause', rest) };
    case 'resume':
      return { command: 'resume', projectRoot, ...parseResumeArgs(rest) };
    case 'approve':
      return { command: 'approve', projectRoot, ...parseApproveArgs(rest) };
    case 'integrity-record':
      return { command: 'integrity-record', projectRoot, ...parseIntegrityRecordArgs(rest) };
    case 'workflow-plan':
      return { command: 'workflow-plan', projectRoot, ...parseWorkflowPlanArgs(rest) };
    case 'graph':
      return { command: 'graph', projectRoot, ...parseGraphArgs(rest) };
    default:
      throw new Error(`unknown command: ${command}`);
  }
}
