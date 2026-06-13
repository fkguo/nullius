import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeBytesAtomicDurable, writeJsonAtomicDurable } from '@autoresearch/shared';
import { resolveLifecycleProjectRoot } from './cli-project-root.js';
import { ensureAutoresearchHarnessSentinel } from './autoresearch-harness-sentinel.js';
import { ensureProjectLocalAutoresearchLauncher, projectLocalAutoresearchRelativePath } from './project-local-autoresearch.js';
import { ensureProjectScaffold, type ProjectScaffoldResult } from './project-scaffold.js';
import { type CliIo } from './cli-lifecycle.js';
import { StateManager } from './state-manager.js';
import { assertProjectRootAllowed, resolveUserPath } from './project-policy.js';

type InitOptions = {
  allowNested: boolean;
  checkpointIntervalSeconds: number | null;
  force: boolean;
  refresh: boolean;
  dryRun: boolean;
  runtimeOnly: boolean;
};

function parseInitArgs(args: string[]): InitOptions {
  const options: InitOptions = { allowNested: false, checkpointIntervalSeconds: null, force: false, refresh: false, dryRun: false, runtimeOnly: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = arg.startsWith('--checkpoint-interval-seconds=') ? arg.split('=', 2)[1] ?? '' : null;
    if (arg === '--force') options.force = true;
    else if (arg === '--refresh') options.refresh = true;
    else if (arg === '--dry-run') options.dryRun = true;
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
  if (options.refresh && options.force) throw new Error('choose either --refresh or --force for init, not both');
  if (options.refresh && options.runtimeOnly) throw new Error('--refresh cannot be combined with --runtime-only');
  if (options.dryRun && !options.refresh) throw new Error('--dry-run is only valid together with --refresh');
  return options;
}

function findParentProjectRoot(start: string): string | null {
  const resolved = path.resolve(start);
  const candidate = resolveLifecycleProjectRoot(null, resolved);
  return candidate === resolved ? null : candidate;
}

function emitRefreshSummary(io: CliIo, scaffold: ProjectScaffoldResult, dryRun: boolean): void {
  io.stdout(`[ok] scaffold refresh${dryRun ? ' preview (--dry-run, no files written)' : ''}:\n`);
  const verb = dryRun ? 'would refresh' : 'refreshed';
  const lines: string[] = [];
  for (const rel of scaffold.created) lines.push(`- create: ${rel}`);
  for (const rel of scaffold.refreshed) lines.push(`- ${verb}: ${rel}`);
  for (const rel of scaffold.unchanged) lines.push(`- unchanged: ${rel}`);
  for (const rel of scaffold.preserved) lines.push(`- preserved (user-owned, untouched): ${rel}`);
  for (const rel of scaffold.missing) lines.push(`- missing (run \`autoresearch init\` to recreate): ${rel}`);
  for (const line of lines.slice(0, 50)) io.stdout(`${line}\n`);
  if (lines.length > 50) io.stdout(`- ... (${lines.length - 50} more)\n`);
  if (scaffold.backedUp.length > 0) {
    if (dryRun) {
      io.stdout(`[ok] would back up ${scaffold.backedUp.length} changed managed file(s) before overwriting.\n`);
    } else {
      io.stdout(
        `[ok] backed up ${scaffold.backedUp.length} changed managed file(s) to ${scaffold.backupDir ?? '.autoresearch/backups/'} — review to re-apply any host customizations.\n`,
      );
    }
  }
}

export async function runInitCommand(projectRoot: string | null, cwd: string, args: string[], io: CliIo): Promise<void> {
  const options = parseInitArgs(args);
  const repoRoot = projectRoot ? resolveUserPath(projectRoot, cwd) : path.resolve(cwd);
  assertProjectRootAllowed(repoRoot);
  if (path.basename(repoRoot) === '.autoresearch') {
    throw new Error('refusing init inside .autoresearch/ (run init at the project root, or use --project-root)');
  }
  const parentRoot = findParentProjectRoot(path.dirname(repoRoot));
  if (parentRoot && parentRoot !== repoRoot && !options.allowNested) {
    throw new Error(`refusing init: a parent directory is already a project root (${parentRoot}); run init at the intended root, or pass --allow-nested`);
  }
  const manager = new StateManager(repoRoot);
  const runtimeDir = path.dirname(manager.statePath);
  if (options.refresh && options.dryRun) {
    const preview = ensureProjectScaffold(repoRoot, { refresh: true, dryRun: true });
    emitRefreshSummary(io, preview, true);
    return;
  }
  manager.ensureDirs();
  const scaffold = options.runtimeOnly
    ? null
    : ensureProjectScaffold(repoRoot, options.refresh ? { refresh: true } : { force: options.force });
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
      require_approval_for: { mass_search: true, code_changes: true, compute_runs: false, paper_edits: true, final_conclusions: true },
      budgets: { max_network_calls: 200, max_runtime_minutes: 60 },
      timeouts: {
        mass_search: { timeout_seconds: 86400, on_timeout: 'block' },
        code_changes: { timeout_seconds: 172800, on_timeout: 'block' },
        compute_runs: { timeout_seconds: 172800, on_timeout: 'block' },
        paper_edits: { timeout_seconds: 604800, on_timeout: 'block' },
        final_conclusions: { timeout_seconds: 604800, on_timeout: 'block' },
      },
      notes: 'A1/A2/A4 are advisory checkpoints (no machine pause). A3 (compute_runs) is the one machine-enforced gate and defaults off — set compute_runs=true to require approval before compute, e.g. on unattended runs. A5 finalization always goes through the approve flow.',
    };
    writeJsonAtomicDurable(manager.policyPath, policy);
    io.stdout(`[ok] wrote: ${manager.policyPath}\n`);
  } else {
    io.stdout(`[ok] approval policy present: ${manager.policyPath}\n`);
  }

  const markerPath = path.join(runtimeDir, '.initialized');
  if (!fs.existsSync(markerPath)) {
    writeBytesAtomicDurable(markerPath, `${new Date().toISOString()}\n`);
  }
  const launcher = ensureProjectLocalAutoresearchLauncher(repoRoot);
  io.stdout(`[ok] wrote: ${launcher.launcher_path}\n`);
  const harnessSentinelPath = ensureAutoresearchHarnessSentinel(repoRoot);
  io.stdout(`[ok] wrote: ${harnessSentinelPath}\n`);
  io.stdout(`[ok] runtime dir: ${runtimeDir}\n`);
  if (options.runtimeOnly) {
    io.stdout(`[ok] project-local fallback launcher ready: ${projectLocalAutoresearchRelativePath()} (${launcher.launcher_mode})\n`);
    io.stdout('[ok] project scaffold skipped (--runtime-only)\n');
    return;
  }
  if (options.refresh) {
    emitRefreshSummary(io, scaffold!, false);
  } else if (scaffold && scaffold.created.length > 0) {
    io.stdout('[ok] scaffold created:\n');
    for (const relativePath of scaffold.created.slice(0, 50)) {
      io.stdout(`- ${relativePath}\n`);
    }
    if (scaffold.created.length > 50) {
      io.stdout(`- ... (${scaffold.created.length - 50} more)\n`);
    }
  }
  io.stdout(`[ok] project-local fallback launcher ready: ${projectLocalAutoresearchRelativePath()} (${launcher.launcher_mode})\n`);
}
