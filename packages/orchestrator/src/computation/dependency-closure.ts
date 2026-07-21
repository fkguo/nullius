import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import type { ComputationManifestV1 } from '@nullius/shared';
import { invalidParams } from '@nullius/shared';

import { assertNoSymlinkComponents, resolveWithinRoot, sanitizeRelativePath } from './path-safety.js';
import type { ExternalDependencySnapshotEntry, WorkspaceFileSnapshotEntry } from './types.js';
import type { NativeRuntimeIdentity } from './runtime-identity.js';
import type { ProcessEnvironmentV1 } from './types.js';

const FIXED_ENVIRONMENT_KEYS = new Set([
  'LANG',
  'LC_ALL',
  'PATH',
  'PYTHONDONTWRITEBYTECODE',
  'PYTHONNOUSERSITE',
  'TZ',
]);

const COMMON_DECLARED_ENVIRONMENT_KEYS = [
  'BLIS_NUM_THREADS',
  'MKL_NUM_THREADS',
  'NUMEXPR_NUM_THREADS',
  'OMP_NUM_THREADS',
  'OPENBLAS_NUM_THREADS',
  'VECLIB_MAXIMUM_THREADS',
] as const;

function declaredEnvironmentAllowlist(runtime: NativeRuntimeIdentity): Set<string> {
  const token = runtime.requested_token;
  const runtimeKeys = token === 'node'
    ? ['NODE_ENV', 'UV_THREADPOOL_SIZE']
    : /^(?:python|python3(?:\.\d+)?)$/u.test(token)
      ? ['PYTHONHASHSEED']
      : token === 'julia'
        ? ['JULIA_CPU_THREADS', 'JULIA_NUM_THREADS']
        : [];
  return new Set([...COMMON_DECLARED_ENVIRONMENT_KEYS, ...runtimeKeys]);
}

export function buildProductionEnvironment(
  runtime: NativeRuntimeIdentity,
  declared: Record<string, string> = {},
): ProcessEnvironmentV1 {
  const allowlist = declaredEnvironmentAllowlist(runtime);
  for (const key of Object.keys(declared)) {
    if (FIXED_ENVIRONMENT_KEYS.has(key)) {
      throw invalidParams('Production env may not override Nullius fixed safety variables.', { env_key: key });
    }
    if (!allowlist.has(key)) {
      throw invalidParams('Production env key is not allowlisted for the selected runtime.', {
        env_key: key,
        runtime_token: runtime.requested_token,
        allowlisted_keys: [...allowlist].sort(),
      });
    }
  }
  const variables: Record<string, string> = {
    LANG: 'C',
    LC_ALL: 'C',
    PATH: [path.dirname(runtime.canonical_path), '/usr/bin', '/bin'].filter((v, i, a) => a.indexOf(v) === i).join(path.delimiter),
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    TZ: 'UTC',
    ...Object.fromEntries(Object.entries(declared).sort(([a], [b]) => a.localeCompare(b))),
  };
  const canonical = Object.entries(variables).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}\n`).join('');
  return {
    policy: 'nullius_production_allowlist_v1',
    variables,
    sha256: createHash('sha256').update(canonical).digest('hex'),
  };
}

type ExtendedDependencies = ComputationManifestV1['dependencies'] & {
  external_dependency_refs?: Array<{ path: string; sha256: string; size_bytes?: number }>;
  lock_files?: string[];
};

function declaredDependencyNames(dependencies: ExtendedDependencies): string[] {
  const fields = [
    dependencies.mathematica_packages ?? [],
    dependencies.julia_packages ?? [],
    dependencies.python_packages ?? [],
    dependencies.external_libraries ?? [],
  ];
  return fields.flat().map((declaration) => {
    const match = String(declaration).match(/[A-Za-z0-9_.+-]+/u);
    if (!match) throw invalidParams('Declared dependency has no mechanically matchable name.', { declaration });
    return match[0]!.toLowerCase();
  });
}

export function assertDeclaredDependencyClosure(params: {
  externalRefs: ExternalDependencySnapshotEntry[];
  manifest: ComputationManifestV1;
  workspaceDir: string;
  workspaceRefs: WorkspaceFileSnapshotEntry[];
}): void {
  const dependencies = params.manifest.dependencies as ExtendedDependencies;
  const refByPath = new Map(params.workspaceRefs.map(ref => [ref.relative_path, ref] as const));
  const lockFiles = dependencies.lock_files ?? [];
  const declaredNames = declaredDependencyNames(dependencies);
  if (declaredNames.length > 0 && lockFiles.length === 0) {
    throw invalidParams('Declared package or library dependencies require workspace-contained lock_files.', {
      declared_dependencies: declaredNames,
    });
  }
  const lockText: string[] = [];
  for (const [index, lockFile] of lockFiles.entries()) {
    if (path.isAbsolute(lockFile) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(lockFile)) {
      throw invalidParams('lock_files must be workspace-relative files.', { index, lock_file: lockFile });
    }
    const safe = sanitizeRelativePath(lockFile, `dependencies.lock_files[${index}]`);
    const filePath = resolveWithinRoot(params.workspaceDir, safe, `dependencies.lock_files[${index}]`);
    assertNoSymlinkComponents(params.workspaceDir, filePath, `dependencies.lock_files[${index}]`);
    if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
      throw invalidParams('Declared dependency lock file is missing.', { lock_file: lockFile });
    }
    const relative = path.relative(params.workspaceDir, filePath).split(path.sep).join('/');
    if (!refByPath.has(relative)) {
      throw invalidParams('Declared dependency lock file is absent from the adjacent workspace snapshot.', {
        lock_file: lockFile,
      });
    }
    lockText.push(fs.readFileSync(filePath, 'utf-8').toLowerCase());
  }
  const joinedLocks = lockText.join('\n');
  for (const name of declaredNames) {
    if (!joinedLocks.includes(name)) {
      throw invalidParams('Declared dependency is not represented in the supplied lock evidence.', {
        dependency: name,
        lock_files: lockFiles,
      });
    }
  }

  for (const [index, dataFile] of (dependencies.data_files ?? []).entries()) {
    if (path.isAbsolute(dataFile) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(dataFile)) {
      throw invalidParams('data_files must be copied into the computation workspace.', { index, data_file: dataFile });
    }
    const safe = sanitizeRelativePath(dataFile, `dependencies.data_files[${index}]`);
    const filePath = resolveWithinRoot(params.workspaceDir, safe, `dependencies.data_files[${index}]`);
    assertNoSymlinkComponents(params.workspaceDir, filePath, `dependencies.data_files[${index}]`);
    const relative = path.relative(params.workspaceDir, filePath).split(path.sep).join('/');
    if (!refByPath.has(relative)) {
      throw invalidParams('Declared data file is absent from the adjacent workspace snapshot.', {
        data_file: dataFile,
      });
    }
  }

  const declaredExternal = dependencies.external_dependency_refs ?? [];
  if (declaredExternal.length !== params.externalRefs.length) {
    throw invalidParams('External dependency refs are not completely represented in the adjacent snapshot.', {});
  }
  const liveKeys = params.externalRefs
    .map(ref => `${ref.canonical_path}\n${ref.sha256}\n${ref.size_bytes}`)
    .sort();
  const declaredKeys = declaredExternal.map((ref) => {
    if (!path.isAbsolute(ref.path)) {
      throw invalidParams('external_dependency_refs paths must be absolute and must not depend on the caller working directory.', {
        external_dependency_path: ref.path,
      });
    }
    const canonicalPath = fs.realpathSync.native(ref.path);
    const size = ref.size_bytes ?? fs.statSync(canonicalPath).size;
    return `${canonicalPath}\n${ref.sha256}\n${size}`;
  }).sort();
  if (declaredKeys.some((key, index) => key !== liveKeys[index])) {
    throw invalidParams('External dependency snapshot does not match the manifest content refs.', {});
  }
}

export function assertStepPathArgumentsDeclared(params: {
  externalRefs: ExternalDependencySnapshotEntry[];
  manifest: ComputationManifestV1;
  workspaceDir: string;
}): void {
  const canonicalWorkspaceDir = fs.realpathSync.native(params.workspaceDir);
  const externalPaths = new Set(params.externalRefs.map(ref => ref.canonical_path));
  for (const step of params.manifest.steps) {
    for (const arg of step.args ?? []) {
      const candidate = path.isAbsolute(arg) ? path.resolve(arg) : path.resolve(params.workspaceDir, arg);
      if (!fs.existsSync(candidate) || !fs.lstatSync(candidate).isFile()) continue;
      const canonical = fs.realpathSync.native(candidate);
      const relative = path.relative(canonicalWorkspaceDir, canonical);
      const insideWorkspace = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      if (insideWorkspace) {
        assertNoSymlinkComponents(canonicalWorkspaceDir, canonical, `step '${step.id}' file argument`);
      }
      if (!insideWorkspace && !externalPaths.has(canonical)) {
        throw invalidParams('Existing file arguments must be workspace-contained or content-addressed external_dependency_refs.', {
          step_id: step.id,
          argument: arg,
        });
      }
    }
  }
}
