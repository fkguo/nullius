import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRootFromModule(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

function splitProjectRootFlag(args: string[]): { globalArgs: string[]; commandArgs: string[] } {
  if (args.length >= 2 && args[0] === '--project-root') {
    return { globalArgs: args.slice(0, 2), commandArgs: args.slice(2) };
  }
  if (args.length >= 1 && args[0].startsWith('--project-root=')) {
    return { globalArgs: [args[0]], commandArgs: args.slice(1) };
  }
  return { globalArgs: [], commandArgs: args };
}

function extendPythonPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const repoRoot = repoRootFromModule();
  const sources = [
    path.join(repoRoot, 'packages', 'hep-autoresearch', 'src'),
    path.join(repoRoot, 'packages', 'project-contracts', 'src'),
  ].filter(candidate => fs.existsSync(candidate));
  if (sources.length === 0) {
    return { ...env };
  }
  const existing = env.PYTHONPATH ? env.PYTHONPATH.split(path.delimiter).filter(Boolean) : [];
  return {
    ...env,
    PYTHONPATH: [...sources, ...existing].join(path.delimiter),
  };
}

export function runLegacyPythonSubcommand(command: 'init' | 'export', args: string[]): number {
  const python = process.env.HEP_AUTORESEARCH_PYTHON || 'python3';
  const { globalArgs, commandArgs } = splitProjectRootFlag(args);
  const result = spawnSync(
    python,
    ['-m', 'hep_autoresearch', ...globalArgs, command, ...commandArgs],
    {
      env: extendPythonPath(process.env),
      stdio: 'inherit',
    },
  );
  if (result.status !== null) {
    return result.status;
  }
  console.error(`[autoresearch] failed to launch Python for "${command}"`);
  return 1;
}
