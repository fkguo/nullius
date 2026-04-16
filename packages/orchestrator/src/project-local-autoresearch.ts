import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

type ProjectLocalAutoresearchLauncher = {
  argv: string[];
  mode: 'dist' | 'tsx';
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function packageRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '..');
}

export function projectLocalAutoresearchRelativePath(): string {
  return path.join('.autoresearch', 'bin', 'autoresearch');
}

export function resolveProjectLocalAutoresearchLauncher(): ProjectLocalAutoresearchLauncher {
  const pkgRoot = packageRoot();
  const distCliPath = path.join(pkgRoot, 'dist', 'cli.js');
  if (fs.existsSync(distCliPath)) {
    return {
      argv: [process.execPath, distCliPath],
      mode: 'dist',
    };
  }

  const sourceCliPath = path.join(pkgRoot, 'src', 'cli.ts');
  if (fs.existsSync(sourceCliPath)) {
    const require = createRequire(import.meta.url);
    let tsxCliPath: string | null = null;
    try {
      tsxCliPath = require.resolve('tsx/dist/cli.mjs');
    } catch {
      tsxCliPath = null;
    }
    if (tsxCliPath && fs.existsSync(tsxCliPath)) {
      return {
        argv: [process.execPath, tsxCliPath, sourceCliPath],
        mode: 'tsx',
      };
    }
  }

  throw new Error(
    'could not resolve the canonical autoresearch CLI entrypoint; expected packages/orchestrator/dist/cli.js or repo-local tsx + packages/orchestrator/src/cli.ts',
  );
}

export function ensureProjectLocalAutoresearchLauncher(projectRoot: string): {
  launcher_path: string;
  launcher_mode: 'dist' | 'tsx';
} {
  const launcher = resolveProjectLocalAutoresearchLauncher();
  const launcherPath = path.join(projectRoot, projectLocalAutoresearchRelativePath());
  fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
  const script = [
    '#!/bin/sh',
    'set -eu',
    `PROJECT_ROOT=${shellQuote(projectRoot)}`,
    `exec ${launcher.argv.map(shellQuote).join(' ')} "$@" --project-root "$PROJECT_ROOT"`,
    '',
  ].join('\n');
  fs.writeFileSync(launcherPath, script, 'utf-8');
  fs.chmodSync(launcherPath, 0o755);
  return {
    launcher_path: launcherPath,
    launcher_mode: launcher.mode,
  };
}
