import { execFileSync, spawnSync } from 'node:child_process';
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

export type ProjectLocalNulliusStatusCommand =
  | '.nullius/bin/nullius status --json'
  | '.nullius/bin/nullius.cmd status --json';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function cmdQuote(value: string): string {
  // Batch literals are parsed before execution even inside double quotes.
  // Percent is representable by doubling it; line breaks, NUL, and a literal
  // quote are not safely representable as one argv token in a generated .cmd.
  if (/["\0\r\n]/u.test(value)) {
    throw new Error('cannot encode a launcher path as a Windows command literal');
  }
  return `"${value.replace(/%/g, '%%')}"`;
}

function packageRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '..');
}

export function projectLocalNulliusRelativePath(): string {
  return path.join('.nullius', 'bin', 'nullius');
}

export function projectLocalNulliusCmdRelativePath(): string {
  return path.join('.nullius', 'bin', 'nullius.cmd');
}

export function projectLocalNulliusPreferredRelativePath(): string {
  return process.platform === 'win32'
    ? projectLocalNulliusCmdRelativePath()
    : projectLocalNulliusRelativePath();
}

export function projectLocalNulliusStatusCommand(): ProjectLocalNulliusStatusCommand {
  return process.platform === 'win32'
    ? '.nullius/bin/nullius.cmd status --json'
    : '.nullius/bin/nullius status --json';
}

function repairCommand(): string {
  return 'nullius init --runtime-only';
}

const SELF_DERIVE_PROJECT_ROOT_LINE = 'PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)';
// Explicit PATH scan instead of `command -v`: shells disagree about what
// command -v returns for empty PATH components (absolute cwd path on some,
// bare or relative name on others) and about function shadowing — an
// explicit loop over absolute components makes runtime and health follow one
// spec: the FIRST executable regular file named nullius in an
// absolute-directory PATH component; cwd-relative resolution is never
// trusted with the project root.
const RESOLVE_NULLIUS_BLOCK = [
  'RESOLVED_NULLIUS=',
  // set -f: an unquoted $PATH word-split would otherwise GLOB-expand
  // wildcard components; components must stay literal strings on both sides.
  '_nullius_ifs=$IFS; IFS=:; set -f',
  'for _nullius_dir in $PATH; do',
  '  case "$_nullius_dir" in /*) ;; *) continue;; esac',
  '  if [ -f "$_nullius_dir/nullius" ] && [ -x "$_nullius_dir/nullius" ]; then',
  '    RESOLVED_NULLIUS="$_nullius_dir/nullius"',
  '    break',
  '  fi',
  'done',
  'IFS=$_nullius_ifs; set +f',
] as const;
/** Machine-readable launcher-protocol handshake. Protocol 2 = the trusted
 *  project root is PREPENDED before user args and the parser honors the `--`
 *  end-of-options terminator with duplicate-root rejection. A PATH-resolved
 *  nullius that cannot answer this exact banner may be an older-generation
 *  parser (root appended, last-wins) — executing it could retarget writes to
 *  another project root, so the launcher refuses it. */
export const LAUNCHER_PROTOCOL_FLAG = '--launcher-protocol';
export const LAUNCHER_PROTOCOL_BANNER = 'nullius-launcher-protocol 2';
/** Passed WITH the real command by both exec branches, so the invocation
 *  that handles the trusted root proves its own parser generation in-band
 *  (cli-args.ts consumes it; an older parser fails on the unknown token).
 *  The separate --launcher-protocol probe above only selects the branch;
 *  correctness never depends on the probe-then-exec window. */
export const LAUNCHER_GENERATION_TOKEN = '--launcher-generation=2';
// The handshake used at runtime for BOTH exec branches: `BANNER_OUT=$(cmd)`
// inside `if` requires command SUCCESS (a banner printed before a nonzero
// exit does not count), and command substitution strips trailing newlines
// before the exact string compare — answersLauncherProtocol mirrors both.
// `-ef` compares real file identity (device+inode, following symlinks), so a PATH
// entry that is — or symlinks back to — this launcher is rejected. A plain string
// compare would miss a symlink-to-self and self-hop, corrupting --project-root.
// The trailing clause is the protocol handshake described above.
const PATH_PREFER_GUARD_LINE = `if [ -n "$RESOLVED_NULLIUS" ] && [ "\${RESOLVED_NULLIUS#/}" != "$RESOLVED_NULLIUS" ] && [ -f "$RESOLVED_NULLIUS" ] && [ ! "$RESOLVED_NULLIUS" -ef "$0" ] && BANNER_OUT=$("$RESOLVED_NULLIUS" ${LAUNCHER_GENERATION_TOKEN} ${LAUNCHER_PROTOCOL_FLAG} 2>/dev/null) && [ "$BANNER_OUT" = "${LAUNCHER_PROTOCOL_BANNER}" ]; then`;
// The trusted root is PREPENDED so it is parsed before any user-supplied
// end-of-options terminator; appended it would be mistaken for data after a
// `--` (and the CLI rejects a second, conflicting root outright). The exec
// uses the checked resolved path, not a second PATH lookup.
const PATH_PREFER_EXEC_LINE = `exec "$RESOLVED_NULLIUS" ${LAUNCHER_GENERATION_TOKEN} --project-root "$PROJECT_ROOT" "$@"`;

function windowsPathKey(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/u, '').toLowerCase();
}

function sameFileIdentity(left: fs.Stats | null, right: fs.Stats): boolean {
  return left !== null && left.dev === right.dev && left.ino === right.ino;
}

function windowsNulliusCandidateNames(): string[] {
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(extension => extension.trim())
    .filter(Boolean)
    .map(extension => extension.startsWith('.') ? extension : `.${extension}`);
  return [...new Set(['nullius', ...extensions.map(extension => `nullius${extension}`)])];
}

/** Locate the same PATH fallback the generated launcher can reach. POSIX
 *  mirrors `command -v` and returns `self` when its first candidate is this
 *  launcher. Windows mirrors the explicit PATHEXT scan and skips both
 *  project-local companion names before continuing. */
function launcherProtocolCandidateOnPath(launcherPath: string): string | 'self' | null {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return null;
  let launcherStat: fs.Stats | null = null;
  try {
    launcherStat = fs.statSync(launcherPath);
  } catch {
    launcherStat = null;
  }
  if (process.platform === 'win32') {
    const launcherKey = windowsPathKey(launcherPath);
    const shellSiblingKey = windowsPathKey(
      path.extname(launcherPath).toLowerCase() === '.cmd'
        ? launcherPath.slice(0, -'.cmd'.length)
        : launcherPath,
    );
    for (const rawDir of pathEnv.split(path.delimiter)) {
      const dir = rawDir.replace(/^"|"$/gu, '');
      if (!path.isAbsolute(dir)) continue;
      for (const candidateName of windowsNulliusCandidateNames()) {
        // Keep the PATH component literal. Normalizing `missing\\..\\bin`
        // would make health accept a candidate that `where.exe $PATH:nullius`
        // cannot reach because the missing intermediate component is real.
        const candidate = `${dir}${path.sep}${candidateName}`;
        try {
          const candidateStat = fs.statSync(candidate);
          if (!candidateStat.isFile()) continue;
          const candidateKey = windowsPathKey(candidate);
          // `where.exe` reports the project-local .cmd and its extensionless
          // POSIX sibling when that bin directory is on PATH. Neither may be
          // selected, and alternate links to the .cmd are rejected as well.
          if (
            // The runtime .cmd rejects percent-bearing PATH candidates before
            // its fixed-argument CALL probe: CALL would reinterpret `%NAME%`
            // during its mandatory second parse. Keep health/runtime aligned.
            candidate.includes('%')
            ||
            candidateKey === launcherKey
            || candidateKey === shellSiblingKey
            || sameFileIdentity(launcherStat, candidateStat)
          ) {
            continue;
          }
          return candidate;
        } catch {
          // not resolvable here; keep scanning PATH/PATHEXT
        }
      }
    }
    return null;
  }

  for (const dir of pathEnv.split(path.delimiter)) {
    // Shared spec with the launcher's explicit resolver loop: only absolute
    // PATH components are scanned, and the FIRST executable regular file
    // wins. Cwd-relative resolution is never trusted with the project root.
    if (!path.isAbsolute(dir)) continue;
    // Literal concatenation, NOT path.join: lexical normalization would
    // resolve "missing/../bin" to "bin" even when "missing" does not exist,
    // while the shell's [ -f "$dir/nullius" ] lets the OS resolve it (and
    // fail). Both sides must hand the literal string to the OS.
    const candidate = `${dir}${path.sep}nullius`;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const candidateStat = fs.statSync(candidate);
      // Mirror `command -v nullius`: only a regular executable file counts
      // (a directory named `nullius` carries the execute bit but is not a
      // resolvable command), and the FIRST such file is the answer.
      if (!candidateStat.isFile()) continue;
      if (sameFileIdentity(launcherStat, candidateStat)) {
        return 'self';
      }
      return candidate;
    } catch {
      // not resolvable here; keep scanning PATH
    }
  }
  return null;
}

// Handshake results are cached per (path, mtime, size) with a bounded TTL:
// health runs on every status call and must not spawn a process each time,
// a rebuild of the target (mtime/size change) re-verifies immediately, and a
// stable WRAPPER whose underlying CLI changed (fingerprint blind spot)
// re-verifies within the TTL instead of never.
const HANDSHAKE_CACHE_TTL_MS = 30_000;
const handshakeCache = new Map<string, { result: boolean; expiresAt: number }>();

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
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.result;
  let result = false;
  try {
    const protocolArgs = [...argv.slice(1), LAUNCHER_GENERATION_TOKEN, LAUNCHER_PROTOCOL_FLAG];
    const isCmdShim = process.platform === 'win32' && /\.(?:bat|cmd)$/iu.test(argv[0]!);
    if (isCmdShim && [argv[0]!, ...protocolArgs].some(arg => /["%\0\r\n]/u.test(arg))) {
      throw new Error('unsafe cmd launcher protocol argument');
    }
    const command = isCmdShim ? (process.env.ComSpec ?? 'cmd.exe') : argv[0]!;
    const commandArgs = isCmdShim
      // Use cmd.exe's canonical double-outer-quote form. windowsVerbatimArguments
      // is required so Node does not backslash-escape those shell quotes;
      // without it, cmd also splits the unquoted generation name=value token.
      ? [
          '/d',
          '/v:off',
          '/s',
          '/c',
          `""${argv[0]!}" ${protocolArgs.map(arg => `"${arg}"`).join(' ')}"`,
        ]
      : protocolArgs;
    const output = isCmdShim
      ? (() => {
          const probe = spawnSync(command, commandArgs, {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsVerbatimArguments: true,
          });
          if (probe.error || probe.status !== 0) throw probe.error ?? new Error('cmd launcher probe failed');
          return probe.stdout;
        })()
      : execFileSync(command, commandArgs, {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
    result = output.replace(/[\r\n]+$/u, '') === LAUNCHER_PROTOCOL_BANNER;
  } catch {
    result = false;
  }
  handshakeCache.set(key, { result, expiresAt: Date.now() + HANDSHAKE_CACHE_TTL_MS });
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
const BAKED_GUARD_PATTERN = /^if \[ -e '\/.+ && BANNER_OUT=\$\('\/.+ --launcher-generation=2 --launcher-protocol 2>\/dev\/null\) && \[ "\$BANNER_OUT" = "nullius-launcher-protocol 2" \]; then$/u;
const BAKED_EXEC_PATTERN = /^\s*exec\s+'\/.*--launcher-generation=2\s+--project-root\s+"\$PROJECT_ROOT"\s+"\$@"\s*$/u;

const CMD_SELF_DERIVE_PROJECT_ROOT_LINE = 'for %%I in ("%~dp0..\\..") do set "PROJECT_ROOT=%%~fI"';
const CMD_BAKED_ARGV_PREFIX = 'rem nullius-baked-argv-base64 ';
const CMD_TRY_PATH_LABEL = ':nullius_try_path';
const CMD_FAIL_LABEL = ':nullius_fail';
const CMD_PATH_SCAN_LINE = 'for %%D in ("%PATH:;=" "%") do (';
// A .cmd invoked without CALL becomes a tail-dispatch, which is exactly the
// launcher contract. Avoiding CALL is security-relevant: CALL expands `%*`
// a second time, so percent-bearing user arguments could be reinterpreted.
const CMD_PATH_EXEC_LINE = `"%RESOLVED_NULLIUS%" ${LAUNCHER_GENERATION_TOKEN} --project-root "%PROJECT_ROOT%" %*`;
const CMD_MAKE_PROBE_LABEL = ':nullius_make_probe';
const CMD_MAKE_PROBE_RETRY_LABEL = ':nullius_make_probe_retry';
const CMD_READ_PROBE_LABEL = ':nullius_read_probe';
const CMD_CLEANUP_PROBE_LABEL = ':nullius_cleanup_probe';
const CMD_SCAN_PATH_DIR_LABEL = ':nullius_scan_path_dir';
const CMD_CONSIDER_CANDIDATE_LABEL = ':nullius_consider_path_candidate';

function hasProjectLocalLauncherShape(script: string): boolean {
  const lines = script.split(/\r?\n/u);
  const hasSelfDerivedRoot = lines.includes(SELF_DERIVE_PROJECT_ROOT_LINE);
  const resolverStart = lines.indexOf(RESOLVE_NULLIUS_BLOCK[0]!);
  const hasExplicitResolver = resolverStart !== -1
    && RESOLVE_NULLIUS_BLOCK.every((blockLine, offset) => lines[resolverStart + offset] === blockLine);
  const resolverEnd = resolverStart + RESOLVE_NULLIUS_BLOCK.length;
  // Require the self-identity guard: an older unguarded PATH-prefer launcher would
  // self-recurse, so it must be reported unparseable (→ refresh) rather than healthy.
  const pathGuardAt = lines.findIndex(line => line.trim() === PATH_PREFER_GUARD_LINE);
  const pathPreferExecAt = lines.findIndex(line => line.trim() === PATH_PREFER_EXEC_LINE);
  const bakedGuardAt = lines.findIndex(line => BAKED_GUARD_PATTERN.test(line.trim()));
  const bakedExecAt = lines.findIndex(line => BAKED_EXEC_PATTERN.test(line));
  // The complete ordered branch structure is the shape: each exec is the
  // line directly under ITS OWN guard, and the baked branch precedes the
  // PATH branch — a guard floating elsewhere (e.g. below an unconditional
  // exec) is the skew this design exists to prevent.
  return hasSelfDerivedRoot
    && hasExplicitResolver
    && bakedGuardAt !== -1
    && bakedExecAt === bakedGuardAt + 1
    && pathGuardAt !== -1
    && pathPreferExecAt === pathGuardAt + 1
    && bakedGuardAt < pathGuardAt
    // The PATH guard must sit DIRECTLY under the resolver block: a relocated
    // block (e.g. below the guard) would leave RESOLVED_NULLIUS unset at the
    // guard under `set -u`, aborting dispatch while health still resolves.
    && pathGuardAt === resolverEnd;
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

function encodeCmdBakedArgv(argv: string[]): string {
  return Buffer.from(JSON.stringify(argv), 'utf-8').toString('base64');
}

function extractCmdBakedArgv(script: string): string[] {
  const metadataLine = script
    .split(/\r?\n/u)
    .find(line => line.startsWith(CMD_BAKED_ARGV_PREFIX));
  if (!metadataLine) return [];
  try {
    const decoded = Buffer.from(metadataLine.slice(CMD_BAKED_ARGV_PREFIX.length), 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return [];
    if (!parsed.every(value => typeof value === 'string' && path.isAbsolute(value))) return [];
    return parsed;
  } catch {
    return [];
  }
}

function hasProjectLocalCmdLauncherShape(script: string): boolean {
  const bakedArgv = extractCmdBakedArgv(script);
  if (bakedArgv.length === 0) return false;
  try {
    // The metadata is the only machine-specific input. Reconstructing the
    // canonical CRLF launcher from it and requiring byte equality proves the
    // protocol status/banner guards, branch ordering, and percent-safety
    // checks are all still present. Sparse landmark checks would let a
    // deleted guard look healthy while runtime dispatched unconditionally.
    return script === renderProjectLocalCmdLauncher({ argv: bakedArgv });
  } catch {
    return false;
  }
}

export function readProjectLocalNulliusLauncherHealth(projectRoot: string): ProjectLocalNulliusLauncherHealth {
  const isWindowsLauncher = process.platform === 'win32';
  const relativePath = projectLocalNulliusPreferredRelativePath().split(path.sep).join('/');
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
  const executable = isWindowsLauncher || (fs.statSync(launcherPath).mode & 0o111) !== 0;
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
  const bakedArgv = isWindowsLauncher
    ? extractCmdBakedArgv(script)
    : extractBakedExecArgv(script);
  const checkedPaths = [...new Set(
    isWindowsLauncher
      ? bakedArgv.filter(candidate => path.isAbsolute(candidate))
      : extractExecQuotedPaths(script),
  )];
  const recognizedShape = isWindowsLauncher
    ? hasProjectLocalCmdLauncherShape(script)
    : hasProjectLocalLauncherShape(script);
  if (!recognizedShape) {
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

function renderProjectLocalCmdLauncher(launcher: Pick<ProjectLocalNulliusLauncher, 'argv'>): string {
  const bakedCommand = launcher.argv.map(cmdQuote).join(' ');
  const fallbackChecks = launcher.argv
    .filter(arg => path.isAbsolute(arg))
    .flatMap(arg => [
      `if not exist ${cmdQuote(arg)} echo [error] missing: ${cmdQuote(arg)} 1>&2`,
    ]);
  const bakedProbeLine = `${bakedCommand} ${LAUNCHER_GENERATION_TOKEN} ${LAUNCHER_PROTOCOL_FLAG} > "%NULLIUS_PROBE_FILE%" 2>nul`;
  const pathProbeLine = `call "%RESOLVED_NULLIUS%" "${LAUNCHER_GENERATION_TOKEN}" "${LAUNCHER_PROTOCOL_FLAG}" > "%NULLIUS_PROBE_FILE%" 2>nul`;

  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'rem Nullius project-local fallback launcher (native Windows companion).',
    'rem The trusted project root is always prepended before user arguments.',
    CMD_SELF_DERIVE_PROJECT_ROOT_LINE,
    `${CMD_BAKED_ARGV_PREFIX}${encodeCmdBakedArgv(launcher.argv)}`,
    'rem The baked CLI stays first and must answer the exact protocol-2 probe.',
    `call ${CMD_MAKE_PROBE_LABEL}`,
    `if errorlevel 1 goto ${CMD_TRY_PATH_LABEL.slice(1)}`,
    bakedProbeLine,
    'set "NULLIUS_PROBE_STATUS=%ERRORLEVEL%"',
    `call ${CMD_READ_PROBE_LABEL}`,
    `if not "%NULLIUS_PROBE_STATUS%"=="0" goto ${CMD_TRY_PATH_LABEL.slice(1)}`,
    `if defined NULLIUS_EXTRA goto ${CMD_TRY_PATH_LABEL.slice(1)}`,
    `if not "%NULLIUS_BANNER%"=="${LAUNCHER_PROTOCOL_BANNER}" goto ${CMD_TRY_PATH_LABEL.slice(1)}`,
    `${bakedCommand} ${LAUNCHER_GENERATION_TOKEN} --project-root "%PROJECT_ROOT%" %*`,
    'exit /b %ERRORLEVEL%',
    CMD_TRY_PATH_LABEL,
    'rem Scan absolute PATH components only; skip this .cmd and its POSIX sibling.',
    'set "RESOLVED_NULLIUS="',
    'if not defined PATHEXT set "PATHEXT=.COM;.EXE;.BAT;.CMD"',
    CMD_PATH_SCAN_LINE,
    '  set "NULLIUS_PATH_DIR=%%~D"',
    `  call ${CMD_SCAN_PATH_DIR_LABEL}`,
    ')',
    `if not defined RESOLVED_NULLIUS goto ${CMD_FAIL_LABEL.slice(1)}`,
    `call ${CMD_MAKE_PROBE_LABEL}`,
    `if errorlevel 1 goto ${CMD_FAIL_LABEL.slice(1)}`,
    pathProbeLine,
    'set "NULLIUS_PROBE_STATUS=%ERRORLEVEL%"',
    `call ${CMD_READ_PROBE_LABEL}`,
    `if not "%NULLIUS_PROBE_STATUS%"=="0" goto ${CMD_FAIL_LABEL.slice(1)}`,
    `if defined NULLIUS_EXTRA goto ${CMD_FAIL_LABEL.slice(1)}`,
    `if not "%NULLIUS_BANNER%"=="${LAUNCHER_PROTOCOL_BANNER}" goto ${CMD_FAIL_LABEL.slice(1)}`,
    CMD_PATH_EXEC_LINE,
    'exit /b %ERRORLEVEL%',
    CMD_FAIL_LABEL,
    ...fallbackChecks,
    'echo [error] no nullius answered the launcher-protocol handshake ^(baked target or PATH candidate may be an older generation^). 1>&2',
    `echo [error] run on this machine: ${repairCommand()} 1>&2`,
    'exit /b 127',
    CMD_READ_PROBE_LABEL,
    'set "NULLIUS_BANNER="',
    'set "NULLIUS_EXTRA="',
    `if not exist "%NULLIUS_PROBE_FILE%" goto ${CMD_CLEANUP_PROBE_LABEL.slice(1)}`,
    'set /p "NULLIUS_BANNER="<"%NULLIUS_PROBE_FILE%"',
    // Prefix every non-empty line before FOR /F reads it. The numeric prefix
    // prevents a `;extra` line from being treated as a FOR /F comment, while
    // /R "." intentionally ignores trailing blank lines just like the health
    // probe's CR/LF trimming. Whitespace-only lines still match and fail.
    'for /f "usebackq skip=1 delims=" %%L in (`%SystemRoot%\\System32\\findstr.exe /N /R "." "%NULLIUS_PROBE_FILE%"`) do set "NULLIUS_EXTRA=1"',
    CMD_CLEANUP_PROBE_LABEL,
    'del /q "%NULLIUS_PROBE_FILE%" >nul 2>nul',
    'rd "%NULLIUS_PROBE_DIR%" >nul 2>nul',
    'set "NULLIUS_PROBE_FILE="',
    'set "NULLIUS_PROBE_DIR="',
    'exit /b 0',
    CMD_MAKE_PROBE_LABEL,
    'set "NULLIUS_PROBE_ATTEMPTS=0"',
    CMD_MAKE_PROBE_RETRY_LABEL,
    'set /a NULLIUS_PROBE_ATTEMPTS+=1 >nul',
    'if %NULLIUS_PROBE_ATTEMPTS% GTR 32 exit /b 1',
    'set "NULLIUS_PROBE_DIR=%TEMP%\\nullius-launcher-probe-%RANDOM%-%RANDOM%-%NULLIUS_PROBE_ATTEMPTS%"',
    'mkdir "%NULLIUS_PROBE_DIR%" >nul 2>nul',
    `if errorlevel 1 goto ${CMD_MAKE_PROBE_RETRY_LABEL.slice(1)}`,
    'set "NULLIUS_PROBE_FILE=%NULLIUS_PROBE_DIR%\\output.txt"',
    'exit /b 0',
    CMD_SCAN_PATH_DIR_LABEL,
    'if defined RESOLVED_NULLIUS exit /b 0',
    'if not defined NULLIUS_PATH_DIR exit /b 0',
    'if "%NULLIUS_PATH_DIR:~1,2%"==":\\" goto nullius_scan_absolute_path_dir',
    'if "%NULLIUS_PATH_DIR:~1,2%"==":/" goto nullius_scan_absolute_path_dir',
    'if "%NULLIUS_PATH_DIR:~0,2%"=="\\\\" goto nullius_scan_absolute_path_dir',
    'exit /b 0',
    ':nullius_scan_absolute_path_dir',
    'set "NULLIUS_CANDIDATE=%NULLIUS_PATH_DIR%\\nullius"',
    `call ${CMD_CONSIDER_CANDIDATE_LABEL}`,
    'for %%E in (%PATHEXT:;= %) do (',
    '  set "NULLIUS_CANDIDATE=%NULLIUS_PATH_DIR%\\nullius%%E"',
    `  call ${CMD_CONSIDER_CANDIDATE_LABEL}`,
    ')',
    'exit /b 0',
    CMD_CONSIDER_CANDIDATE_LABEL,
    'if defined RESOLVED_NULLIUS exit /b 0',
    'if not exist "%NULLIUS_CANDIDATE%" exit /b 0',
    'if exist "%NULLIUS_CANDIDATE%\\NUL" exit /b 0',
    'for %%N in ("%NULLIUS_CANDIDATE%") do set "NULLIUS_CANDIDATE=%%~fN"',
    'if /I "%NULLIUS_CANDIDATE%"=="%~f0" exit /b 0',
    'if /I "%NULLIUS_CANDIDATE%"=="%~dpn0" exit /b 0',
    'set NULLIUS_CANDIDATE | %SystemRoot%\\System32\\findstr.exe /L /C:"%%" >nul',
    'if not errorlevel 1 exit /b 0',
    'set "RESOLVED_NULLIUS=%NULLIUS_CANDIDATE%"',
    'exit /b 0',
    '',
  ].join('\r\n');
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
  const bakedGuard = `if ${bakedExistenceGuard} && BANNER_OUT=$(${bakedArgvQuoted} ${LAUNCHER_GENERATION_TOKEN} ${LAUNCHER_PROTOCOL_FLAG} 2>/dev/null) && [ "$BANNER_OUT" = "${LAUNCHER_PROTOCOL_BANNER}" ]; then`;
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
    `  exec ${bakedArgvQuoted} ${LAUNCHER_GENERATION_TOKEN} --project-root "$PROJECT_ROOT" "$@"`,
    'fi',
    '# Never this launcher itself: -ef compares real file identity, so a PATH',
    '# entry that is (or symlinks back to) this script is rejected — a',
    '# self-referential PATH would recurse and corrupt --project-root.',
    ...RESOLVE_NULLIUS_BLOCK,
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
  let preferredLauncherPath = launcherPath;
  if (process.platform === 'win32') {
    const cmdLauncherPath = path.join(projectRoot, projectLocalNulliusCmdRelativePath());
    writeBytesAtomicDurable(cmdLauncherPath, renderProjectLocalCmdLauncher(launcher));
    preferredLauncherPath = cmdLauncherPath;
  }
  return {
    launcher_path: preferredLauncherPath,
    launcher_mode: launcher.mode,
  };
}
