import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBytesAtomicDurable } from '@nullius/shared';

type ProjectLocalNulliusLauncher = {
  argv: string[];
  mode: 'dist' | 'tsx';
};

export type ProjectLocalNulliusLauncherHealth = {
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

export function projectLocalNulliusRelativePath(): string {
  return path.join('.nullius', 'bin', 'nullius');
}

function repairCommand(): string {
  return 'nullius init --runtime-only';
}

const SELF_DERIVE_PROJECT_ROOT_LINE = 'PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)';
const RESOLVE_NULLIUS_LINE = 'RESOLVED_NULLIUS=$(command -v nullius 2>/dev/null || true)';
/** Machine-readable launcher-protocol handshake. Protocol 2 = the trusted
 *  project root is PREPENDED before user args and the parser honors the `--`
 *  end-of-options terminator with duplicate-root rejection. A PATH-resolved
 *  nullius that cannot answer this exact banner may be an older-generation
 *  parser (root appended, last-wins) — executing it could retarget writes to
 *  another project root, so the launcher refuses it. */
export const LAUNCHER_PROTOCOL_FLAG = '--launcher-protocol';
export const LAUNCHER_PROTOCOL_BANNER = 'nullius-launcher-protocol 2';
// `-ef` compares real file identity (device+inode, following symlinks), so a PATH
// entry that is — or symlinks back to — this launcher is rejected. A plain string
// compare would miss a symlink-to-self and self-hop, corrupting --project-root.
// The third clause is the protocol handshake described above.
const PATH_PREFER_GUARD_LINE = `if [ -n "$RESOLVED_NULLIUS" ] && [ ! "$RESOLVED_NULLIUS" -ef "$0" ] && [ "$("$RESOLVED_NULLIUS" ${LAUNCHER_PROTOCOL_FLAG} 2>/dev/null || true)" = "${LAUNCHER_PROTOCOL_BANNER}" ]; then`;
// The trusted root is PREPENDED so it is parsed before any user-supplied
// end-of-options terminator; appended it would be mistaken for data after a
// `--` (and the CLI rejects a second, conflicting root outright). The exec
// uses the checked resolved path, not a second PATH lookup.
const PATH_PREFER_EXEC_LINE = 'exec "$RESOLVED_NULLIUS" --project-root "$PROJECT_ROOT" "$@"';

function launcherProtocolCandidateOnPath(launcherPath: string): string | null {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return null;
  let launcherStat: fs.Stats | null = null;
  try {
    launcherStat = fs.statSync(launcherPath);
  } catch {
    launcherStat = null;
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'nullius');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const candidateStat = fs.statSync(candidate);
      // Mirror the launcher's runtime `command -v nullius`: only a regular
      // executable file counts (a directory named `nullius` carries the
      // execute bit but is not a resolvable command).
      if (!candidateStat.isFile()) continue;
      // Mirror the launcher's runtime `-ef` self-check (device+inode, following
      // symlinks): a symlink OR hard link back to this launcher is the launcher
      // itself and cannot satisfy itself, so it is not a usable on-PATH nullius.
      if (launcherStat !== null && candidateStat.dev === launcherStat.dev && candidateStat.ino === launcherStat.ino) {
        continue;
      }
      return candidate;
    } catch {
      // not resolvable here; keep scanning PATH
    }
  }
  return null;
}

/** Mirrors the launcher's runtime handshake: a PATH candidate only counts
 *  when it answers the exact protocol banner. Spawned only on the rare
 *  baked-target-missing path, never on the common healthy one. */
function nulliusResolvableOnPath(launcherPath: string): boolean {
  const candidate = launcherProtocolCandidateOnPath(launcherPath);
  if (candidate === null) return false;
  try {
    const output = execFileSync(candidate, [LAUNCHER_PROTOCOL_FLAG], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim() === LAUNCHER_PROTOCOL_BANNER;
  } catch {
    return false;
  }
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
    /^\s*exec\s+'\/.*--project-root\s+"\$PROJECT_ROOT"\s+"\$@"\s*$/u.test(line),
  );
  return hasSelfDerivedRoot && hasSelfGuard && hasPathPreferExec && hasFallbackExec;
}

export function readProjectLocalNulliusLauncherHealth(projectRoot: string): ProjectLocalNulliusLauncherHealth {
  const relativePath = projectLocalNulliusRelativePath().split(path.sep).join('/');
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
  // The portable launcher prefers an `nullius` on PATH and only falls back to
  // the baked checkout paths. A missing baked target is therefore fatal only when
  // PATH cannot satisfy the launcher either.
  const missingPaths = checkedPaths.filter(candidate => !fs.existsSync(candidate));
  if (missingPaths.length > 0 && !nulliusResolvableOnPath(launcherPath)) {
    return {
      ...base,
      exists: true,
      executable,
      healthy: false,
      checked_paths: checkedPaths,
      missing_paths: missingPaths,
      issue_code: 'PROJECT_LOCAL_LAUNCHER_TARGET_MISSING',
      message: `Project-local fallback launcher points at a missing CLI target and no nullius is on PATH; run ${repairCommand()} from the project root to refresh it.`,
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

export function resolveProjectLocalNulliusLauncher(): ProjectLocalNulliusLauncher {
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
    'could not resolve the canonical nullius CLI entrypoint; expected packages/orchestrator/dist/cli.js or repo-local tsx + packages/orchestrator/src/cli.ts',
  );
}

export function ensureProjectLocalNulliusLauncher(projectRoot: string): {
  launcher_path: string;
  launcher_mode: 'dist' | 'tsx';
} {
  const launcher = resolveProjectLocalNulliusLauncher();
  const launcherPath = path.join(projectRoot, projectLocalNulliusRelativePath());
  fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
  const fallbackChecks = launcher.argv
    .filter(arg => path.isAbsolute(arg))
    .flatMap(arg => [
      `if [ ! -e ${shellQuote(arg)} ]; then`,
      "  printf '%s\\n' '[error] no protocol-compatible nullius on PATH and the baked CLI target is missing.' >&2",
      `  printf '%s\\n' ${shellQuote(`[error] missing: ${arg}`)} >&2`,
      `  printf '%s\\n' ${shellQuote(`[error] run on this machine: ${repairCommand()}`)} >&2`,
      '  exit 127',
      'fi',
    ]);
  const bakedExistenceGuard = launcher.argv
    .filter(arg => path.isAbsolute(arg))
    .map(arg => `[ -e ${shellQuote(arg)} ]`)
    .join(' && ');
  const script = [
    '#!/bin/sh',
    'set -eu',
    '# Nullius project-local fallback launcher.',
    '# Portable: the project root is derived from this script location, so the',
    `# project keeps working after being moved or copied. If nothing resolves, rerun: ${repairCommand()}`,
    SELF_DERIVE_PROJECT_ROOT_LINE,
    '# The baked CLI comes FIRST: it is the same generation as this launcher, so',
    '# its argument contract is exact. A PATH-resolved nullius could be an',
    '# older-generation parser whose root handling differs, so it is only used',
    '# when the baked target is gone (moved/copied project) AND it proves the',
    '# same launcher protocol via the machine-readable handshake below.',
    `if ${bakedExistenceGuard}; then`,
    `  exec ${launcher.argv.map(shellQuote).join(' ')} --project-root "$PROJECT_ROOT" "$@"`,
    'fi',
    '# Never this launcher itself: -ef compares real file identity, so a PATH',
    '# entry that is (or symlinks back to) this script is rejected — a',
    '# self-referential PATH would recurse and corrupt --project-root.',
    RESOLVE_NULLIUS_LINE,
    PATH_PREFER_GUARD_LINE,
    `  ${PATH_PREFER_EXEC_LINE}`,
    'fi',
    // Reached only when the baked target is missing (the baked branch above
    // would have exec'd otherwise) and PATH could not satisfy the handshake:
    // the per-path checks name exactly what is missing and exit 127.
    ...fallbackChecks,
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
