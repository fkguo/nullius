import * as fs from 'fs';
import { createHash } from 'crypto';
import {
  extractRecidFromUrl,
  normalizeArxivID,
  invalidParams,
  type IdentifierType,
} from '@autoresearch/shared';

import * as api from '../../api/client.js';
import { writeRunJsonArtifact } from '../citations.js';
import { getRun, type RunArtifactRef } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { cachedExternalApiJsonCall } from '../cache/externalApiCache.js';
import { makeHepRunArtifactUri, makeHepRunManifestUri } from '../runArtifactUri.js';
import { startRunStep, completeRunStep } from '../zotero/runSteps.js';

export type ResolveStatusV1 = 'matched' | 'not_found' | 'error';

export interface ResolveIdentifierItemV1 {
  version: 1;
  input: string;
  normalized: string;
  kind: IdentifierType;
  status: ResolveStatusV1;
  recid?: string;
  doi?: string;
  arxiv_id?: string;
  message?: string;
}

export interface ResolveIdentifiersMetaV1 {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  total: number;
  matched: number;
  not_found: number;
  errors: number;
  warnings: string[];
  artifacts: {
    mapping_uri: string;
    meta_uri: string;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function stripUrlSuffix(input: string): string {
  return input.replace(/[?#].*$/, '');
}

function isLikelyArxivId(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  return (
    /^\d{4}\.\d{4,5}(v\d+)?$/i.test(trimmed)
    || /^[a-z-]+\/\d{7}(v\d+)?$/i.test(trimmed)
  );
}

function makeArtifactNames(params: {
  identifiers: string[];
  artifact_name?: string;
  meta_artifact_name?: string;
}): { mappingName: string; metaName: string } {
  if (params.artifact_name && params.meta_artifact_name) {
    return { mappingName: params.artifact_name, metaName: params.meta_artifact_name };
  }

  const material = JSON.stringify({
    identifiers: params.identifiers.map(s => s.trim()).filter(Boolean),
  });
  const hash = sha256Hex(material).slice(0, 16);
  return {
    mappingName: params.artifact_name ?? `inspire_resolve_identifiers_${hash}.jsonl`,
    metaName: params.meta_artifact_name ?? `inspire_resolve_identifiers_${hash}_meta.json`,
  };
}

function classifyIdentifier(raw: string): { kind: IdentifierType; normalized: string; recid?: string; doi?: string; arxiv_id?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'unknown', normalized: '' };

  const recidFromUrl = extractRecidFromUrl(trimmed);
  if (recidFromUrl) return { kind: 'recid', normalized: recidFromUrl, recid: recidFromUrl };

  if (/^\d+$/.test(trimmed)) return { kind: 'recid', normalized: trimmed, recid: trimmed };

  const doi = (() => {
    const m = trimmed.match(/^https?:\/\/doi\.org\/(10\..+)$/i);
    if (m?.[1]) return stripUrlSuffix(m[1].trim());
    const direct = trimmed.replace(/^doi:/i, '').trim();
    if (direct.startsWith('10.')) return stripUrlSuffix(direct);
    return undefined;
  })();
  if (doi) return { kind: 'doi', normalized: doi, doi };

  const arxiv = (() => {
    const m = trimmed.match(/^https?:\/\/arxiv\.org\/abs\/(.+)$/i);
    const candidate = m?.[1] ? stripUrlSuffix(m[1].trim()) : trimmed;
    const norm = normalizeArxivID(candidate);
    if (!norm) return undefined;
    const cleaned = stripUrlSuffix(norm.trim());
    return isLikelyArxivId(cleaned) ? cleaned : undefined;
  })();
  if (arxiv) return { kind: 'arxiv', normalized: arxiv, arxiv_id: arxiv };

  return { kind: 'unknown', normalized: trimmed };
}

function resolveStatusFromError(err: unknown): { status: ResolveStatusV1; message?: string } {
  if (err instanceof Error) {
    const anyErr = err as any;
    if (anyErr?.code === 'UPSTREAM_ERROR' && anyErr?.data?.status === 404) {
      return { status: 'not_found', message: err.message };
    }
    return { status: 'error', message: err.message };
  }
  return { status: 'error', message: String(err) };
}

type ExternalApiCallIndexItemV1 = {
  version: 1;
  namespace: string;
  operation: string;
  request_hash: string;
  cache_hit: boolean;
  cached_response_uri: string;
  request_uri: string;
  response_uri: string;
};

export async function hepInspireResolveIdentifiers(params: {
  run_id: string;
  identifiers: string[];
  artifact_name?: string;
  meta_artifact_name?: string;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  mapping_uri: string;
  meta_uri: string;
  summary: {
    total: number;
    matched: number;
    not_found: number;
    errors: number;
    warnings_total: number;
    warnings: string[];
  };
}> {
  const runId = params.run_id;
  const run = getRun(runId);

  const identifiers = params.identifiers.map(s => s.trim()).filter(Boolean);
  if (identifiers.length === 0) {
    throw invalidParams('identifiers cannot be empty', { identifiers: params.identifiers });
  }

  const { mappingName, metaName } = makeArtifactNames({
    identifiers,
    artifact_name: params.artifact_name,
    meta_artifact_name: params.meta_artifact_name,
  });

  const mappingUri = makeHepRunArtifactUri(runId, mappingName);
  const metaUri = makeHepRunArtifactUri(runId, metaName);

  const { stepIndex, step } = await startRunStep(runId, 'inspire_resolve_identifiers');

  const artifacts: RunArtifactRef[] = [];
  const warnings: string[] = [];
  const externalApiCalls: ExternalApiCallIndexItemV1[] = [];

  let matched = 0;
  let notFound = 0;
  let errors = 0;

  const mappingPath = getRunArtifactPath(runId, mappingName);
  const out = fs.createWriteStream(mappingPath, { encoding: 'utf-8' });

  try {
    for (const input of identifiers) {
      const classified = classifyIdentifier(input);

      const item: ResolveIdentifierItemV1 = {
        version: 1,
        input,
        normalized: classified.normalized,
        kind: classified.kind,
        status: 'not_found',
        recid: classified.recid,
        doi: classified.doi,
        arxiv_id: classified.arxiv_id,
      };

      if (!classified.normalized || classified.kind === 'unknown') {
        item.status = 'not_found';
        item.message = 'unsupported_identifier';
        notFound += 1;
        out.write(`${JSON.stringify(item)}\n`);
        continue;
      }

      try {
        if (classified.kind === 'recid') {
          const cached = await cachedExternalApiJsonCall({
            run_id: runId,
            namespace: 'inspire',
            operation: 'getPaper',
            request: { recid: classified.normalized },
            fetch: () => api.getPaper(classified.normalized),
          });
          const [requestRef, responseRef] = cached.artifacts;
          externalApiCalls.push({
            version: 1,
            namespace: 'inspire',
            operation: 'getPaper',
            request_hash: cached.request_hash,
            cache_hit: cached.cache_hit,
            cached_response_uri: cached.cached_response_uri,
            request_uri: requestRef.uri,
            response_uri: responseRef.uri,
          });
          const paper = cached.response;
          item.recid = paper.recid ?? classified.normalized;
          item.status = item.recid ? 'matched' : 'not_found';
        } else if (classified.kind === 'doi' && classified.doi) {
          const doi = classified.doi;
          const cached = await cachedExternalApiJsonCall({
            run_id: runId,
            namespace: 'inspire',
            operation: 'getByDoi',
            request: { doi },
            fetch: () => api.getByDoi(doi),
          });
          const [requestRef, responseRef] = cached.artifacts;
          externalApiCalls.push({
            version: 1,
            namespace: 'inspire',
            operation: 'getByDoi',
            request_hash: cached.request_hash,
            cache_hit: cached.cache_hit,
            cached_response_uri: cached.cached_response_uri,
            request_uri: requestRef.uri,
            response_uri: responseRef.uri,
          });
          const paper = cached.response;
          item.recid = paper.recid;
          item.status = item.recid ? 'matched' : 'not_found';
        } else if (classified.kind === 'arxiv' && classified.arxiv_id) {
          const arxivId = classified.arxiv_id;
          const cached = await cachedExternalApiJsonCall({
            run_id: runId,
            namespace: 'inspire',
            operation: 'getByArxiv',
            request: { arxiv_id: arxivId },
            fetch: () => api.getByArxiv(arxivId),
          });
          const [requestRef, responseRef] = cached.artifacts;
          externalApiCalls.push({
            version: 1,
            namespace: 'inspire',
            operation: 'getByArxiv',
            request_hash: cached.request_hash,
            cache_hit: cached.cache_hit,
            cached_response_uri: cached.cached_response_uri,
            request_uri: requestRef.uri,
            response_uri: responseRef.uri,
          });
          const paper = cached.response;
          item.recid = paper.recid;
          item.status = item.recid ? 'matched' : 'not_found';
        } else {
          item.status = 'not_found';
          item.message = 'unsupported_identifier';
        }
      } catch (err) {
        if ((err as any)?.code === 'INVALID_PARAMS') throw err;
        const status = resolveStatusFromError(err);
        item.status = status.status;
        item.message = status.message;
      }

      if (item.status === 'matched') matched += 1;
      else if (item.status === 'not_found') notFound += 1;
      else errors += 1;

      out.write(`${JSON.stringify(item)}\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      out.destroy();
    } catch {
      // ignore
    }
    try {
      await completeRunStep({
        runId,
        stepIndex,
        stepStart: step,
        status: 'failed',
        artifacts,
        notes: message,
      });
    } catch {
      // ignore
    }
    throw err;
  }

  await new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.on('finish', resolve);
    out.end();
  });

  artifacts.push({
    name: mappingName,
    uri: mappingUri,
    mimeType: 'application/x-ndjson',
  });

  const indexName = `external_api_calls_inspire_resolve_identifiers_${sha256Hex(JSON.stringify({ identifiers }))?.slice(0, 16)}.json`;
  const externalApiCallsRef = writeRunJsonArtifact(runId, indexName, {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    calls: externalApiCalls,
    stats: {
      calls_total: externalApiCalls.length,
      cache_hits: externalApiCalls.filter(c => c.cache_hit).length,
      cache_misses: externalApiCalls.filter(c => !c.cache_hit).length,
    },
  });
  artifacts.push(externalApiCallsRef);

  const metaPayload: ResolveIdentifiersMetaV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    total: identifiers.length,
    matched,
    not_found: notFound,
    errors,
    warnings,
    artifacts: { mapping_uri: mappingUri, meta_uri: metaUri },
  };

  const metaRef = writeRunJsonArtifact(runId, metaName, metaPayload);
  artifacts.push(metaRef);

  await completeRunStep({
    runId,
    stepIndex,
    stepStart: step,
    status: 'done',
    artifacts,
  });

  return {
    run_id: runId,
    project_id: run.project_id,
    manifest_uri: makeHepRunManifestUri(runId),
    artifacts,
    mapping_uri: mappingUri,
    meta_uri: metaRef.uri,
    summary: {
      total: identifiers.length,
      matched,
      not_found: notFound,
      errors,
      warnings_total: warnings.length,
      warnings: warnings.slice(0, 20),
    },
  };
}
