// # CONTRACT-EXEMPT: CODE-01.1 Existing canonical parser registry; this change adds only the report-validate union arm and dispatch case, while splitting unrelated command parsers would expand this bounded front-door change.
import { isNulliusPublicCommand } from './cli-command-inventory.js';

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
    checkerPath: string;
    checkerRuntime: string;
    checkerHelperPaths: string[];
    quantityId: string;
    layerId: string;
    referenceProvenance: Array<{ reference_id: string; uri: string; sha256: string }>;
    disputedDimensions: string[];
    requiredNegativeControlIds: string[];
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
  | {
    command: 'decision';
    projectRoot: string | null;
    action: 'record' | 'pending' | 'list';
    text: string | null;
    by: string | null;
    resolves: string | null;
    json: boolean;
  }
  | { command: 'status'; projectRoot: string | null; json: boolean }
  | { command: 'report-validate'; projectRoot: string | null }
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
    kind: 'claims' | 'progress' | 'literature' | 'roadmap';
    inputs: Record<string, string>;
    outDir: string | null;
    format: 'dot' | 'png' | 'svg';
    rankDir: 'LR' | 'TB';
    legend: 'auto' | 'embedded' | 'none';
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

// In-dispatch generation token: the project-local launcher passes this with
// the REAL command (not only in a separate probe), so the invocation that
// handles the trusted root proves its own parser generation. An
// older-generation parser fails on the unknown token instead of proceeding
// with different root semantics — closing the probe-then-exec swap window and
// the mixed-build case where the banner is new but the parser is old.
const LAUNCHER_GENERATION_TOKEN = '--launcher-generation=2';
const LAUNCHER_GENERATION_PREFIX = '--launcher-generation=';

/** Strips one leading generation token, failing closed on a mismatch. The
 *  launcher-protocol handshake calls this too, so the banner is only emitted
 *  when THIS module — the component whose root semantics actually matter —
 *  accepted the token; a mixed build (new cli.js, stale cli-args.js) fails
 *  the probe instead of advertising a fallback that dispatch would reject. */
export function consumeLauncherGenerationToken(argv: string[]): string[] {
  const [first, ...rest] = argv;
  if (first === undefined || !first.startsWith(LAUNCHER_GENERATION_PREFIX)) return argv;
  if (first !== LAUNCHER_GENERATION_TOKEN) {
    throw new Error(`launcher generation mismatch: this CLI implements ${LAUNCHER_GENERATION_TOKEN}, launcher sent ${first}`);
  }
  return rest;
}

function extractProjectRoot(argv: string[]): { args: string[]; projectRoot: string | null } {
  const args: string[] = [];
  let projectRoot: string | null = null;
  let optionsEnded = false;
  const setRoot = (value: string) => {
    // Duplicate explicit roots are ambiguous authority, never last-wins:
    // silently preferring one could write into the wrong project.
    if (projectRoot !== null && projectRoot !== value) {
      throw new Error(`duplicate --project-root values: ${projectRoot} and ${value}`);
    }
    projectRoot = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]!;
    // Tokens after the end-of-options terminator are data (e.g. decision
    // text), never a project-root override — otherwise recorded text could
    // silently retarget the write to another root. The project-local
    // launcher PREPENDS its trusted root, so it is always seen before any
    // user-supplied terminator.
    if (!optionsEnded && current === '--') {
      optionsEnded = true;
      args.push(current);
      continue;
    }
    if (!optionsEnded && current.startsWith(LAUNCHER_GENERATION_PREFIX)) {
      // Consumed (stripped) when it names THIS generation; any other value
      // means a launcher expecting different root semantics — fail closed.
      consumeLauncherGenerationToken([current]);
      continue;
    }
    if (!optionsEnded && current.startsWith('--project-root=')) {
      setRoot(current.slice('--project-root='.length));
      continue;
    }
    if (optionsEnded || current !== '--project-root') {
      args.push(argv[index]!);
      continue;
    }
    setRoot(readOptionValue(argv, index, '--project-root'));
    index += 1;
  }
  return { args, projectRoot };
}

function ensureKnownCommand(command: string): void {
  if (!isNulliusPublicCommand(command)) {
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

function parseDecisionArgs(args: string[]): {
  action: 'record' | 'pending' | 'list';
  text: string | null;
  by: string | null;
  resolves: string | null;
  json: boolean;
} {
  const rawAction = args[0];
  if (rawAction !== 'record' && rawAction !== 'pending' && rawAction !== 'list') {
    throw new Error('decision requires an action: record | pending | list');
  }
  const action = rawAction;
  let text: string | null = null;
  let by: string | null = null;
  let resolves: string | null = null;
  let json = false;
  let optionsEnded = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!optionsEnded && arg === '--') {
      // Conventional end-of-options terminator so decision text may begin
      // with a hyphen: nullius decision record -- "-keep the negative branch"
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) {
      if (text === null && action !== 'list') {
        text = arg;
        continue;
      }
      throw new Error(`unknown decision argument: ${arg}`);
    }
    if (arg === '--by') {
      if (action === 'list') throw new Error('decision list does not take --by');
      by = readOptionValue(args, index, '--by');
      index += 1;
      continue;
    }
    if (arg === '--resolves') {
      if (action !== 'record') throw new Error('--resolves is only valid with decision record');
      resolves = readOptionValue(args, index, '--resolves');
      index += 1;
      continue;
    }
    if (arg === '--json') {
      if (action !== 'list') throw new Error('--json is only valid with decision list');
      json = true;
      continue;
    }
    if (!arg.startsWith('-') && text === null && action !== 'list') {
      text = arg;
      continue;
    }
    throw new Error(`unknown decision argument: ${arg}`);
  }
  if ((action === 'record' || action === 'pending') && (text === null || text.trim().length === 0)) {
    throw new Error(`decision ${action} requires the text as one quoted argument`);
  }
  return { action, text, by, resolves, json };
}

function parseVerifyArgs(args: string[]): {
  runId: string;
  status: 'passed' | 'failed' | 'blocked';
  summary: string;
  evidencePaths: string[];
  checkerPath: string;
  checkerRuntime: string;
  checkerHelperPaths: string[];
  quantityId: string;
  layerId: string;
  referenceProvenance: Array<{ reference_id: string; uri: string; sha256: string }>;
  disputedDimensions: string[];
  requiredNegativeControlIds: string[];
  checkKind: string;
  confidenceLevel: 'low' | 'medium' | 'high';
  confidenceScore: number | null;
  notes: string | null;
} {
  let runId: string | null = null;
  let status: 'passed' | 'failed' | 'blocked' | null = null;
  let summary: string | null = null;
  const evidencePaths: string[] = [];
  let checkerPath: string | null = null;
  let checkerRuntime: string | null = null;
  const checkerHelperPaths: string[] = [];
  let quantityId: string | null = null;
  let layerId: string | null = null;
  const referenceProvenance: Array<{ reference_id: string; uri: string; sha256: string }> = [];
  const disputedDimensions: string[] = [];
  const requiredNegativeControlIds: string[] = [];
  let legacyCheckerCommandSupplied = false;
  let legacyReceiptSupplied = false;
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
    if (arg === '--checker-path') {
      checkerPath = readOptionValue(args, index, '--checker-path');
      index += 1;
      continue;
    }
    if (arg === '--checker-command-json') {
      readOptionValue(args, index, '--checker-command-json');
      legacyCheckerCommandSupplied = true;
      index += 1;
      continue;
    }
    if (arg === '--checker-runtime') {
      checkerRuntime = readOptionValue(args, index, '--checker-runtime');
      index += 1;
      continue;
    }
    if (arg === '--checker-helper-path') {
      checkerHelperPaths.push(readOptionValue(args, index, '--checker-helper-path'));
      index += 1;
      continue;
    }
    if (arg === '--quantity-id') {
      quantityId = readOptionValue(args, index, '--quantity-id');
      index += 1;
      continue;
    }
    if (arg === '--layer-id') {
      layerId = readOptionValue(args, index, '--layer-id');
      index += 1;
      continue;
    }
    if (arg === '--reference-provenance-json') {
      const raw = readOptionValue(args, index, '--reference-provenance-json');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new Error('--reference-provenance-json must be a JSON object');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('--reference-provenance-json must be a JSON object');
      }
      const item = parsed as Record<string, unknown>;
      if (typeof item.reference_id !== 'string' || item.reference_id.length === 0
        || typeof item.uri !== 'string' || item.uri.length === 0
        || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(item.sha256)) {
        throw new Error('--reference-provenance-json requires non-empty reference_id and uri plus lowercase sha256');
      }
      referenceProvenance.push({ reference_id: item.reference_id, uri: item.uri, sha256: item.sha256 });
      index += 1;
      continue;
    }
    if (arg === '--disputed-dimension') {
      disputedDimensions.push(readOptionValue(args, index, '--disputed-dimension'));
      index += 1;
      continue;
    }
    if (arg === '--required-negative-control-id') {
      requiredNegativeControlIds.push(readOptionValue(args, index, '--required-negative-control-id'));
      index += 1;
      continue;
    }
    if (arg === '--validation-chain-receipt') {
      readOptionValue(args, index, '--validation-chain-receipt');
      legacyReceiptSupplied = true;
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
  if (legacyReceiptSupplied) {
    throw new Error('--validation-chain-receipt is no longer accepted for decisive verification; use --checker-path and --checker-runtime so Nullius executes the checker');
  }
  if (legacyCheckerCommandSupplied) {
    throw new Error('--checker-command-json is no longer accepted; use --checker-runtime with a bare node/python token');
  }
  if (!checkerPath) throw new Error('verify requires --checker-path <path>');
  if (!checkerRuntime) throw new Error('verify requires --checker-runtime <python3|node>');
  if (!quantityId) throw new Error('verify requires --quantity-id <id>');
  if (!layerId) throw new Error('verify requires --layer-id <id>');
  if (referenceProvenance.length === 0) throw new Error('verify requires at least one --reference-provenance-json <object>');
  if (disputedDimensions.length === 0) throw new Error('verify requires at least one --disputed-dimension <name>');
  if (requiredNegativeControlIds.length === 0) throw new Error('verify requires at least one --required-negative-control-id <id>');
  return {
    runId,
    status,
    summary,
    evidencePaths,
    checkerPath,
    checkerRuntime,
    checkerHelperPaths,
    quantityId,
    layerId,
    referenceProvenance,
    disputedDimensions,
    requiredNegativeControlIds,
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

const GRAPH_KINDS = new Set(['claims', 'progress', 'literature', 'roadmap']);
const GRAPH_FORMATS = new Set(['dot', 'png', 'svg']);
const GRAPH_RANK_DIRS = new Set(['LR', 'TB']);
const GRAPH_LEGENDS = new Set(['auto', 'embedded', 'none']);
const GRAPH_INPUT_FLAGS = new Set(['--claims', '--edges', '--plan', '--input', '--spec']);

function parseGraphArgs(args: string[]): Omit<Extract<ParsedCliArgs, { command: 'graph' }>, 'command' | 'projectRoot'> {
  let kind: 'claims' | 'progress' | 'literature' | 'roadmap' | null = null;
  const inputs: Record<string, string> = {};
  let outDir: string | null = null;
  let format: 'dot' | 'png' | 'svg' = 'dot';
  let rankDir: 'LR' | 'TB' = 'LR';
  let legend: 'auto' | 'embedded' | 'none' = 'auto';
  let noColor = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--kind') {
      const raw = readOptionValue(args, index, '--kind');
      if (!GRAPH_KINDS.has(raw)) {
        throw new Error(`graph requires --kind <claims|progress|literature|roadmap>; got: ${raw}`);
      }
      kind = raw as 'claims' | 'progress' | 'literature' | 'roadmap';
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
    if (arg === '--legend') {
      const raw = readOptionValue(args, index, '--legend');
      if (!GRAPH_LEGENDS.has(raw)) {
        throw new Error(`graph requires --legend <auto|embedded|none>; got: ${raw}`);
      }
      legend = raw as 'auto' | 'embedded' | 'none';
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
    throw new Error('graph requires --kind <claims|progress|literature|roadmap>');
  }
  return { kind, inputs, outDir, format, rankDir, legend, noColor, json };
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
  // Help detection stops at the end-of-options terminator: after `--`,
  // "--help" is data (e.g. decision text), not a request for help.
  const terminatorAt = rest.indexOf('--');
  const optionRest = terminatorAt === -1 ? rest : rest.slice(0, terminatorAt);
  if (optionRest.some(isHelpFlag)) {
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
    case 'decision':
      return { command: 'decision', projectRoot, ...parseDecisionArgs(rest) };
    case 'export':
      return { command: 'export', projectRoot, passthrough: rest };
    case 'status':
      return { command: 'status', projectRoot, ...parseStatusArgs(rest) };
    case 'report-validate':
      if (rest.length > 0) throw new Error(`unknown report-validate argument: ${rest[0]}`);
      return { command: 'report-validate', projectRoot };
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
