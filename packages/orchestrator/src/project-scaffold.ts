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

export function ensureProjectScaffold(
  repoRoot: string,
  options: { force?: boolean; profile?: string; projectName?: string } = {},
): { created: string[]; skipped: string[] } {
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
    '--variant',
    'minimal',
    '--project-policy',
    'real_project',
  ];
  if (options.force) argv.push('--force');
  const result = spawnSync(python, argv, {
    encoding: 'utf-8',
    env: extendPythonPath(process.env),
  });
  if (result.error) throw new Error(`failed to launch project scaffold authority: ${result.error.message}`);
  if (result.status !== 0) {
    const message = result.stderr?.trim() || result.stdout?.trim() || `project scaffold exited with status ${String(result.status)}`;
    throw new Error(message);
  }
  const payload = JSON.parse(result.stdout) as { created?: string[]; skipped?: string[] };
  return {
    created: Array.isArray(payload.created) ? payload.created : [],
    skipped: Array.isArray(payload.skipped) ? payload.skipped : [],
  };
}
