/**
 * Orchestrator MCP tools (NEW-R15-impl) — orch_run_* + orch_policy_query
 *
 * Exposes hepar orchestrator run-lifecycle operations over MCP.
 * All tools operate on a caller-supplied `project_root` (directory containing
 * `.autoresearch/`).
 *
 * URI scheme: orch://runs/<run_id>
 * Namespace:  orch_run_* (no collision with hep_run_*)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { z } from 'zod';
import {
  invalidParams,
  notFound,
  ORCH_RUN_CREATE,
  ORCH_RUN_STATUS,
  ORCH_RUN_LIST,
  ORCH_RUN_APPROVE,
  ORCH_RUN_REJECT,
  ORCH_RUN_EXPORT,
  ORCH_RUN_PAUSE,
  ORCH_RUN_RESUME,
  ORCH_RUN_APPROVALS_LIST,
  ORCH_POLICY_QUERY,
} from '@autoresearch/shared';
import type { ToolSpec } from '../registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem helpers (mirror of Python orchestrator_state.py logic)
// ─────────────────────────────────────────────────────────────────────────────

function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveProjectRoot(raw: string): string {
  const expanded = expandTilde(raw.trim());
  return path.resolve(expanded);
}

function autoresearchDir(projectRoot: string): string {
  const override = process.env['AUTORESEARCH_CONTROL_DIR'];
  if (override) {
    const p = expandTilde(override);
    return path.isAbsolute(p) ? p : path.join(projectRoot, p);
  }
  return path.join(projectRoot, '.autoresearch');
}

function statePath(projectRoot: string): string {
  return path.join(autoresearchDir(projectRoot), 'state.json');
}

function ledgerPath(projectRoot: string): string {
  return path.join(autoresearchDir(projectRoot), 'ledger.jsonl');
}

function policyPath(projectRoot: string): string {
  return path.join(autoresearchDir(projectRoot), 'approval_policy.json');
}

function pauseFilePath(projectRoot: string): string {
  return path.join(projectRoot, '.pause');
}

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf-8' });
  fs.renameSync(tmp, filePath);
}

function readJson(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, { encoding: 'utf-8' });
  return JSON.parse(raw);
}

function appendLedgerEvent(
  projectRoot: string,
  event: Record<string, unknown>,
): void {
  const lp = ledgerPath(projectRoot);
  const full = { ...event, timestamp_utc: utcNowIso() };
  fs.appendFileSync(lp, JSON.stringify(full) + '\n', { encoding: 'utf-8' });
}

function ensureRuntimeDirs(projectRoot: string): void {
  const ar = autoresearchDir(projectRoot);
  fs.mkdirSync(ar, { recursive: true });
  const lp = ledgerPath(projectRoot);
  if (!fs.existsSync(lp)) {
    fs.writeFileSync(lp, '', { encoding: 'utf-8' });
  }
}

function defaultState(runId: string, workflowId?: string): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: runId,
    workflow_id: workflowId ?? null,
    run_status: 'idle',
    current_step: null,
    plan: null,
    plan_md_path: null,
    checkpoints: { last_checkpoint_at: null, checkpoint_interval_seconds: 900 },
    pending_approval: null,
    approval_seq: { A1: 0, A2: 0, A3: 0, A4: 0, A5: 0 },
    gate_satisfied: {},
    approval_history: [],
    artifacts: {},
    notes: '',
  };
}

function requireState(projectRoot: string): Record<string, unknown> {
  const sp = statePath(projectRoot);
  if (!fs.existsSync(sp)) {
    throw notFound(`No orchestrator state found at ${sp}. Run orch_run_create first.`);
  }
  return readJson(sp) as Record<string, unknown>;
}

function saveState(projectRoot: string, state: Record<string, unknown>): void {
  writeJsonAtomic(statePath(projectRoot), state);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared Zod schemas
// ─────────────────────────────────────────────────────────────────────────────

const ProjectRootSchema = z
  .string()
  .min(1)
  .describe('Absolute (or tilde-prefixed) path to the hepar project root directory (contains .autoresearch/)');

// ─────────────────────────────────────────────────────────────────────────────
// Tool schemas
// ─────────────────────────────────────────────────────────────────────────────

const OrchRunCreateSchema = z.object({
  project_root: ProjectRootSchema,
  run_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_\-]+$/, 'run_id must be alphanumeric + _ -')
    .describe('Run identifier, unique within the project.'),
  workflow_id: z.string().optional().describe('Workflow identifier.'),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      'Idempotency key. If a run with matching key already exists, returns existing state without error.',
    ),
});

const OrchRunStatusSchema = z.object({
  project_root: ProjectRootSchema,
});

const OrchRunListSchema = z.object({
  project_root: ProjectRootSchema,
  limit: z.number().int().positive().optional().default(20).describe('Max runs to return.'),
  status_filter: z
    .enum(['idle', 'running', 'awaiting_approval', 'paused', 'complete', 'failed', 'all'])
    .optional()
    .default('all')
    .describe('Filter by run_status.'),
});

const OrchRunApproveSchema = z.object({
  project_root: ProjectRootSchema,
  approval_id: z.string().min(1).describe('Approval ID, e.g. A1-0001.'),
  approval_packet_sha256: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/, 'Must be a lowercase hex SHA-256 of approval_packet_v1.json')
    .describe('SHA-256 of the approval_packet_v1.json file. Prevents approval of a tampered packet.'),
  _confirm: z.literal(true).describe('Must be true to execute this destructive operation.'),
  note: z.string().optional().describe('Optional note recorded in the ledger.'),
});

const OrchRunRejectSchema = z.object({
  project_root: ProjectRootSchema,
  approval_id: z.string().min(1).describe('Approval ID to reject.'),
  _confirm: z.literal(true).describe('Must be true to execute this irreversible rejection.'),
  note: z.string().optional().describe('Reason for rejection, recorded in ledger.'),
});

const OrchRunExportSchema = z.object({
  project_root: ProjectRootSchema,
  _confirm: z.literal(true).describe('Must be true to acknowledge the export (potentially destructive).'),
  include_state: z.boolean().optional().default(true).describe('Include .autoresearch/state.json in summary.'),
  include_artifacts: z.boolean().optional().default(true).describe('List artifact paths.'),
});

const OrchRunPauseSchema = z.object({
  project_root: ProjectRootSchema,
  note: z.string().optional().describe('Reason for pausing, recorded in ledger.'),
});

const OrchRunResumeSchema = z.object({
  project_root: ProjectRootSchema,
  note: z.string().optional().describe('Note recorded in ledger when resuming.'),
});

const OrchRunApprovalsListSchema = z.object({
  project_root: ProjectRootSchema,
  run_id: z.string().optional().describe('Run ID to list approvals for. Defaults to current run_id in state.'),
  gate_filter: z
    .enum(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'all'])
    .optional()
    .default('all')
    .describe('Filter by gate category.'),
  include_history: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include already-resolved approvals from approval_history.'),
});

const OrchPolicyQuerySchema = z.object({
  project_root: ProjectRootSchema,
  operation: z
    .string()
    .optional()
    .describe(
      'Operation to check (e.g. "mass_search", "code_changes", "compute_runs"). If omitted, returns full policy.',
    ),
  include_history: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include historical approval precedents for the queried operation.'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleOrchRunCreate(
  params: z.output<typeof OrchRunCreateSchema>,
): Promise<unknown> {
  const projectRoot = resolveProjectRoot(params.project_root);
  ensureRuntimeDirs(projectRoot);

  const sp = statePath(projectRoot);

  // Idempotency: if state exists, check idempotency_key
  if (fs.existsSync(sp)) {
    const existing = readJson(sp) as Record<string, unknown>;
    const existingKey = existing['idempotency_key'] as string | undefined;
    if (params.idempotency_key && existingKey === params.idempotency_key) {
      return {
        idempotency_replay: true,
        run_id: existing['run_id'],
        run_status: existing['run_status'],
        uri: `orch://runs/${existing['run_id']}`,
        message: `Idempotency replay: existing run with key "${params.idempotency_key}"`,
      };
    }
    if (params.idempotency_key && existingKey && existingKey !== params.idempotency_key) {
      throw invalidParams(
        `idempotency_conflict: existing run has key "${existingKey}", requested "${params.idempotency_key}"`,
        { existing_key: existingKey, requested_key: params.idempotency_key },
      );
    }
  }

  const state = defaultState(params.run_id, params.workflow_id);
  if (params.idempotency_key) {
    (state as Record<string, unknown>)['idempotency_key'] = params.idempotency_key;
  }

  saveState(projectRoot, state);

  // Write .initialized marker
  const initMarker = path.join(autoresearchDir(projectRoot), '.initialized');
  if (!fs.existsSync(initMarker)) {
    fs.writeFileSync(initMarker, utcNowIso() + '\n', { encoding: 'utf-8' });
  }

  appendLedgerEvent(projectRoot, {
    event_type: 'initialized',
    run_id: params.run_id,
    workflow_id: params.workflow_id ?? null,
    details: { source: 'orch_run_create' },
  });

  return {
    run_id: params.run_id,
    run_status: 'idle',
    uri: `orch://runs/${params.run_id}`,
    project_root: projectRoot,
    message: `Run "${params.run_id}" created.`,
  };
}

async function handleOrchRunStatus(
  params: z.output<typeof OrchRunStatusSchema>,
): Promise<unknown> {
  const projectRoot = resolveProjectRoot(params.project_root);
  const state = requireState(projectRoot);

  const runId = state['run_id'] as string | null;
  const paused = fs.existsSync(pauseFilePath(projectRoot));

  return {
    run_id: runId,
    run_status: paused ? 'paused' : state['run_status'],
    workflow_id: state['workflow_id'] ?? null,
    current_step: state['current_step'] ?? null,
    pending_approval: state['pending_approval'] ?? null,
    gate_satisfied: state['gate_satisfied'] ?? {},
    notes: state['notes'] ?? '',
    uri: runId ? `orch://runs/${runId}` : null,
    is_paused: paused,
  };
}

async function handleOrchRunList(
  params: z.output<typeof OrchRunListSchema>,
): Promise<unknown> {
  const projectRoot = resolveProjectRoot(params.project_root);
  const lp = ledgerPath(projectRoot);

  if (!fs.existsSync(lp)) {
    return { runs: [], total: 0 };
  }

  const lines = fs.readFileSync(lp, { encoding: 'utf-8' }).split('\n').filter(l => l.trim());

  // Build run index from ledger events
  const runMap = new Map<string, { run_id: string; last_event: string; last_status: string; timestamp_utc: string }>();
  for (const line of lines) {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const runId = evt['run_id'] as string | null;
    if (!runId) continue;
    const evtType = (evt['event_type'] as string | undefined) ?? '';
    const ts = (evt['timestamp_utc'] as string | undefined) ?? '';
    const entry = runMap.get(runId) ?? { run_id: runId, last_event: evtType, last_status: 'unknown', timestamp_utc: ts };
    entry.last_event = evtType;
    entry.timestamp_utc = ts;
    // Map event types to run_status approximations
    if (evtType === 'initialized') entry.last_status = 'idle';
    else if (evtType === 'approval_requested') entry.last_status = 'awaiting_approval';
    else if (evtType === 'approval_approved') entry.last_status = 'running';
    else if (evtType === 'approval_rejected') entry.last_status = 'paused';
    else if (evtType === 'paused') entry.last_status = 'paused';
    else if (evtType === 'resumed') entry.last_status = 'running';
    runMap.set(runId, entry);
  }

  let runs = Array.from(runMap.values())
    .sort((a, b) => b.timestamp_utc.localeCompare(a.timestamp_utc));

  if (params.status_filter !== 'all') {
    runs = runs.filter(r => r.last_status === params.status_filter);
  }

  const limited = runs.slice(0, params.limit);

  return {
    runs: limited.map(r => ({ ...r, uri: `orch://runs/${r.run_id}` })),
    total: runMap.size,
    returned: limited.length,
  };
}

async function handleOrchRunApprove(
  params: z.output<typeof OrchRunApproveSchema>,
): Promise<unknown> {
  const projectRoot = resolveProjectRoot(params.project_root);
  const state = requireState(projectRoot);

  // Verify pending approval matches
  const pending = state['pending_approval'] as Record<string, unknown> | null;
  if (!pending) {
    throw invalidParams('No pending approval found in state.', { approval_id: params.approval_id });
  }
  if (pending['approval_id'] !== params.approval_id) {
    throw invalidParams(
      `Pending approval is "${pending['approval_id']}", not "${params.approval_id}".`,
      { expected: pending['approval_id'], got: params.approval_id },
    );
  }

  // Verify SHA-256 of approval_packet_v1.json
  const packetPathRel = pending['packet_path'] as string | undefined;
  if (!packetPathRel) {
    throw invalidParams('Pending approval has no packet_path — cannot verify SHA-256.', {});
  }
  // packet_path is relative to project_root in hepar convention
  const packetDir = path.join(projectRoot, path.dirname(packetPathRel));
  const jsonPacketPath = path.join(packetDir, 'approval_packet_v1.json');

  if (!fs.existsSync(jsonPacketPath)) {
    throw notFound(`approval_packet_v1.json not found at ${jsonPacketPath}`);
  }
  const jsonContent = fs.readFileSync(jsonPacketPath);
  const actualSha256 = createHash('sha256').update(jsonContent).digest('hex');

  if (actualSha256 !== params.approval_packet_sha256) {
    throw invalidParams(
      'approval_packet_sha256 mismatch — packet may have been tampered with.',
      { expected: params.approval_packet_sha256, actual: actualSha256 },
    );
  }

  // Perform approval
  const category = pending['category'] as string | undefined;
  const newState = { ...(state as Record<string, unknown>) };
  newState['pending_approval'] = null;
  newState['run_status'] = 'running';
  newState['notes'] = params.note ?? `approved ${params.approval_id}`;
  if (category) {
    (newState['gate_satisfied'] as Record<string, string>)[category] = params.approval_id;
  }
  const historyEntry = {
    ts: utcNowIso(),
    approval_id: params.approval_id,
    category: category ?? null,
    decision: 'approved',
    note: params.note ?? '',
  };
  const history = Array.isArray(newState['approval_history']) ? newState['approval_history'] as unknown[] : [];
  newState['approval_history'] = [...history, historyEntry];
  (newState['checkpoints'] as Record<string, unknown>)['last_checkpoint_at'] = utcNowIso();

  saveState(projectRoot, newState);
  appendLedgerEvent(projectRoot, {
    event_type: 'approval_approved',
    run_id: newState['run_id'],
    workflow_id: newState['workflow_id'],
    details: {
      approval_id: params.approval_id,
      category,
      note: params.note ?? '',
    },
  });

  return {
    approved: true,
    approval_id: params.approval_id,
    category,
    run_status: 'running',
    uri: `orch://runs/${newState['run_id']}`,
    message: `Approved: ${params.approval_id}`,
  };
}

async function handleOrchRunReject(
  params: z.output<typeof OrchRunRejectSchema>,
): Promise<unknown> {
  const projectRoot = resolveProjectRoot(params.project_root);
  const state = requireState(projectRoot);

  const pending = state['pending_approval'] as Record<string, unknown> | null;
  if (!pending) {
    throw invalidParams('No pending approval found in state.', { approval_id: params.approval_id });
  }
  if (pending['approval_id'] !== params.approval_id) {
    throw invalidParams(
      `Pending approval is "${pending['approval_id']}", not "${params.approval_id}".`,
      { expected: pending['approval_id'], got: params.approval_id },
    );
  }

  const category = pending['category'] as string | undefined;

  // Create .pause file (hepar convention: paused iff .pause exists)
  fs.writeFileSync(pauseFilePath(projectRoot), 'paused\n', { encoding: 'utf-8' });

  const newState = { ...(state as Record<string, unknown>) };
  newState['pending_approval'] = null;
  newState['run_status'] = 'paused';
  newState['notes'] = params.note ?? `rejected ${params.approval_id}`;
  const historyEntry = {
    ts: utcNowIso(),
    approval_id: params.approval_id,
    category: category ?? null,
    decision: 'rejected',
    note: params.note ?? '',
  };
  const history = Array.isArray(newState['approval_history']) ? newState['approval_history'] as unknown[] : [];
  newState['approval_history'] = [...history, historyEntry];

  saveState(projectRoot, newState);
  appendLedgerEvent(projectRoot, {
    event_type: 'approval_rejected',
    run_id: newState['run_id'],
    workflow_id: newState['workflow_id'],
    details: {
      approval_id: params.approval_id,
      category,
      note: params.note ?? '',
    },
  });

  return {
    rejected: true,
    approval_id: params.approval_id,
    category,
    run_status: 'paused',
    uri: `orch://runs/${newState['run_id']}`,
    message: `Rejected: ${params.approval_id}. Run is now paused.`,
  };
}

async function handleOrchRunExport(
  params: z.output<typeof OrchRunExportSchema>,
): Promise<unknown> {
  const projectRoot = resolveProjectRoot(params.project_root);
  const result: Record<string, unknown> = { project_root: projectRoot };

  if (params.include_state) {
    const sp = statePath(projectRoot);
    if (fs.existsSync(sp)) {
      result['state'] = readJson(sp);
    } else {
      result['state'] = null;
      result['state_missing'] = true;
    }
  }

  if (params.include_artifacts) {
    const runsDir = path.join(projectRoot, 'artifacts', 'runs');
    if (fs.existsSync(runsDir)) {
      const runs: Record<string, unknown>[] = [];
      for (const runDir of fs.readdirSync(runsDir)) {
        const full = path.join(runsDir, runDir);
        if (!fs.statSync(full).isDirectory()) continue;
        const files = fs.readdirSync(full).map(f => path.join('artifacts', 'runs', runDir, f));
        runs.push({ run_id: runDir, files: files.slice(0, 50), uri: `orch://runs/${runDir}` });
      }
      result['artifact_runs'] = runs;
    } else {
      result['artifact_runs'] = [];
    }
  }

  return {
    exported: true,
    ...result,
    uri: `orch://runs/export`,
    message: 'Export summary generated (no files copied; use artifacts/ directory for actual files).',
  };
}

async function handleOrchRunPause(
  params: z.output<typeof OrchRunPauseSchema>,
): Promise<unknown> {
  const projectRoot = resolveProjectRoot(params.project_root);
  const state = requireState(projectRoot);

  fs.writeFileSync(pauseFilePath(projectRoot), 'paused\n', { encoding: 'utf-8' });

  const newState = { ...(state as Record<string, unknown>) };
  newState['run_status'] = 'paused';
  newState['notes'] = params.note ?? 'paused via orch_run_pause';

  saveState(projectRoot, newState);
  appendLedgerEvent(projectRoot, {
    event_type: 'paused',
    run_id: newState['run_id'],
    workflow_id: newState['workflow_id'],
    details: { note: params.note ?? '' },
  });

  return {
    paused: true,
    run_id: newState['run_id'],
    run_status: 'paused',
    uri: `orch://runs/${newState['run_id']}`,
  };
}

async function handleOrchRunResume(
  params: z.output<typeof OrchRunResumeSchema>,
): Promise<unknown> {
  const projectRoot = resolveProjectRoot(params.project_root);
  const state = requireState(projectRoot);

  const pf = pauseFilePath(projectRoot);
  if (fs.existsSync(pf)) {
    fs.unlinkSync(pf);
  }

  const newState = { ...(state as Record<string, unknown>) };
  newState['run_status'] = 'running';
  newState['notes'] = params.note ?? 'resumed via orch_run_resume';

  saveState(projectRoot, newState);
  appendLedgerEvent(projectRoot, {
    event_type: 'resumed',
    run_id: newState['run_id'],
    workflow_id: newState['workflow_id'],
    details: { note: params.note ?? '' },
  });

  return {
    resumed: true,
    run_id: newState['run_id'],
    run_status: 'running',
    uri: `orch://runs/${newState['run_id']}`,
  };
}

async function handleOrchRunApprovalsList(
  params: z.output<typeof OrchRunApprovalsListSchema>,
): Promise<unknown> {
  const projectRoot = resolveProjectRoot(params.project_root);
  const state = requireState(projectRoot);

  const runId = (params.run_id ?? state['run_id']) as string | null;
  if (!runId) {
    throw invalidParams('No run_id in state and none provided.', {});
  }

  const results: unknown[] = [];

  // Current pending approval
  const pending = state['pending_approval'] as Record<string, unknown> | null;
  if (pending) {
    const category = (pending['category'] as string | undefined) ?? '';
    if (
      params.gate_filter === 'all' ||
      category === params.gate_filter
    ) {
      results.push({ ...pending, status: 'pending' });
    }
  }

  // Scan approval artifact directories
  const approvalsDir = path.join(projectRoot, 'artifacts', 'runs', runId, 'approvals');
  if (fs.existsSync(approvalsDir)) {
    for (const dirName of fs.readdirSync(approvalsDir).sort()) {
      const dirPath = path.join(approvalsDir, dirName);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      const gatePrefix = dirName.slice(0, 2);
      if (params.gate_filter !== 'all' && gatePrefix !== params.gate_filter) continue;

      const jsonPath = path.join(dirPath, 'approval_packet_v1.json');
      const shortPath = path.join(dirPath, 'packet_short.md');
      const approvalEntry: Record<string, unknown> = { dir: dirName };

      if (fs.existsSync(jsonPath)) {
        try {
          const pkt = readJson(jsonPath) as Record<string, unknown>;
          const content = fs.readFileSync(jsonPath);
          const sha256 = createHash('sha256').update(content).digest('hex');
          approvalEntry['approval_id'] = pkt['approval_id'];
          approvalEntry['gate_id'] = pkt['gate_id'];
          approvalEntry['requested_at'] = pkt['requested_at'];
          approvalEntry['approval_packet_sha256'] = sha256;
          approvalEntry['uri'] = `orch://runs/${runId}/approvals/${dirName}`;
          approvalEntry['packet_short_uri'] = shortPath;
        } catch {
          approvalEntry['parse_error'] = true;
        }
      }

      // Check if this approval appears in history (resolved)
      const history = Array.isArray(state['approval_history'])
        ? (state['approval_history'] as Record<string, unknown>[])
        : [];
      const histEntry = history.find(h => h['approval_id'] === approvalEntry['approval_id']);
      if (histEntry) {
        approvalEntry['status'] = histEntry['decision'] === 'approved' ? 'approved' : 'rejected';
        approvalEntry['resolved_at'] = histEntry['ts'];
        approvalEntry['note'] = histEntry['note'];
        if (!params.include_history) continue;
      } else {
        approvalEntry['status'] = pending?.['approval_id'] === approvalEntry['approval_id'] ? 'pending' : 'unknown';
      }

      results.push(approvalEntry);
    }
  }

  return {
    run_id: runId,
    approvals: results,
    total: results.length,
  };
}

async function handleOrchPolicyQuery(
  params: z.output<typeof OrchPolicyQuerySchema>,
): Promise<unknown> {
  const projectRoot = resolveProjectRoot(params.project_root);
  const pp = policyPath(projectRoot);

  let policy: Record<string, unknown> | null = null;
  if (fs.existsSync(pp)) {
    try {
      policy = readJson(pp) as Record<string, unknown>;
    } catch {
      policy = null;
    }
  }

  // Default approval policy (mirrors Python APPROVAL_CATEGORY_TO_POLICY_KEY)
  const POLICY_KEYS: Record<string, string> = {
    A1: 'mass_search',
    A2: 'code_changes',
    A3: 'compute_runs',
    A4: 'paper_edits',
    A5: 'final_conclusions',
  };

  const DEFAULT_APPROVAL_REQUIRED: Record<string, boolean> = {
    mass_search: true,
    code_changes: true,
    compute_runs: true,
    paper_edits: true,
    final_conclusions: true,
  };

  const effectivePolicy = policy ?? { approval_required: DEFAULT_APPROVAL_REQUIRED };

  const result: Record<string, unknown> = {
    policy: effectivePolicy,
    gate_to_policy_key: POLICY_KEYS,
    policy_path: fs.existsSync(pp) ? pp : null,
    policy_exists: fs.existsSync(pp),
  };

  if (params.operation) {
    const opPolicyKey = params.operation;
    const approvalRequired = effectivePolicy['approval_required'] as Record<string, boolean> | undefined;
    result['operation'] = params.operation;
    result['requires_approval'] = approvalRequired
      ? (approvalRequired[opPolicyKey] ?? true)
      : true;

    if (params.include_history) {
      let history: unknown[] = [];
      try {
        const state = requireState(projectRoot);
        history = Array.isArray(state['approval_history'])
          ? (state['approval_history'] as unknown[]).filter(h => {
              const he = h as Record<string, unknown>;
              const cat = he['category'] as string | undefined;
              if (!cat) return false;
              return POLICY_KEYS[cat] === opPolicyKey;
            })
          : [];
      } catch {
        // state may not exist yet
      }
      result['precedents'] = history.slice(-5); // last 5
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORCH_TOOL_SPECS — imported into registry.ts
// ─────────────────────────────────────────────────────────────────────────────

type RawToolSpec = Omit<ToolSpec, 'riskLevel'>;

export const ORCH_TOOL_SPECS: RawToolSpec[] = [
  {
    name: ORCH_RUN_CREATE,
    tier: 'core',
    exposure: 'full',
    description:
      'Create (or idempotently replay) a hepar orchestrator run in a local project root. Initializes .autoresearch/ state (local-only).',
    zodSchema: OrchRunCreateSchema,
    handler: async params => handleOrchRunCreate(params),
  },
  {
    name: ORCH_RUN_STATUS,
    tier: 'core',
    exposure: 'full',
    description:
      'Return the current orchestrator run status (run_id, run_status, pending_approval, gate_satisfied) from state.json (read-only, local-only).',
    zodSchema: OrchRunStatusSchema,
    handler: async params => handleOrchRunStatus(params),
  },
  {
    name: ORCH_RUN_LIST,
    tier: 'core',
    exposure: 'full',
    description:
      'List runs recorded in ledger.jsonl with optional status filter and pagination (read-only, local-only).',
    zodSchema: OrchRunListSchema,
    handler: async params => handleOrchRunList(params),
  },
  {
    name: ORCH_RUN_APPROVE,
    tier: 'core',
    exposure: 'full',
    description:
      'Approve a pending orchestrator gate (destructive: irreversible). Requires _confirm: true, approval_id, AND approval_packet_sha256 verification against the on-disk packet (local-only).',
    zodSchema: OrchRunApproveSchema,
    handler: async params => handleOrchRunApprove(params),
  },
  {
    name: ORCH_RUN_REJECT,
    tier: 'core',
    exposure: 'full',
    description:
      'Reject a pending orchestrator gate (destructive: irreversible pause). Requires _confirm: true (local-only).',
    zodSchema: OrchRunRejectSchema,
    handler: async params => handleOrchRunReject(params),
  },
  {
    name: ORCH_RUN_EXPORT,
    tier: 'core',
    exposure: 'full',
    description:
      'Export run summary (state + artifact listing). Requires _confirm: true. Does not copy files — returns a manifest of available outputs (local-only).',
    zodSchema: OrchRunExportSchema,
    handler: async params => handleOrchRunExport(params),
  },
  {
    name: ORCH_RUN_PAUSE,
    tier: 'core',
    exposure: 'full',
    description:
      'Pause the current orchestrator run by writing .pause sentinel and updating state (local-only).',
    zodSchema: OrchRunPauseSchema,
    handler: async params => handleOrchRunPause(params),
  },
  {
    name: ORCH_RUN_RESUME,
    tier: 'core',
    exposure: 'full',
    description:
      'Resume a paused orchestrator run by removing .pause sentinel and updating state (local-only).',
    zodSchema: OrchRunResumeSchema,
    handler: async params => handleOrchRunResume(params),
  },
  {
    name: ORCH_RUN_APPROVALS_LIST,
    tier: 'core',
    exposure: 'full',
    description:
      'List approval packets for a run (pending + optionally historical). Returns approval_id, gate_id, SHA-256, and orch:// URI (read-only, local-only).',
    zodSchema: OrchRunApprovalsListSchema,
    handler: async params => handleOrchRunApprovalsList(params),
  },
  {
    name: ORCH_POLICY_QUERY,
    tier: 'core',
    exposure: 'full',
    description:
      'Query the orchestrator approval policy: "does operation X require approval?" Returns policy rules and optionally historical precedents (read-only, local-only).',
    zodSchema: OrchPolicyQuerySchema,
    handler: async params => handleOrchPolicyQuery(params),
  },
];
