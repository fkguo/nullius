import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function projectContractsRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '../../project-contracts/src');
}

function extendPythonPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const existing = env.PYTHONPATH?.trim();
  const addition = projectContractsRoot();
  return {
    ...env,
    PYTHONPATH: existing ? `${addition}${path.delimiter}${existing}` : addition,
  };
}

export type ProjectScaffoldResult = {
  created: string[];
  skipped: string[];
  refreshed: string[];
  backedUp: string[];
  unchanged: string[];
  preserved: string[];
  missing: string[];
  backupDir: string | null;
  dryRun: boolean;
};

export function ensureProjectScaffold(
  repoRoot: string,
  options: { force?: boolean; refresh?: boolean; dryRun?: boolean; profile?: string; projectName?: string } = {},
): ProjectScaffoldResult {
  const python = process.env.AUTORESEARCH_PYTHON || process.env.HEP_AUTORESEARCH_PYTHON || 'python3';
  const projectName = (options.projectName ?? path.basename(repoRoot) ?? 'Research Project').trim() || 'Research Project';
  const profile = (options.profile ?? 'mixed').trim() || 'mixed';
  const argv = [
    '-m',
    'project_contracts.project_scaffold_cli',
    '--root',
    repoRoot,
    '--project',
    projectName,
    '--profile',
    profile,
    '--project-policy',
    'real_project',
  ];
  if (options.force) argv.push('--force');
  if (options.refresh) argv.push('--refresh');
  if (options.dryRun) argv.push('--dry-run');
  const result = spawnSync(python, argv, {
    encoding: 'utf-8',
    env: extendPythonPath(process.env),
  });
  if (result.error) throw new Error(`failed to launch project scaffold authority: ${result.error.message}`);
  if (result.status !== 0) {
    const message = result.stderr?.trim() || result.stdout?.trim() || `project scaffold exited with status ${String(result.status)}`;
    throw new Error(message);
  }
  const payload = JSON.parse(result.stdout) as {
    created?: string[];
    skipped?: string[];
    refreshed?: string[];
    backed_up?: string[];
    unchanged?: string[];
    preserved?: string[];
    missing?: string[];
    backup_dir?: string | null;
    dry_run?: boolean;
  };
  const stringArray = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);
  return {
    created: stringArray(payload.created),
    skipped: stringArray(payload.skipped),
    refreshed: stringArray(payload.refreshed),
    backedUp: stringArray(payload.backed_up),
    unchanged: stringArray(payload.unchanged),
    preserved: stringArray(payload.preserved),
    missing: stringArray(payload.missing),
    backupDir: typeof payload.backup_dir === 'string' ? payload.backup_dir : null,
    dryRun: payload.dry_run === true,
  };
}
