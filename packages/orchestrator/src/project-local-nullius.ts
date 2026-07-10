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
// The handshake used at runtime for BOTH exec branches: `BANNER_OUT=$(cmd)`
// inside `if` requires command SUCCESS (a banner printed before a nonzero
// exit does not count), and command substitution strips trailing newlines
// before the exact string compare — answersLauncherProtocol mirrors both.
// `-ef` compares real file identity (device+inode, following symlinks), so a PATH
// entry that is — or symlinks back to — this launcher is rejected. A plain string
// compare would miss a symlink-to-self and self-hop, corrupting --project-root.
// The trailing clause is the protocol handshake described above.
const PATH_PREFER_GUARD_LINE = `if [ -n "$RESOLVED_NULLIUS" ] && [ ! "$RESOLVED_NULLIUS" -ef "$0" ] && BANNER_OUT=$("$RESOLVED_NULLIUS" ${LAUNCHER_PROTOCOL_FLAG} 2>/dev/null) && [ "$BANNER_OUT" = "${LAUNCHER_PROTOCOL_BANNER}" ]; then`;
// The trusted root is PREPENDED so it is parsed before any user-supplied
// end-of-options terminator; appended it would be mistaken for data after a
// `--` (and the CLI rejects a second, conflicting root outright). The exec
// uses the checked resolved path, not a second PATH lookup.
const PATH_PREFER_EXEC_LINE = 'exec "$RESOLVED_NULLIUS" --project-root "$PROJECT_ROOT" "$@"';

/** First `command -v`-like candidate on PATH: the first executable regular
 *  file named nullius. Returns 'self' when that FIRST candidate is the
 *  launcher itself — the runtime `command -v` also stops there, so scanning
 *  past it would claim a fallback the launcher will never use. */
function launcherProtocolCandidateOnPath(launcherPath: string): string | 'self' | null {
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
      // Mirror `command -v nullius`: only a regular executable file counts
      // (a directory named `nullius` carries the execute bit but is not a
      // resolvable command), and the FIRST such file is the answer.
      if (!candidateStat.isFile()) continue;
      if (launcherStat !== null && candidateStat.dev === launcherStat.dev && candidateStat.ino === launcherStat.ino) {
        return 'self';
      }
      return candidate;
    } catch {
      // not resolvable here; keep scanning PATH
    }
  }
  return null;
}

// Handshake results are cached per (path, mtime, size): health runs on every
// status call and must not spawn a process each time, while a rebuild of the
// target (mtime/size change) still re-verifies.
const handshakeCache = new Map<string, boolean>();

/** Mirrors the runtime handshake exactly: command success required
 *  (execFileSync throws on nonzero exit, like `BANNER_OUT=$(...)` failing in
 *  the shell guard) and trailing newlines stripped before the exact compare
 *  (what `$(...)` does) — no other whitespace tolerance. */
export function answersLauncherProtocol(argv: string[]): boolean {
  const key = argv
    .map(part => {
      try {
        const stat = fs.statSync(part);
        return `${part}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return part;
      }
    })
    .join(' | ');
  const cached = handshakeCache.get(key);
  if (cached !== undefined) return cached;
  let result = false;
  try {
    const output = execFileSync(argv[0]!, [...argv.slice(1), LAUNCHER_PROTOCOL_FLAG], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    result = output.replace(/\n+$/u, '') === LAUNCHER_PROTOCOL_BANNER;
  } catch {
    result = false;
  }
  handshakeCache.set(key, result);
  return result;
}

function nulliusResolvableOnPath(launcherPath: string): boolean {
  const candidate = launcherProtocolCandidateOnPath(launcherPath);
  if (candidate === null || candidate === 'self') return false;
  return answersLauncherProtocol([candidate]);
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

// The baked branch's protocol-gated guard, generic over the machine-specific
// absolute argv it embeds.
const BAKED_GUARD_PATTERN = /^if \[ -e '\/.+ && BANNER_OUT=\$\('\/.+ --launcher-protocol 2>\/dev\/null\) && \[ "\$BANNER_OUT" = "nullius-launcher-protocol 2" \]; then$/u;
const BAKED_EXEC_PATTERN = /^\s*exec\s+'\/.*--project-root\s+"\$PROJECT_ROOT"\s+"\$@"\s*$/u;

function hasProjectLocalLauncherShape(script: string): boolean {
  const lines = script.split(/\r?\n/u);
  const hasSelfDerivedRoot = lines.includes(SELF_DERIVE_PROJECT_ROOT_LINE);
  // Require the self-identity guard: an older unguarded PATH-prefer launcher would
  // self-recurse, so it must be reported unparseable (→ refresh) rather than healthy.
  const hasSelfGuard = lines.some(line => line.trim() === PATH_PREFER_GUARD_LINE);
  const pathPreferExecAt = lines.findIndex(line => line.trim() === PATH_PREFER_EXEC_LINE);
  const bakedGuardAt = lines.findIndex(line => BAKED_GUARD_PATTERN.test(line.trim()));
  const bakedExecAt = lines.findIndex(line => BAKED_EXEC_PATTERN.test(line));
  // Baked-first ordering is part of the shape: a PATH-first script is the
  // older generation whose skew this design exists to prevent.
  return hasSelfDerivedRoot
    && hasSelfGuard
    && pathPreferExecAt !== -1
    && bakedGuardAt !== -1
    && bakedExecAt !== -1
    && bakedExecAt < pathPreferExecAt;
}

/** The baked exec line's quoted absolute argv, for the health handshake. */
function extractBakedExecArgv(script: string): string[] {
  for (const line of script.split(/\r?\n/u)) {
    if (!BAKED_EXEC_PATTERN.test(line)) continue;
    const argv: string[] = [];
    for (const match of line.matchAll(/'((?:[^']|'"'"')*)'/gu)) {
      const value = unquoteShellSingleQuoted(match[1] ?? '');
      if (path.isAbsolute(value)) argv.push(value);
    }
    return argv;
  }
  return [];
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
  // Health mirrors the launcher's runtime decision: the baked CLI counts only
  // when its files exist AND it answers the protocol handshake (a rebuilt
  // checkout may be an older-generation parser); otherwise a PATH candidate
  // counts only under the same handshake. Handshake results are cached per
  // (path, mtime, size), so the common healthy path spawns nothing repeatedly.
  const missingPaths = checkedPaths.filter(candidate => !fs.existsSync(candidate));
  const bakedArgv = extractBakedExecArgv(script);
  const bakedUsable = missingPaths.length === 0 && bakedArgv.length > 0 && answersLauncherProtocol(bakedArgv);
  if (!bakedUsable && !nulliusResolvableOnPath(launcherPath)) {
    if (missingPaths.length > 0) {
      return {
        ...base,
        exists: true,
        executable,
        healthy: false,
        checked_paths: checkedPaths,
        missing_paths: missingPaths,
        issue_code: 'PROJECT_LOCAL_LAUNCHER_TARGET_MISSING',
        message: `Project-local fallback launcher points at a missing CLI target and no protocol-compatible nullius is on PATH; run ${repairCommand()} from the project root to refresh it.`,
      };
    }
    return {
      ...base,
      exists: true,
      executable,
      healthy: false,
      checked_paths: checkedPaths,
      missing_paths: missingPaths,
      issue_code: 'PROJECT_LOCAL_LAUNCHER_TARGET_INCOMPATIBLE',
      message: `Project-local fallback launcher's baked CLI does not answer the launcher-protocol handshake (older generation or broken build) and no protocol-compatible nullius is on PATH; rebuild the checkout or run ${repairCommand()} from the project root.`,
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
  const bakedArgvQuoted = launcher.argv.map(shellQuote).join(' ');
  const bakedExistenceGuard = launcher.argv
    .filter(arg => path.isAbsolute(arg))
    .map(arg => `[ -e ${shellQuote(arg)} ]`)
    .join(' && ');
  // Existence is NOT generation: the baked path is a mutable checkout that a
  // rebuild can flip to an older parser, so the baked branch runs the same
  // in-band handshake as the PATH branch before it is trusted with the root.
  const bakedGuard = `if ${bakedExistenceGuard} && BANNER_OUT=$(${bakedArgvQuoted} ${LAUNCHER_PROTOCOL_FLAG} 2>/dev/null) && [ "$BANNER_OUT" = "${LAUNCHER_PROTOCOL_BANNER}" ]; then`;
  const script = [
    '#!/bin/sh',
    'set -eu',
    '# Nullius project-local fallback launcher.',
    '# Portable: the project root is derived from this script location, so the',
    `# project keeps working after being moved or copied. If nothing resolves, rerun: ${repairCommand()}`,
    SELF_DERIVE_PROJECT_ROOT_LINE,
    '# The baked CLI comes FIRST, gated by the same machine-readable protocol',
    '# handshake as the PATH branch: a rebuilt checkout or an older-generation',
    '# parser whose root handling differs must never be trusted with the root.',
    bakedGuard,
    `  exec ${bakedArgvQuoted} --project-root "$PROJECT_ROOT" "$@"`,
    'fi',
    '# Never this launcher itself: -ef compares real file identity, so a PATH',
    '# entry that is (or symlinks back to) this script is rejected — a',
    '# self-referential PATH would recurse and corrupt --project-root.',
    RESOLVE_NULLIUS_LINE,
    PATH_PREFER_GUARD_LINE,
    `  ${PATH_PREFER_EXEC_LINE}`,
    'fi',
    // Reached when neither branch proved the protocol: the per-path checks
    // name missing baked files, then the generic refusal names the handshake.
    ...fallbackChecks,
    "printf '%s\\n' '[error] no nullius answered the launcher-protocol handshake (baked target or PATH candidate may be an older generation).' >&2",
    `printf '%s\\n' ${shellQuote(`[error] run on this machine: ${repairCommand()}`)} >&2`,
    'exit 127',
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
