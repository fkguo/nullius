import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

type ProjectLocalAutoresearchLauncher = {
  argv: string[];
  mode: 'dist' | 'tsx';
};

export type ProjectLocalAutoresearchLauncherHealth = {
  path: string;
  exists: boolean;
  executable: boolean;
  healthy: boolean;
  repair_command: string;
  issue_code: string | null;
  message: string | null;
  checked_paths: string[];
  missing_paths: string[];
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

function repairCommand(): string {
  return 'autoresearch init --runtime-only';
}

function unquoteShellSingleQuoted(value: string): string {
  return value.replace(/'"'"'/g, "'");
}

function extractExecQuotedPaths(script: string): string[] {
  const paths: string[] = [];
  for (const line of script.split(/\r?\n/u)) {
    if (!/^\s*exec\s/u.test(line)) continue;
    for (const match of line.matchAll(/'((?:[^']|'"'"')*)'/gu)) {
      const value = unquoteShellSingleQuoted(match[1] ?? '');
      if (path.isAbsolute(value)) {
        paths.push(value);
      }
    }
  }
  return paths;
}

function hasProjectLocalLauncherShape(script: string, projectRoot: string): boolean {
  const lines = script.split(/\r?\n/u);
  const hasProjectRootAssignment = lines.includes(`PROJECT_ROOT=${shellQuote(projectRoot)}`);
  const hasProjectRootExec = lines.some(line => /^\s*exec\s+.+\s"\$@"\s+--project-root\s+"\$PROJECT_ROOT"\s*$/u.test(line));
  return hasProjectRootAssignment && hasProjectRootExec;
}

export function readProjectLocalAutoresearchLauncherHealth(projectRoot: string): ProjectLocalAutoresearchLauncherHealth {
  const relativePath = projectLocalAutoresearchRelativePath().split(path.sep).join('/');
  const launcherPath = path.join(projectRoot, relativePath);
  const base = {
    path: relativePath,
    repair_command: repairCommand(),
    checked_paths: [] as string[],
    missing_paths: [] as string[],
  };
  if (!fs.existsSync(launcherPath)) {
    return {
      ...base,
      exists: false,
      executable: false,
      healthy: false,
      issue_code: 'PROJECT_LOCAL_LAUNCHER_MISSING',
      message: `Project-local fallback launcher is missing; run ${repairCommand()} from the project root to refresh it.`,
    };
  }
  const executable = (fs.statSync(launcherPath).mode & 0o111) !== 0;
  if (!executable) {
    return {
      ...base,
      exists: true,
      executable,
      healthy: false,
      issue_code: 'PROJECT_LOCAL_LAUNCHER_NOT_EXECUTABLE',
      message: `Project-local fallback launcher is not executable; run ${repairCommand()} from the project root to refresh it.`,
    };
  }
  const script = fs.readFileSync(launcherPath, 'utf-8');
  const checkedPaths = [...new Set(extractExecQuotedPaths(script))];
  if (!hasProjectLocalLauncherShape(script, projectRoot)) {
    return {
      ...base,
      exists: true,
      executable,
      healthy: false,
      checked_paths: checkedPaths,
      issue_code: 'PROJECT_LOCAL_LAUNCHER_UNPARSEABLE',
      message: `Project-local fallback launcher format is unrecognized; run ${repairCommand()} from the project root to refresh it.`,
    };
  }
  const missingPaths = checkedPaths.filter(candidate => !fs.existsSync(candidate));
  if (missingPaths.length > 0) {
    return {
      ...base,
      exists: true,
      executable,
      healthy: false,
      checked_paths: checkedPaths,
      missing_paths: missingPaths,
      issue_code: 'PROJECT_LOCAL_LAUNCHER_TARGET_MISSING',
      message: `Project-local fallback launcher points at a missing CLI target; run ${repairCommand()} from the project root to refresh it.`,
    };
  }
  return {
    ...base,
    exists: true,
    executable,
    healthy: true,
    checked_paths: checkedPaths,
    issue_code: null,
    message: null,
  };
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
      const tsxPackageJsonPath = require.resolve('tsx/package.json');
      const tsxPackageRoot = path.dirname(tsxPackageJsonPath);
      const packageJson = JSON.parse(fs.readFileSync(tsxPackageJsonPath, 'utf-8')) as {
        bin?: string | Record<string, string>;
      };
      const relativeBin = typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin && typeof packageJson.bin === 'object'
          ? packageJson.bin.tsx
          : null;
      tsxCliPath = relativeBin ? path.join(tsxPackageRoot, relativeBin) : null;
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
  const checks = launcher.argv
    .filter(arg => path.isAbsolute(arg))
    .flatMap(arg => [
      `if [ ! -e ${shellQuote(arg)} ]; then`,
      "  printf '%s\\n' '[error] project-local autoresearch launcher target is missing; refresh this project-local fallback.' >&2",
      `  printf '%s\\n' ${shellQuote(`[error] missing: ${arg}`)} >&2`,
      `  printf '%s\\n' ${shellQuote(`[error] run: ${repairCommand()}`)} >&2`,
      '  exit 127',
      'fi',
    ]);
  const script = [
    '#!/bin/sh',
    'set -eu',
    '# Autoresearch project-local fallback launcher.',
    '# If this checkout was removed, rerun: autoresearch init --runtime-only',
    `PROJECT_ROOT=${shellQuote(projectRoot)}`,
    ...checks,
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
