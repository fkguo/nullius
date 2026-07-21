import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { invalidParams, type NativeRuntimeIdentityV1 } from '@nullius/shared';

export type NativeExecutableFormat = NativeRuntimeIdentityV1['executable_format'];
export type NativeRuntimeIdentity = NativeRuntimeIdentityV1;

const BARE_RUNTIME_TOKEN = /^(?:node|python|python3(?:\.\d+)?|bash|julia|wolframscript)$/u;

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function nativeExecutableFormat(bytes: Buffer): NativeExecutableFormat | null {
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    return 'elf';
  }
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return 'pe';
  if (bytes.length >= 4) {
    const be = bytes.readUInt32BE(0);
    const le = bytes.readUInt32LE(0);
    const mach = new Set([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcafebabf]);
    if (mach.has(be) || mach.has(le)) return 'mach_o';
  }
  return null;
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function candidateRuntimePaths(token: string): string[] {
  const candidates: string[] = [];
  if (token === 'node') candidates.push(process.execPath);
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const stableDirs = process.platform === 'win32'
    ? []
    : ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin'];
  for (const dir of [...pathDirs, ...stableDirs]) candidates.push(path.join(dir, token));
  return [...new Set(candidates.map(candidate => path.resolve(candidate)))];
}

export function resolveCanonicalNativeRuntime(params: {
  projectRoot: string;
  runDir: string;
  token: string;
}): NativeRuntimeIdentity {
  if (
    !BARE_RUNTIME_TOKEN.test(params.token)
    || params.token !== path.basename(params.token)
    || params.token.includes('/')
    || params.token.includes('\\')
  ) {
    throw invalidParams('runtime must be a bare allowlisted native-runtime token.', {
      runtime_token: params.token,
      allowlisted_tokens: ['node', 'python', 'python3', 'python3.X', 'bash', 'julia', 'wolframscript'],
    });
  }
  for (const candidate of candidateRuntimePaths(params.token)) {
    if (!fs.existsSync(candidate)) continue;
    let canonicalPath: string;
    try {
      canonicalPath = fs.realpathSync.native(candidate);
    } catch {
      continue;
    }
    if (inside(candidate, params.runDir) || inside(candidate, params.projectRoot)
      || inside(canonicalPath, params.runDir) || inside(canonicalPath, params.projectRoot)) {
      continue;
    }
    const stat = fs.statSync(canonicalPath);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o111) === 0)) continue;
    const bytes = fs.readFileSync(canonicalPath);
    const executableFormat = nativeExecutableFormat(bytes);
    if (!executableFormat) continue;
    return {
      requested_token: params.token,
      canonical_path: canonicalPath,
      sha256: sha256Bytes(bytes),
      size_bytes: bytes.length,
      executable_format: executableFormat,
    };
  }
  throw invalidParams('No canonical native executable could be resolved for the requested runtime token.', {
    runtime_token: params.token,
    rejected_causes: ['missing', 'non-native wrapper/script', 'inside project/run root', 'not executable'],
  });
}

export function assertNativeRuntimeIdentityLive(params: {
  identity: NativeRuntimeIdentity;
  projectRoot: string;
  runDir: string;
}): NativeRuntimeIdentity {
  const resolved = resolveCanonicalNativeRuntime({
    projectRoot: params.projectRoot,
    runDir: params.runDir,
    token: params.identity.requested_token,
  });
  if (
    resolved.canonical_path !== params.identity.canonical_path
    || resolved.sha256 !== params.identity.sha256
    || resolved.size_bytes !== params.identity.size_bytes
    || resolved.executable_format !== params.identity.executable_format
  ) {
    throw invalidParams('Canonical runtime identity no longer matches the executed runtime bytes.', {
      recorded: params.identity,
      live: resolved,
    });
  }
  return resolved;
}

export function isNativeRuntimeIdentity(value: unknown): value is NativeRuntimeIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<NativeRuntimeIdentity>;
  return typeof identity.requested_token === 'string'
    && typeof identity.canonical_path === 'string'
    && /^[0-9a-f]{64}$/u.test(identity.sha256 ?? '')
    && Number.isInteger(identity.size_bytes) && (identity.size_bytes ?? -1) >= 0
    && (identity.executable_format === 'elf' || identity.executable_format === 'mach_o' || identity.executable_format === 'pe');
}
