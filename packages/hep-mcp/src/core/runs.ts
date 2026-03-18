import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ensureDir } from '../data/dataDir.js';
import { HEP_EXPORT_PROJECT, HEP_RUN_CLEAR_MANIFEST_LOCK } from '../tool-names.js';
import {
  invalidParams,
  notFound,
  type RunArtifactRef,
  type RunState,
  type RunStepState,
} from '@autoresearch/shared';
import { newRunId } from './ids.js';
import { getRunArtifactsDir, getRunArtifactPath, getRunDir, getRunManifestPath, getRunsDir } from './paths.js';
import { getProject, updateProjectUpdatedAt } from './projects.js';
import { writeRunJsonArtifact } from './citations.js';
import { createHepRunArtifactRef, makeHepRunManifestUri } from './runArtifactUri.js';

// Re-export from shared (H-03, H-18) so existing consumers don't need import changes
export type { RunArtifactRef, RunState, RunStepState };

/**
 * @deprecated Use `RunStepState` from `@autoresearch/shared` instead (H-03).
 * Kept for backward compatibility during migration.
 */
export type RunStepStatus = RunStepState;

export interface RunStep {
  step: string;
  status: RunStepState;
  started_at?: string;
  completed_at?: string;
  artifacts?: RunArtifactRef[];
  notes?: string;
}

export interface RunManifest {
  run_id: string;
  project_id: string;
  created_at: string;
  updated_at: string;
  status: RunState;
  args_snapshot?: RunArtifactRef;
  steps: RunStep[];
}

export function getRun(runId: string): RunManifest {
  const manifestPath = getRunManifestPath(runId);
  if (!fs.existsSync(manifestPath)) {
    throw notFound(`Run not found: ${runId}`, { run_id: runId });
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as RunManifest;
  } catch (err) {
    const parseErrRef = writeRunJsonArtifact(runId, 'run_parse_error_manifest_v1.json', {
      version: 1,
      generated_at: new Date().toISOString(),
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw invalidParams('Malformed run manifest JSON (fail-fast)', {
      run_id: runId,
      manifest_uri: makeHepRunManifestUri(runId),
      parse_error_uri: parseErrRef.uri,
      parse_error_artifact: parseErrRef.name,
      next_actions: [
        {
          tool: HEP_EXPORT_PROJECT,
          args: { project_id: '<project_id>', include_runs: true, include_artifacts: true },
          reason: 'Export artifacts for manual recovery if the run manifest is corrupted.',
        },
      ],
    });
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readLockInfo(lockPath: string): Promise<{ raw?: string; parsed?: Record<string, unknown> }> {
  try {
    const raw = await fs.promises.readFile(lockPath, 'utf-8');
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return { raw, parsed };
    } catch {
      return { raw };
    }
  } catch {
    return {};
  }
}

async function acquireRunManifestLock(params: {
  run_id: string;
  lock_path: string;
  timeout_ms: number;
}): Promise<fs.promises.FileHandle> {
  const start = Date.now();
  let delayMs = 25;

  while (true) {
    try {
      const handle = await fs.promises.open(params.lock_path, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: nowIso() }, null, 2), 'utf-8');
      } catch (err) {
        try {
          await handle.close();
        } catch {
          // ignore close errors
        }
        try {
          await fs.promises.unlink(params.lock_path);
        } catch {
          // ignore unlink errors
        }
        throw invalidParams('Failed to write run manifest lock metadata (fail-fast)', {
          run_id: params.run_id,
          lock_path: params.lock_path,
          error: err instanceof Error ? err.message : String(err),
          next_actions: [
            {
              tool: HEP_RUN_CLEAR_MANIFEST_LOCK,
              args: { run_id: params.run_id, force: true },
              reason: 'If a partial lock file exists due to IO issues, force-clear it and retry after resolving permissions/disk space.',
            },
          ],
        });
      }
      return handle;
    } catch (err) {
      const code = (err as any)?.code;
      if (code !== 'EEXIST') {
        throw invalidParams('Failed to acquire run manifest lock (fail-fast)', {
          run_id: params.run_id,
          lock_path: params.lock_path,
          error: err instanceof Error ? err.message : String(err),
          next_actions: [
            {
              tool: HEP_RUN_CLEAR_MANIFEST_LOCK,
              args: { run_id: params.run_id, force: false },
              reason: 'If a stale lock exists, clear it before retrying.',
            },
          ],
        });
      }

      if (Date.now() - start >= params.timeout_ms) {
        const info = await readLockInfo(params.lock_path);
        throw invalidParams('Run manifest is locked by another operation (timeout) (fail-fast)', {
          run_id: params.run_id,
          lock_path: params.lock_path,
          lock_info: info.parsed ?? info.raw ?? null,
          timeout_ms: params.timeout_ms,
          next_actions: [
            {
              tool: HEP_RUN_CLEAR_MANIFEST_LOCK,
              args: { run_id: params.run_id, force: false },
              reason: 'If the lock is stale, clear it and retry the previous tool call.',
            },
          ],
        });
      }

      await sleepMs(delayMs);
      delayMs = Math.min(250, Math.round(delayMs * 1.5));
    }
  }
}

async function releaseRunManifestLock(params: {
  run_id: string;
  handle: fs.promises.FileHandle;
  lock_path: string;
}): Promise<void> {
  const errors: Record<string, unknown> = {};

  try {
    await params.handle.close();
  } catch (err) {
    errors.close_error = err instanceof Error ? err.message : String(err);
  }

  try {
    await fs.promises.unlink(params.lock_path);
  } catch (err) {
    const code = (err as any)?.code;
    if (code !== 'ENOENT') {
      errors.unlink_error = err instanceof Error ? err.message : String(err);
    }
  }

  if (fs.existsSync(params.lock_path)) {
    try {
      await fs.promises.unlink(params.lock_path);
    } catch (err) {
      const code = (err as any)?.code;
      if (code !== 'ENOENT') {
        errors.unlink_retry_error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    throw invalidParams('Failed to release run manifest lock (fail-fast)', {
      run_id: params.run_id,
      lock_path: params.lock_path,
      errors,
      lock_file_exists: fs.existsSync(params.lock_path),
      next_actions: [
        {
          tool: HEP_RUN_CLEAR_MANIFEST_LOCK,
          args: { run_id: params.run_id, force: true },
          reason: 'Force-clear the lock if it remains due to filesystem issues, then retry the previous tool call.',
        },
      ],
    });
  }
}

function lockPathForRun(runId: string): string {
  return path.join(getRunDir(runId), '.manifest.lock');
}

async function atomicWriteJsonFile(params: { file_path: string; data: unknown }): Promise<void> {
  const dir = path.dirname(params.file_path);
  const base = path.basename(params.file_path);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}-${randomUUID()}`);
  await fs.promises.writeFile(tmpPath, JSON.stringify(params.data, null, 2), 'utf-8');
  await fs.promises.rename(tmpPath, params.file_path);
}

function atomicWriteJsonFileSync(params: { file_path: string; data: unknown }): void {
  const dir = path.dirname(params.file_path);
  const base = path.basename(params.file_path);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}-${randomUUID()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(params.data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, params.file_path);
}

export async function clearRunManifestLock(params: {
  run_id: string;
  force?: boolean;
}): Promise<{
  run_id: string;
  lock_path: string;
  existed: boolean;
  cleared: boolean;
  stale: boolean | null;
  lock_info: { raw?: string; parsed?: Record<string, unknown> } | null;
}> {
  const runId = params.run_id;
  const lockPath = lockPathForRun(runId);
  const force = Boolean(params.force);

  if (!fs.existsSync(getRunManifestPath(runId))) {
    throw notFound(`Run not found: ${runId}`, { run_id: runId });
  }

  if (!fs.existsSync(lockPath)) {
    return { run_id: runId, lock_path: lockPath, existed: false, cleared: false, stale: null, lock_info: null };
  }

  const info = await readLockInfo(lockPath);
  const parsed = info.parsed;
  const pidRaw = parsed?.pid;
  const createdAtRaw = parsed?.created_at;

  const pid = typeof pidRaw === 'number' && Number.isFinite(pidRaw) ? Math.trunc(pidRaw) : null;
  const createdAt = typeof createdAtRaw === 'string' ? new Date(createdAtRaw) : null;
  const ageMs = createdAt && Number.isFinite(createdAt.getTime()) ? Date.now() - createdAt.getTime() : null;

  const isPidAlive = (() => {
    if (!pid || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as any)?.code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
      return null;
    }
  })();

  const staleThresholdMs = 5 * 60 * 1000;
  const isStale =
    force
    || (isPidAlive === false)
    || (ageMs !== null && Number.isFinite(ageMs) && ageMs >= staleThresholdMs);

  if (!isStale && !force) {
    throw invalidParams('Run manifest lock appears active (refusing to clear without force)', {
      run_id: runId,
      lock_path: lockPath,
      lock_info: parsed ?? info.raw ?? null,
      next_actions: [
        {
          tool: HEP_RUN_CLEAR_MANIFEST_LOCK,
          args: { run_id: runId, force: true },
          reason: 'If you are sure no other tool is updating the run manifest, force-clear the lock and retry.',
        },
      ],
    });
  }

  try {
    await fs.promises.unlink(lockPath);
  } catch (err) {
    throw invalidParams('Failed to remove run manifest lock (fail-fast)', {
      run_id: runId,
      lock_path: lockPath,
      error: err instanceof Error ? err.message : String(err),
      lock_info: parsed ?? info.raw ?? null,
      next_actions: [
        {
          tool: HEP_RUN_CLEAR_MANIFEST_LOCK,
          args: { run_id: runId, force: true },
          reason: 'Retry after resolving filesystem permission/disk issues.',
        },
      ],
    });
  }

  return {
    run_id: runId,
    lock_path: lockPath,
    existed: true,
    cleared: true,
    stale: isStale,
    lock_info: parsed ? { parsed, raw: info.raw } : info.raw ? { raw: info.raw } : null,
  };
}

export async function updateRunManifestAtomic(params: {
  run_id: string;
  update: (current: RunManifest) => RunManifest | Promise<RunManifest>;
  lock_timeout_ms?: number;
  tool?: { name: string; args: Record<string, unknown> };
}): Promise<RunManifest> {
  const runId = params.run_id;
  const manifestPath = getRunManifestPath(runId);
  const lockPath = lockPathForRun(runId);
  const timeoutMs = typeof params.lock_timeout_ms === 'number' && Number.isFinite(params.lock_timeout_ms)
    ? Math.max(1, Math.trunc(params.lock_timeout_ms))
    : 10_000;

  const lockHandle = await acquireRunManifestLock({ run_id: runId, lock_path: lockPath, timeout_ms: timeoutMs });
  let primaryError: unknown = undefined;
  try {
    if (!fs.existsSync(manifestPath)) {
      throw notFound(`Run not found: ${runId}`, { run_id: runId });
    }

    let current: RunManifest;
    try {
      current = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8')) as RunManifest;
    } catch (err) {
      const parseErrRef = writeRunJsonArtifact(runId, 'run_parse_error_manifest_v1.json', {
        version: 1,
        generated_at: nowIso(),
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw invalidParams('Malformed run manifest JSON (fail-fast)', {
        run_id: runId,
        manifest_uri: makeHepRunManifestUri(runId),
        parse_error_uri: parseErrRef.uri,
        parse_error_artifact: parseErrRef.name,
        next_actions: [
          {
            tool: HEP_EXPORT_PROJECT,
            args: { project_id: '<project_id>', include_runs: true, include_artifacts: true },
            reason: 'Export artifacts for manual recovery if the run manifest is corrupted.',
          },
        ],
      });
    }

    const next = await params.update(current);
    if (!next || typeof next !== 'object') {
      throw invalidParams('Internal: manifest update must return an object', { run_id: runId });
    }
    if (next.run_id !== current.run_id) {
      throw invalidParams('Internal: manifest run_id mismatch during update', {
        run_id: runId,
        current_run_id: current.run_id,
        next_run_id: next.run_id,
      });
    }

    try {
      await atomicWriteJsonFile({ file_path: manifestPath, data: next });
    } catch (err) {
      throw invalidParams('Failed to write run manifest atomically (fail-fast)', {
        run_id: runId,
        manifest_path: manifestPath,
        error: err instanceof Error ? err.message : String(err),
        next_actions: [
          ...(params.tool ? [{ tool: params.tool.name, args: params.tool.args, reason: 'Retry after resolving disk/permission issues.' }] : []),
        ],
      });
    }

    return next;
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    try {
      await releaseRunManifestLock({ run_id: runId, handle: lockHandle, lock_path: lockPath });
    } catch (releaseErr) {
      if (primaryError === undefined) {
        throw releaseErr;
      }

      const primary = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const release = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
      throw invalidParams('Failed to release run manifest lock (fail-fast)', {
        run_id: runId,
        lock_path: lockPath,
        release_error: release,
        previous_error: primary,
        next_actions: [
          { tool: HEP_RUN_CLEAR_MANIFEST_LOCK, args: { run_id: runId, force: true }, reason: 'Force-clear the lock file and retry after resolving filesystem issues.' },
        ],
      });
    }
  }
}

export function listRuns(): RunManifest[] {
  const dir = getRunsDir();
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const runs: RunManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    runs.push(getRun(runId));
  }
  runs.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return runs;
}

export function createRun(params: {
  project_id: string;
  args_snapshot?: unknown;
}): { manifest: RunManifest; artifacts: RunArtifactRef[] } {
  // Ensure project exists
  getProject(params.project_id);

  const now = new Date().toISOString();
  const runId = newRunId();

  const runDir = getRunDir(runId);
  ensureDir(runDir);

  getRunArtifactsDir(runId);
  const artifacts: RunArtifactRef[] = [];

  // Example artifact (DoD): args snapshot (may be large → artifact)
  const argsArtifactName = 'args_snapshot.json';
  const argsArtifactPath = getRunArtifactPath(runId, argsArtifactName);
  fs.writeFileSync(
    argsArtifactPath,
    JSON.stringify(
      {
        run_id: runId,
        project_id: params.project_id,
        created_at: now,
        args_snapshot: params.args_snapshot ?? null,
      },
      null,
      2
    ),
    'utf-8'
  );

  const argsArtifactRef: RunArtifactRef = createHepRunArtifactRef(runId, argsArtifactName, 'application/json');
  artifacts.push(argsArtifactRef);

  // Minimal manifest with step-level records
  const manifest: RunManifest = {
    run_id: runId,
    project_id: params.project_id,
    created_at: now,
    updated_at: now,
    status: 'pending',
    args_snapshot: argsArtifactRef,
    steps: [
      {
        step: 'run_create',
        status: 'done',
        started_at: now,
        completed_at: now,
        artifacts: [argsArtifactRef],
      },
    ],
  };

  const manifestPath = getRunManifestPath(runId);
  try {
    atomicWriteJsonFileSync({ file_path: manifestPath, data: manifest });
  } catch (err) {
    throw invalidParams('Failed to write run manifest (fail-fast)', {
      run_id: runId,
      manifest_path: manifestPath,
      error: err instanceof Error ? err.message : String(err),
      next_actions: [
        'Check filesystem permissions and available disk space in HEP_DATA_DIR.',
        'Then retry hep_run_create.',
      ],
    });
  }

  // Touch project updated_at
  updateProjectUpdatedAt(params.project_id);

  return { manifest, artifacts };
}
