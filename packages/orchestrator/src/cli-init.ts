import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveLifecycleProjectRoot } from './cli-project-root.js';
import { ensureProjectScaffold } from './project-scaffold.js';
import { type CliIo } from './cli-lifecycle.js';
import { StateManager } from './state-manager.js';
import { resolveUserPath } from './project-policy.js';

type InitOptions = {
  allowNested: boolean;
  checkpointIntervalSeconds: number | null;
  force: boolean;
  runtimeOnly: boolean;
};

function parseInitArgs(args: string[]): InitOptions {
  const options: InitOptions = { allowNested: false, checkpointIntervalSeconds: null, force: false, runtimeOnly: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = arg.startsWith('--checkpoint-interval-seconds=') ? arg.split('=', 2)[1] ?? '' : null;
    if (arg === '--force') options.force = true;
    else if (arg === '--allow-nested') options.allowNested = true;
    else if (arg === '--runtime-only') options.runtimeOnly = true;
    else if (arg === '--checkpoint-interval-seconds' || value !== null) {
      const raw = value ?? args[++index] ?? '';
      if (!raw || raw.startsWith('-')) throw new Error('missing value for --checkpoint-interval-seconds');
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) throw new Error(`invalid checkpoint interval: ${raw}`);
      options.checkpointIntervalSeconds = parsed;
    } else {
      throw new Error(`unknown init argument: ${arg}`);
    }
  }
  return options;
}

function findParentProjectRoot(start: string): string | null {
  const resolved = path.resolve(start);
  const candidate = resolveLifecycleProjectRoot(null, resolved);
  return candidate === resolved ? null : candidate;
}

export async function runInitCommand(projectRoot: string | null, cwd: string, args: string[], io: CliIo): Promise<void> {
  const options = parseInitArgs(args);
  const repoRoot = projectRoot ? resolveUserPath(projectRoot, cwd) : path.resolve(cwd);
  if (path.basename(repoRoot) === '.autoresearch') {
    throw new Error('refusing init inside .autoresearch/ (run init at the project root, or use --project-root)');
  }
  const parentRoot = findParentProjectRoot(path.dirname(repoRoot));
  if (parentRoot && parentRoot !== repoRoot && !options.allowNested) {
    throw new Error(`refusing init: a parent directory is already a project root (${parentRoot}); run init at the intended root, or pass --allow-nested`);
  }
  const manager = new StateManager(repoRoot);
  const runtimeDir = path.dirname(manager.statePath);
  manager.ensureDirs();
  const scaffold = options.runtimeOnly ? { created: [] as string[] } : ensureProjectScaffold(repoRoot, { force: options.force });
  const statePath = manager.statePath;
  if (fs.existsSync(statePath) && !options.force) {
    io.stdout(`[ok] already initialized: ${statePath}\n`);
  } else {
    const state = manager.readState();
    if (options.checkpointIntervalSeconds !== null) {
      state.checkpoints.checkpoint_interval_seconds = options.checkpointIntervalSeconds;
    }
    manager.saveState(state);
    manager.appendLedger('initialized', {});
    io.stdout(`[ok] wrote: ${statePath}\n`);
  }

  if (!fs.existsSync(manager.policyPath)) {
    const policy = {
      schema_version: 1,
      mode: 'safe',
      require_approval_for: { mass_search: true, code_changes: true, compute_runs: true, paper_edits: true, final_conclusions: true },
      budgets: { max_network_calls: 200, max_runtime_minutes: 60 },
      timeouts: {
        mass_search: { timeout_seconds: 86400, on_timeout: 'block' },
        code_changes: { timeout_seconds: 172800, on_timeout: 'block' },
        compute_runs: { timeout_seconds: 172800, on_timeout: 'block' },
        paper_edits: { timeout_seconds: 604800, on_timeout: 'block' },
        final_conclusions: { timeout_seconds: 604800, on_timeout: 'block' },
      },
      notes: 'Default: human-in-the-loop at high-risk steps. Increase budgets or relax approvals only with explicit user consent.',
    };
    fs.writeFileSync(manager.policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf-8');
    io.stdout(`[ok] wrote: ${manager.policyPath}\n`);
  } else {
    io.stdout(`[ok] approval policy present: ${manager.policyPath}\n`);
  }

  const markerPath = path.join(runtimeDir, '.initialized');
  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf-8');
  }
  io.stdout(`[ok] runtime dir: ${runtimeDir}\n`);
  if (options.runtimeOnly) {
    io.stdout('[ok] project scaffold skipped (--runtime-only)\n');
    return;
  }
  if (scaffold.created.length > 0) {
    io.stdout('[ok] scaffold created:\n');
    for (const relativePath of scaffold.created.slice(0, 50)) {
      io.stdout(`- ${relativePath}\n`);
    }
    if (scaffold.created.length > 50) {
      io.stdout(`- ... (${scaffold.created.length - 50} more)\n`);
    }
  }
}
