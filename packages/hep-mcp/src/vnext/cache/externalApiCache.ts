import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import {
  HEP_RUN_READ_ARTIFACT_CHUNK,
  invalidParams,
} from '@autoresearch/shared';

import { ensureDir, getCacheDir } from '../../data/dataDir.js';
import { getRun, type RunArtifactRef } from '../runs.js';
import { assertSafePathSegment } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';

type ExternalApiCacheEntryV1 = {
  version: 1;
  created_at: string;
  namespace: string;
  operation: string;
  request_hash: string;
  request: unknown;
  response: unknown;
};

function nowIso(): string {
  return new Date().toISOString();
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'bigint') return JSON.stringify(String(value));
  if (t === 'undefined') return 'undefined';
  if (t === 'function' || t === 'symbol') return JSON.stringify(String(value));

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }

  return JSON.stringify(String(value));
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function atomicWriteFile(params: { file_path: string; bytes: Uint8Array }): Promise<void> {
  const dir = path.dirname(params.file_path);
  const base = path.basename(params.file_path);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}-${randomUUID()}`);
  return fs.promises.writeFile(tmpPath, params.bytes)
    .then(() => fs.promises.rename(tmpPath, params.file_path))
    .catch(async err => {
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        // ignore tmp cleanup failures
      }
      throw err;
    });
}

function safeCacheSegment(raw: string, what: string): string {
  const trimmed = raw.trim();
  assertSafePathSegment(trimmed, what);
  return trimmed;
}

function externalApiCacheEntryPath(params: { namespace: string; operation: string; request_hash: string }): string {
  const namespace = safeCacheSegment(params.namespace, 'namespace');
  const operation = safeCacheSegment(params.operation, 'operation');
  const hash = params.request_hash;
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw invalidParams('Internal: request_hash must be a sha256 hex string', { request_hash: hash });
  }

  const cacheRoot = getCacheDir();
  ensureDir(cacheRoot);
  const dir = path.join(cacheRoot, 'external_api_v1', namespace, operation, hash.slice(0, 2).toLowerCase());
  ensureDir(dir);
  return path.join(dir, `${hash}.json`);
}

function defaultArtifactName(prefix: string, params: { namespace: string; operation: string; request_hash: string }): string {
  const namespace = safeCacheSegment(params.namespace, 'namespace');
  const operation = safeCacheSegment(params.operation, 'operation');
  return `${prefix}_${namespace}_${operation}_${params.request_hash}.json`;
}

export async function cachedExternalApiJsonCall<T>(params: {
  run_id: string;
  namespace: string;
  operation: string;
  request: unknown;
  fetch: () => Promise<T>;
  request_artifact_name?: string;
  response_artifact_name?: string;
  tool?: { name: string; args: Record<string, unknown> };
}): Promise<{
  run_id: string;
  request_hash: string;
  cache_hit: boolean;
  cached_response_uri: string;
  artifacts: RunArtifactRef[];
  response: T;
}> {
  const runId = params.run_id;
  getRun(runId);

  const namespace = safeCacheSegment(params.namespace, 'namespace');
  const operation = safeCacheSegment(params.operation, 'operation');

  const requestEnvelope = {
    version: 1,
    namespace,
    operation,
    request: params.request ?? null,
  };
  const requestHash = sha256Hex(stableStringify(requestEnvelope));

  const requestArtifactName = params.request_artifact_name?.trim()
    ? params.request_artifact_name.trim()
    : defaultArtifactName('external_api_request', { namespace, operation, request_hash: requestHash });
  const responseArtifactName = params.response_artifact_name?.trim()
    ? params.response_artifact_name.trim()
    : defaultArtifactName('external_api_response', { namespace, operation, request_hash: requestHash });

  const cachePath = (() => {
    try {
      return externalApiCacheEntryPath({ namespace, operation, request_hash: requestHash });
    } catch (err) {
      throw invalidParams('Failed to resolve external API cache path (fail-fast)', {
        run_id: runId,
        namespace,
        operation,
        request_hash: requestHash,
        error: err instanceof Error ? err.message : String(err),
        next_actions: [
          ...(params.tool ? [{ tool: params.tool.name, args: params.tool.args, reason: 'Retry after fixing cache directory permissions/disk space (fail-fast).' }] : []),
        ],
      });
    }
  })();
  const cachedResponseUri = pathToFileURL(cachePath).toString();

  const requestRef = writeRunJsonArtifact(runId, requestArtifactName, {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    namespace,
    operation,
    request_hash: requestHash,
    request: params.request ?? null,
  });

  let cacheHit = false;
  let response: T;

  if (fs.existsSync(cachePath)) {
    let cached: ExternalApiCacheEntryV1;
    try {
      cached = JSON.parse(await fs.promises.readFile(cachePath, 'utf-8')) as ExternalApiCacheEntryV1;
    } catch (err) {
      const parseErrRef = writeRunJsonArtifact(runId, `external_api_cache_parse_error_${namespace}_${operation}_${requestHash}.json`, {
        version: 1,
        generated_at: nowIso(),
        run_id: runId,
        namespace,
        operation,
        request_hash: requestHash,
        cached_response_uri: cachedResponseUri,
        error: err instanceof Error ? err.message : String(err),
      });
      throw invalidParams('External API cache entry is not valid JSON (fail-fast)', {
        run_id: runId,
        namespace,
        operation,
        request_hash: requestHash,
        cached_response_uri: cachedResponseUri,
        cache_path: cachePath,
        parse_error_uri: parseErrRef.uri,
        parse_error_artifact: parseErrRef.name,
        next_actions: [
          { tool: HEP_RUN_READ_ARTIFACT_CHUNK, args: { run_id: runId, artifact_name: parseErrRef.name, offset: 0, length: 2048 }, reason: 'Inspect the cache parse error artifact.' },
          ...(params.tool ? [{ tool: params.tool.name, args: params.tool.args, reason: 'Retry after removing the corrupted cache entry (manual) (fail-fast).' }] : []),
        ],
      });
    }

    if (
      cached.version !== 1
      || cached.request_hash !== requestHash
      || cached.namespace !== namespace
      || cached.operation !== operation
    ) {
      const mismatchRef = writeRunJsonArtifact(runId, `external_api_cache_mismatch_${namespace}_${operation}_${requestHash}.json`, {
        version: 1,
        generated_at: nowIso(),
        run_id: runId,
        namespace,
        operation,
        request_hash: requestHash,
        cached_response_uri: cachedResponseUri,
        cached: {
          version: cached.version ?? null,
          request_hash: (cached as any)?.request_hash ?? null,
          namespace: (cached as any)?.namespace ?? null,
          operation: (cached as any)?.operation ?? null,
        },
      });
      throw invalidParams('External API cache entry mismatches request (fail-fast)', {
        run_id: runId,
        namespace,
        operation,
        request_hash: requestHash,
        cached_response_uri: cachedResponseUri,
        cache_path: cachePath,
        mismatch_uri: mismatchRef.uri,
        mismatch_artifact: mismatchRef.name,
        next_actions: [
          { tool: HEP_RUN_READ_ARTIFACT_CHUNK, args: { run_id: runId, artifact_name: mismatchRef.name, offset: 0, length: 2048 }, reason: 'Inspect the cache mismatch artifact and remove the corrupted cache entry manually if needed.' },
          ...(params.tool ? [{ tool: params.tool.name, args: params.tool.args, reason: 'Retry after removing the corrupted cache entry (manual) (fail-fast).' }] : []),
        ],
      });
    }

    cacheHit = true;
    response = cached.response as T;
  } else {
    response = await params.fetch();

    const entry: ExternalApiCacheEntryV1 = {
      version: 1,
      created_at: nowIso(),
      namespace,
      operation,
      request_hash: requestHash,
      request: params.request ?? null,
      response,
    };

    try {
      await atomicWriteFile({ file_path: cachePath, bytes: Buffer.from(JSON.stringify(entry, null, 2), 'utf-8') });
    } catch (err) {
      const ioErrRef = writeRunJsonArtifact(runId, `external_api_cache_io_error_${namespace}_${operation}_${requestHash}.json`, {
        version: 1,
        generated_at: nowIso(),
        run_id: runId,
        namespace,
        operation,
        request_hash: requestHash,
        cached_response_uri: cachedResponseUri,
        error: err instanceof Error ? err.message : String(err),
      });
      throw invalidParams('External API cache write failed (fail-fast)', {
        run_id: runId,
        namespace,
        operation,
        request_hash: requestHash,
        cached_response_uri: cachedResponseUri,
        cache_path: cachePath,
        cache_error_uri: ioErrRef.uri,
        cache_error_artifact: ioErrRef.name,
        next_actions: [
          { tool: HEP_RUN_READ_ARTIFACT_CHUNK, args: { run_id: runId, artifact_name: ioErrRef.name, offset: 0, length: 2048 }, reason: 'Inspect the cache IO error artifact (disk/permission issues are fatal by design).' },
          ...(params.tool ? [{ tool: params.tool.name, args: params.tool.args, reason: 'Retry after resolving cache directory IO failures (fail-fast).' }] : []),
        ],
      });
    }
  }

  const responseRef = writeRunJsonArtifact(runId, responseArtifactName, {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    namespace,
    operation,
    request_hash: requestHash,
    request_uri: requestRef.uri,
    cache_hit: cacheHit,
    cached_response_uri: cachedResponseUri,
    response,
  });

  return {
    run_id: runId,
    request_hash: requestHash,
    cache_hit: cacheHit,
    cached_response_uri: cachedResponseUri,
    artifacts: [requestRef, responseRef],
    response,
  };
}
