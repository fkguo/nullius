import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invalidParams, McpError } from '@nullius/shared';

const workspace = fs.realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
export function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function projectRoot(value: string | undefined): string {
  if (process.env.NULLIUS_CONTROL_DIR) throw invalidParams('Remove NULLIUS_CONTROL_DIR before starting project-mcp; the bound project owns its control directory.');
  if (!value || !path.isAbsolute(value)) throw invalidParams('NULLIUS_PROJECT_ROOT must name one absolute external project directory.');
  const root = fs.realpathSync(value);
  if (!fs.statSync(root).isDirectory() || root === path.parse(root).root || within(workspace, root) || within(root, workspace)) {
    throw invalidParams('Bind a specific external research project, not the Nullius checkout or an ancestor.');
  }
  return root;
}

export type ProjectIdentity = { dev: number; ino: number };
export function projectIdentity(root: string): ProjectIdentity {
  const stat = fs.statSync(projectRoot(root));
  return { dev: stat.dev, ino: stat.ino };
}
export function assertProjectIdentity(root: string, expected: ProjectIdentity): void {
  const actual = projectIdentity(root);
  if (projectRoot(root) !== root || fs.lstatSync(root).isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw invalidParams('Bound project identity changed; reconcile the original project locally.');
  }
}

/** Parameter/file boundary only. Executed local scripts are trusted code, not sandboxed. */
export function boundPath(root: string, value: string, base = root): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.split('/').includes('..')) throw invalidParams('Unsafe project path.');
  const target = path.resolve(base, value);
  if (!within(root, target)) throw new McpError('UNSAFE_FS', 'Path is outside the bound project.');
  // lstat, rather than existsSync, also rejects dangling symlinks.
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new McpError('UNSAFE_FS', 'Symlinks are not accepted by project file transport.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}

export function filePath(root: string, value: string, write: boolean): string {
  const target = boundPath(root, value);
  const relative = path.relative(root, target).split(path.sep).join('/');
  // Protected paths are case-folded even on case-sensitive disks: the same
  // policy must hold on the default case-insensitive macOS filesystem.
  const folded = relative.toLowerCase();
  const parts = folded.split('/');
  const hidden = parts.some(part => part.startsWith('.'));
  const allowedStateRead = /^\.nullius\/(state\.json|harness|harness_invocation)$/.test(folded);
  if (!relative || (hidden && !(allowedStateRead && !write)) || /\.(pem|key|p12|pfx)$/i.test(relative)) {
    throw new McpError('UNSAFE_FS', 'Hidden configuration and credentials are outside the file transport.');
  }
  if (folded.startsWith('artifacts/delegated-runs/') || folded.startsWith('team/runs/')) {
    throw new McpError('UNSAFE_FS', 'Use canonical runtime/delivery tools to access delegated state.');
  }
  if (write) {
    if (parts.some(part => ['agents.md', 'claude.md', 'project_index.md', 'research_notebook.md', 'research_team_config.json'].includes(part))) {
      throw new McpError('UNSAFE_FS', 'Use canonical project commands for managed instructions and projections.');
    }
    if (folded.startsWith('artifacts/runs/')) {
      const upload = /^artifacts\/runs\/[^/]+\/(verification\/(?:[^/]+\/)*[^/]+\.(py|js|mjs)|inputs\/.+|computation\/(scripts\/.+|inputs\/.+|manifest\.json))$/;
      if (!upload.test(folded)) throw new McpError('UNSAFE_FS', 'Generated run outputs and verification receipts cannot be uploaded.');
    } else if (folded.startsWith('artifacts/') && !folded.startsWith('artifacts/inputs/')) {
      throw new McpError('UNSAFE_FS', 'Upload source inputs under artifacts/inputs; generated artifacts remain runtime-owned.');
    }
  }
  return target;
}

function entriesIfDirectory(target: string): fs.Dirent[] {
  try { return fs.readdirSync(target, { withFileTypes: true }); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
    throw error;
  }
}

/** Validate every path the shared invocation verifier reads before it follows it. */
export function guardHarnessPaths(root: string): void {
  for (const relative of ['.nullius/HARNESS_INVOCATION', '.nullius/state.json', '.nullius/ledger.jsonl']) boundPath(root, relative);
}

/** Guard control metadata, not inert research data, environments or provider caches. */
export function guardRuntimePaths(root: string, manifestPath?: string): void {
  const visit = (target: string): void => {
    boundPath(root, target);
    for (const entry of entriesIfDirectory(target)) visit(path.join(target, entry.name));
  };
  for (const relative of ['.nullius', 'artifacts/delegated-runs']) visit(boundPath(root, relative));
  for (const relative of ['AGENTS.md', 'CLAUDE.md', 'project_index.md', 'research_notebook.md', 'research_plan.md', 'research_contract.md', 'research_team_config.json', '.gitignore', '.gitattributes', 'artifacts/runs/validity_ledger.jsonl', 'artifacts/runs/.gitattributes']) boundPath(root, relative);

  const workspace = (directory: string): void => {
    for (const file of ['manifest.json', 'execution_status.json', 'execution_plan.json', 'execution_plan_v1.json']) boundPath(root, path.join(directory, file));
    visit(path.join(directory, 'logs'));
  };
  for (const relative of ['artifacts/runs', 'team/runs']) {
    const runs = boundPath(root, relative);
    for (const run of entriesIfDirectory(runs)) {
      const directory = boundPath(root, path.join(runs, run.name));
      if (!run.isDirectory()) continue;
      // Canonical summaries/proposals/workflow outputs live directly in the run.
      // Do not descend into scripts, inputs, data, outputs, venvs or caches.
      for (const entry of entriesIfDirectory(directory)) {
        if (/\.(json|jsonl)$/i.test(entry.name)) boundPath(root, path.join(directory, entry.name));
      }
      for (const tree of ['artifacts', 'approvals', 'workflow_steps']) visit(path.join(directory, tree));
      workspace(directory);
      workspace(path.join(directory, 'computation'));
    }
  }
  // A manifest may live deeper than computation/. Check the actual runner's
  // implicit status/log paths too, without inspecting unrelated input trees.
  if (manifestPath) workspace(path.dirname(boundPath(root, manifestPath)));
  guardWorkflowReferences(root);
}

/** Legacy workflow recovery reads state/ledger-selected JSON outside fixed trees. */
function guardWorkflowReferences(root: string): void {
  const read = (relative: string): string | null => {
    try { return fs.readFileSync(boundPath(root, relative), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const parse = (text: string | null): Record<string, any> | null => {
    try {
      const value: unknown = JSON.parse(text ?? 'null');
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
    } catch { return null; } // Canonical readers own malformed-record errors.
  };
  const state = parse(read('.nullius/state.json'));
  if (typeof state?.run_id !== 'string') return;
  const run = boundPath(root, `artifacts/runs/${safeId(state.run_id)}`);
  const reference = (value: unknown): void => {
    if (typeof value !== 'string' || !value.trim()) return;
    const marker = value.indexOf('/artifact/');
    let target: string;
    try { target = marker < 0 ? path.resolve(root, value) : path.join(run, decodeURIComponent(value.slice(marker + '/artifact/'.length))); }
    catch { throw invalidParams('Malformed workflow artifact URI in project state/ledger; reconcile its source record locally.'); }
    boundPath(root, target);
  };
  const key = (value: unknown): void => {
    if (typeof value === 'string' && value) boundPath(root, path.join(run, `${value}.json`));
  };
  if (state.artifacts && typeof state.artifacts === 'object') {
    for (const [name, value] of Object.entries(state.artifacts)) { key(name); reference(value); }
  }
  if (Array.isArray(state.plan?.steps)) {
    for (const step of state.plan.steps) {
      key(step?.step_id);
      const artifact = step?.execution?.consumer_hints?.artifact;
      if (typeof artifact === 'string') key(artifact.trim());
    }
  }
  for (const line of (read('.nullius/ledger.jsonl') ?? '').split('\n')) {
    const event = parse(line);
    if (event?.run_id !== state.run_id || !['workflow_step_completed', 'workflow_step_skipped', 'workflow_step_failed'].includes(event?.event_type)) continue;
    key(event.step_id);
    key(event.details?.artifact_key);
    if (typeof event.details?.artifact_uri === 'string' && event.details.artifact_uri.includes('/artifact/')) reference(event.details.artifact_uri);
  }
}

export function safeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes('..')) throw invalidParams('Expected one safe identifier.');
  return value;
}
