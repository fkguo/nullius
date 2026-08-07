import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeBytesAtomicDurable, writeJsonAtomicDurable } from '@nullius/shared';
import { resolveLifecycleProjectRoot } from './cli-project-root.js';
import { ensureNulliusHarnessSentinel } from './nullius-harness-sentinel.js';
import { ensureProjectLocalNulliusLauncher, projectLocalNulliusRelativePath } from './project-local-nullius.js';
import { ensureProjectScaffold, type ProjectScaffoldResult } from './project-scaffold.js';
import { type CliIo } from './cli-lifecycle.js';
import { StateManager } from './state-manager.js';
import type { ExecutionMode } from './types.js';
import { assertProjectRootAllowed, resolveUserPath } from './project-policy.js';

type InitOptions = {
  allowNested: boolean;
  checkpointIntervalSeconds: number | null;
  force: boolean;
  refresh: boolean;
  dryRun: boolean;
  runtimeOnly: boolean;
  mode: ExecutionMode | null;
  noGit: boolean;
};

function parseExecutionMode(raw: string): ExecutionMode {
  if (raw === 'engine' || raw === 'file') return raw;
  throw new Error(`invalid --mode value: ${raw} (expected engine or file)`);
}

function parseInitArgs(args: string[]): InitOptions {
  const options: InitOptions = { allowNested: false, checkpointIntervalSeconds: null, force: false, refresh: false, dryRun: false, runtimeOnly: false, mode: null, noGit: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = arg.startsWith('--checkpoint-interval-seconds=') ? arg.split('=', 2)[1] ?? '' : null;
    const modeValue = arg.startsWith('--mode=') ? arg.slice('--mode='.length) : null;
    if (arg === '--force') options.force = true;
    else if (arg === '--refresh') options.refresh = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--allow-nested') options.allowNested = true;
    else if (arg === '--runtime-only') options.runtimeOnly = true;
    else if (arg === '--no-git') options.noGit = true;
    else if (arg === '--mode' || modeValue !== null) {
      const raw = modeValue ?? args[++index] ?? '';
      if (!raw || raw.startsWith('-')) throw new Error('missing value for --mode (engine or file)');
      options.mode = parseExecutionMode(raw);
    }
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

/** D7: init owns git presence. On a full init of a non-repo root, bootstrap
 *  a repository and commit the scaffold files only, announcing what happened;
 *  with --no-git the opt-out is recorded and the status/current traceability
 *  surface reports the unanswerable code-revision clause EVERY reconnect —
 *  never a silent absence. runtime-only performs the presence CHECK and
 *  prints the suggestion but creates nothing scaffold-owned. */
function ensureGitPresence(
  repoRoot: string,
  options: InitOptions,
  scaffold: ProjectScaffoldResult | null,
  manager: StateManager,
  io: CliIo,
): void {
  const git = (args: string[]): string => execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let insideWorkTree = false;
  try {
    insideWorkTree = git(['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    insideWorkTree = false;
  }
  if (insideWorkTree) return;
  // The explicit decline wins over every other branch — a user who passed
  // --no-git (even with --runtime-only) gets the decline RECORDED, not a
  // bootstrap suggestion that ignores what they just said.
  if (options.noGit) {
    manager.appendLedger('git_bootstrap_declined', { details: { reason: '--no-git' } });
    io.stdout(
      '[ok] git bootstrap declined (--no-git); recorded. The status/current traceability surface '
      + 'will report the code-revision clause as unanswerable on every reconnect. Record the '
      + 'rationale durably with: nullius decision record "declined git bootstrap: <why>"\n',
    );
    return;
  }
  if (options.runtimeOnly) {
    io.stdout(
      '[warn] this project root is not a git repository: results cannot be bound to an exact code '
      + 'revision until one exists. Bootstrap with a full `nullius init` (or plain `git init`), '
      + 'then backfill run bindings.\n',
    );
    return;
  }
  // Guard the destructive rollback below on a VERIFIED precondition: a
  // pre-existing .git can fail the worktree probe while still holding real
  // history (dubious-ownership refusal on foreign-owned mounts, a
  // crash-truncated HEAD, an inherited GIT_DIR) — reinit would succeed, the
  // commit would fail, and an unguarded rollback would delete the user's
  // repository. Only a .git this invocation created is ever removed.
  const gitDirExistedBefore = fs.existsSync(path.join(repoRoot, '.git'));
  try {
    git(['init', '-q']);
  } catch (error) {
    io.stdout(
      `[warn] git init failed (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); `
      + 'the project stays without a repository and the code-revision clause stays unanswerable.\n',
    );
    return;
  }
  try {
    const scaffoldFiles = [
      ...(scaffold?.created ?? []),
      ...(scaffold?.refreshed ?? []),
      ...(scaffold?.unchanged ?? []),
    ].filter(rel => fs.existsSync(path.join(repoRoot, rel)));
    if (scaffoldFiles.length > 0) {
      git(['add', '--', ...scaffoldFiles]);
    }
    // Scaffold-only initial commit: research content the user already has in
    // the directory stays untracked for their own explicit decision.
    // --allow-empty keeps the guarantee that a bootstrapped repository has a
    // HEAD even when no scaffold file exists (runtime-only layouts) — an
    // unborn-HEAD repo would leave every stamp unbindable.
    git([
      '-c', 'user.name=nullius-init',
      '-c', 'user.email=nullius-init@localhost',
      'commit', '-q', '--allow-empty', '-m', 'chore: nullius project scaffold',
    ]);
    manager.appendLedger('git_bootstrap_completed', { details: { committed_files: scaffoldFiles.length } });
    io.stdout(
      `[ok] initialized a git repository (scaffold-only initial commit, ${scaffoldFiles.length} file(s)); `
      + 'pre-existing research files stay untracked until you add them — an explicit track-or-ignore decision.\n',
    );
  } catch (error) {
    rollbackBootstrapGitDir(repoRoot, gitDirExistedBefore);
    io.stdout(
      `[warn] git bootstrap failed after init (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); `
      + (gitDirExistedBefore
        ? 'a pre-existing .git was found and left untouched (it may need manual repair); '
        : 'the just-created repository was removed so a rerun can retry cleanly; ')
      + 'the code-revision clause stays unanswerable.\n',
    );
  }
}

/** Remove .git ONLY when this invocation created it. Exported for the direct
 *  unit test of both directions — the destructive branch of a traceability
 *  tool must be provably guarded, not assumed. */
export function rollbackBootstrapGitDir(repoRoot: string, gitDirExistedBefore: boolean): void {
  if (gitDirExistedBefore) return;
  fs.rmSync(path.join(repoRoot, '.git'), { recursive: true, force: true });
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
  for (const rel of scaffold.missing) lines.push(`- missing (user-owned; migrate explicitly, refresh will not create): ${rel}`);
  for (const line of lines.slice(0, 50)) io.stdout(`${line}\n`);
  if (lines.length > 50) io.stdout(`- ... (${lines.length - 50} more)\n`);
  if (scaffold.backedUp.length > 0) {
    if (dryRun) {
      io.stdout(`[ok] would back up ${scaffold.backedUp.length} changed managed file(s) before overwriting.\n`);
    } else {
      io.stdout(
        `[ok] backed up ${scaffold.backedUp.length} changed managed file(s) to ${scaffold.backupDir ?? '.nullius/backups/'} — review to re-apply any host customizations.\n`,
      );
    }
  }
}

export async function runInitCommand(projectRoot: string | null, cwd: string, args: string[], io: CliIo): Promise<void> {
  const options = parseInitArgs(args);
  const repoRoot = projectRoot ? resolveUserPath(projectRoot, cwd) : path.resolve(cwd);
  assertProjectRootAllowed(repoRoot);
  if (path.basename(repoRoot) === '.nullius') {
    throw new Error('refusing init inside .nullius/ (run init at the project root, or use --project-root)');
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
    if (options.mode !== null) {
      io.stdout(`[ok] would declare execution mode: ${options.mode} (--dry-run, not written)\n`);
    }
    return;
  }
  manager.ensureDirs();
  const scaffold = options.runtimeOnly
    ? null
    : ensureProjectScaffold(repoRoot, options.refresh ? { refresh: true } : { force: options.force });
  const statePath = manager.statePath;
  const stateExisted = fs.existsSync(statePath);
  if (stateExisted && !options.force) {
    io.stdout(`[ok] already initialized: ${statePath}\n`);
    if (options.mode !== null) {
      const state = manager.readState();
      if (state.execution_mode === options.mode) {
        io.stdout(`[ok] execution mode already declared: ${options.mode}\n`);
      } else {
        state.execution_mode = options.mode;
        // Audit event before the state write: if the two cannot both land,
        // a retry re-declares (worst case a duplicated audit line), whereas
        // the reverse order would change the mode with no audit event and
        // the retry would report "already declared" forever.
        manager.appendLedger('execution_mode_declared', { details: { execution_mode: options.mode } });
        manager.saveState(state);
        io.stdout(`[ok] execution mode declared: ${options.mode}\n`);
      }
    }
  } else {
    // readState() returns the EXISTING state when the file is present (the
    // --force path), so a prior declaration survives unless --mode changes it.
    const state = manager.readState();
    const priorMode = state.execution_mode ?? null;
    if (options.checkpointIntervalSeconds !== null) {
      state.checkpoints.checkpoint_interval_seconds = options.checkpointIntervalSeconds;
    }
    if (options.mode !== null) {
      state.execution_mode = options.mode;
    }
    if (stateExisted && options.mode !== null && priorMode !== options.mode) {
      // A --force re-init that changes the declaration is still a declaration
      // change; keep the dedicated audit event the non-force path writes, and
      // write it before the state so a failure between the two is repaired by
      // an idempotent retry instead of losing the audit trail.
      manager.appendLedger('execution_mode_declared', { details: { execution_mode: options.mode } });
    }
    // Event before state here as well: if the ledger append fails, the state
    // file is not created, so the retry is a clean fresh init instead of an
    // "already initialized" root whose declaration audit never existed.
    manager.appendLedger('initialized', options.mode !== null ? { details: { execution_mode: options.mode } } : {});
    manager.saveState(state);
    io.stdout(`[ok] wrote: ${statePath}\n`);
    if (options.mode !== null) {
      io.stdout(`[ok] execution mode declared: ${options.mode}\n`);
    }
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
  const launcher = ensureProjectLocalNulliusLauncher(repoRoot);
  io.stdout(`[ok] wrote: ${launcher.launcher_path}\n`);
  const harnessSentinelPath = ensureNulliusHarnessSentinel(repoRoot);
  io.stdout(`[ok] wrote: ${harnessSentinelPath}\n`);
  io.stdout(`[ok] runtime dir: ${runtimeDir}\n`);
  if (options.runtimeOnly) {
    ensureGitPresence(repoRoot, options, scaffold, manager, io);
    io.stdout(`[ok] project-local fallback launcher ready: ${projectLocalNulliusRelativePath()} (${launcher.launcher_mode})\n`);
    io.stdout('[ok] project scaffold skipped (--runtime-only)\n');
    return;
  }
  ensureGitPresence(repoRoot, options, scaffold, manager, io);
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
  io.stdout(`[ok] project-local fallback launcher ready: ${projectLocalNulliusRelativePath()} (${launcher.launcher_mode})\n`);
}
