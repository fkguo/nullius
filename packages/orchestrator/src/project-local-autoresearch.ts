import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBytesAtomicDurable } from '@autoresearch/shared';

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

const SELF_DERIVE_PROJECT_ROOT_LINE = 'PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)';
const RESOLVE_AUTORESEARCH_LINE = 'RESOLVED_AUTORESEARCH=$(command -v autoresearch 2>/dev/null || true)';
// `-ef` compares real file identity (device+inode, following symlinks), so a PATH
// entry that is — or symlinks back to — this launcher is rejected. A plain string
// compare would miss a symlink-to-self and self-hop, corrupting --project-root.
const PATH_PREFER_GUARD_LINE = 'if [ -n "$RESOLVED_AUTORESEARCH" ] && [ ! "$RESOLVED_AUTORESEARCH" -ef "$0" ]; then';
const PATH_PREFER_EXEC_LINE = 'exec autoresearch "$@" --project-root "$PROJECT_ROOT"';

function autoresearchResolvableOnPath(launcherPath: string): boolean {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return false;
  let launcherStat: fs.Stats | null = null;
  try {
    launcherStat = fs.statSync(launcherPath);
  } catch {
    launcherStat = null;
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'autoresearch');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const candidateStat = fs.statSync(candidate);
      // Mirror the launcher's runtime `command -v autoresearch`: only a regular
      // executable file counts (a directory named `autoresearch` carries the
      // execute bit but is not a resolvable command).
      if (!candidateStat.isFile()) continue;
      // Mirror the launcher's runtime `-ef` self-check (device+inode, following
      // symlinks): a symlink OR hard link back to this launcher is the launcher
      // itself and cannot satisfy itself, so it is not a usable on-PATH autoresearch.
      if (launcherStat !== null && candidateStat.dev === launcherStat.dev && candidateStat.ino === launcherStat.ino) {
        continue;
      }
      return true;
    } catch {
      // not resolvable here; keep scanning PATH
    }
  }
  return false;
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

function hasProjectLocalLauncherShape(script: string): boolean {
  const lines = script.split(/\r?\n/u);
  const hasSelfDerivedRoot = lines.includes(SELF_DERIVE_PROJECT_ROOT_LINE);
  // Require the self-identity guard: an older unguarded PATH-prefer launcher would
  // self-recurse, so it must be reported unparseable (→ refresh) rather than healthy.
  const hasSelfGuard = lines.some(line => line.trim() === PATH_PREFER_GUARD_LINE);
  const hasPathPreferExec = lines.some(line => line.trim() === PATH_PREFER_EXEC_LINE);
  const hasFallbackExec = lines.some(line =>
    /^\s*exec\s+'\/.*\s"\$@"\s+--project-root\s+"\$PROJECT_ROOT"\s*$/u.test(line),
  );
  return hasSelfDerivedRoot && hasSelfGuard && hasPathPreferExec && hasFallbackExec;
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
  if (!hasProjectLocalLauncherShape(script)) {
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
  // The portable launcher prefers an `autoresearch` on PATH and only falls back to
  // the baked checkout paths. A missing baked target is therefore fatal only when
  // PATH cannot satisfy the launcher either.
  const missingPaths = checkedPaths.filter(candidate => !fs.existsSync(candidate));
  if (missingPaths.length > 0 && !autoresearchResolvableOnPath(launcherPath)) {
    return {
      ...base,
      exists: true,
      executable,
      healthy: false,
      checked_paths: checkedPaths,
      missing_paths: missingPaths,
      issue_code: 'PROJECT_LOCAL_LAUNCHER_TARGET_MISSING',
      message: `Project-local fallback launcher points at a missing CLI target and no autoresearch is on PATH; run ${repairCommand()} from the project root to refresh it.`,
    };
  }
  return {
    ...base,
    exists: true,
    executable,
    healthy: true,
    checked_paths: checkedPaths,
    missing_paths: missingPaths,
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
  const fallbackChecks = launcher.argv
    .filter(arg => path.isAbsolute(arg))
    .flatMap(arg => [
      `if [ ! -e ${shellQuote(arg)} ]; then`,
      "  printf '%s\\n' '[error] autoresearch is not on PATH and the project-local fallback target is missing.' >&2",
      `  printf '%s\\n' ${shellQuote(`[error] missing: ${arg}`)} >&2`,
      `  printf '%s\\n' ${shellQuote(`[error] run on this machine: ${repairCommand()}`)} >&2`,
      '  exit 127',
      'fi',
    ]);
  const script = [
    '#!/bin/sh',
    'set -eu',
    '# Autoresearch project-local fallback launcher.',
    '# Portable: the project root is derived from this script location, and an',
    '# autoresearch on PATH is preferred, so the project keeps working after being',
    `# moved or copied to another machine. If neither resolves, rerun: ${repairCommand()}`,
    SELF_DERIVE_PROJECT_ROOT_LINE,
    '# Prefer an autoresearch on PATH, but never this launcher itself: -ef compares',
    '# real file identity, so a PATH entry that is (or symlinks back to) this script',
    '# is rejected. Without it a self-referential PATH would recurse and corrupt',
    '# --project-root. If no other autoresearch resolves, fall through to the baked CLI.',
    RESOLVE_AUTORESEARCH_LINE,
    PATH_PREFER_GUARD_LINE,
    `  ${PATH_PREFER_EXEC_LINE}`,
    'fi',
    ...fallbackChecks,
    `exec ${launcher.argv.map(shellQuote).join(' ')} "$@" --project-root "$PROJECT_ROOT"`,
    '',
  ].join('\n');
  // Durable + race-free: mode is applied at openSync (create-time) AND
  // enforced via fchmod before fsync, eliminating the chmod-after-write
  // window where a peer could exec a partial file with default mode.
  writeBytesAtomicDurable(launcherPath, script, 0o755);
  return {
    launcher_path: launcherPath,
    launcher_mode: launcher.mode,
  };
}
