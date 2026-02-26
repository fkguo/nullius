/**
 * Core Zotero tools — thin adapter layer.
 *
 * NEW-R04: Deduplication — canonical Zotero tool implementations live in
 * `@autoresearch/zotero-mcp/src/zotero/tools.ts`.  This file only contains
 * `hepImportFromZotero` (the sole run-aware Zotero function exposed via
 * MCP registry) and imports shared helpers from the canonical package.
 */

import { invalidParams } from '@autoresearch/shared';
import type { Paper } from '@autoresearch/shared';
import pLimit from 'p-limit';

import * as inspireApi from '../../api/client.js';
import { writeRunJsonArtifact } from '../citations.js';
import { cachedExternalApiJsonCall } from '../cache/externalApiCache.js';
import { getRun, type RunArtifactRef } from '../runs.js';
import { BudgetTrackerV1, writeRunStepDiagnosticsArtifact } from '../diagnostics.js';

import {
  zoteroGetJson,
  extractZoteroItemIdentifiers,
  isRecord,
  normalizeZoteroKey,
  parseAttachmentSummaries,
  isPdfAttachment,
} from '@autoresearch/zotero-mcp/shared/zotero';
import { completeRunStep, startRunStep } from './runSteps.js';

export async function hepImportFromZotero(params: {
  run_id: string;
  collection_key?: string;
  item_keys?: string[];
  limit?: number;
  start?: number;
  concurrency?: number;
  budget_hints?: {
    concurrency_provided?: boolean;
  };
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: { items_total: number; resolved_recids: number; attachments_total: number; pdf_attachments_total: number };
}> {
  const runId = normalizeZoteroKey(params.run_id, 'run_id');
  const run = getRun(runId);

  const limit = params.limit ?? 200;
  const start = params.start ?? 0;
  const collectionKey = params.collection_key ? normalizeZoteroKey(params.collection_key, 'collection_key') : undefined;

  const itemKeySet = new Set<string>();
  for (const k of (params.item_keys || [])) {
    itemKeySet.add(normalizeZoteroKey(k, 'item_keys'));
  }

  const { stepIndex, step } = await startRunStep(runId, 'hep_import_from_zotero');
  const artifacts: RunArtifactRef[] = [];
  const budget = new BudgetTrackerV1();
  const externalApiCalls: Array<{
    version: 1;
    namespace: string;
    operation: string;
    request_hash: string;
    cache_hit: boolean;
    cached_response_uri: string;
    request_uri: string;
    response_uri: string;
  }> = [];

  try {
    const concurrency = budget.resolveInt({
      key: 'budget.concurrency',
      dimension: 'budget',
      unit: 'requests',
      arg_path: 'concurrency',
      tool_value: params.concurrency,
      tool_value_present: params.budget_hints?.concurrency_provided ?? params.concurrency !== undefined,
      env_var: 'HEP_BUDGET_CONCURRENCY',
      default_value: 4,
      min: 1,
      max: 16,
    });
    budget.warn({
      severity: 'info',
      code: 'concurrency',
      message: `Zotero import parallelism: concurrency=${concurrency}.`,
      data: { concurrency },
    });

    if (collectionKey) {
      const listRes = await zoteroGetJson<unknown[]>(
        `/users/0/collections/${encodeURIComponent(collectionKey)}/items/top`,
        { limit, start }
      );
      for (const it of Array.isArray(listRes.data) ? listRes.data : []) {
        if (!isRecord(it)) continue;
        const k = it.key;
        if (typeof k !== 'string') continue;
        itemKeySet.add(normalizeZoteroKey(k, 'item_keys'));
      }
    }

    const itemKeys = Array.from(itemKeySet);
    if (itemKeys.length === 0) {
      throw invalidParams('Either collection_key or item_keys must be provided');
    }

    const limiter = pLimit(concurrency);
    const perItem = await Promise.all(
      itemKeys.map(itemKey =>
        limiter(async () => {
          const [itemRes, childRes] = await Promise.all([
            zoteroGetJson<Record<string, unknown>>(`/users/0/items/${encodeURIComponent(itemKey)}`),
            zoteroGetJson<unknown[]>(`/users/0/items/${encodeURIComponent(itemKey)}/children`),
          ]);

          const children = Array.isArray(childRes.data) ? childRes.data : [];
          const attachments = parseAttachmentSummaries(children);

          const ids = extractZoteroItemIdentifiers(itemRes.data);
          const resolvedRecid = await (async () => {
            if (ids.inspire_recid) {
              return { recid: ids.inspire_recid, method: 'inspire_recid', confidence: 1 };
            }
            if (ids.doi) {
              const doi = ids.doi;
              const cached = await cachedExternalApiJsonCall({
                run_id: runId,
                namespace: 'inspire',
                operation: 'getByDoi',
                request: { doi },
                fetch: () => inspireApi.getByDoi(doi),
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
              const paper = cached.response as unknown as Paper;
              return { recid: paper.recid, method: 'doi', confidence: 1 };
            }
            if (ids.arxiv_id) {
              const arxivId = ids.arxiv_id;
              const cached = await cachedExternalApiJsonCall({
                run_id: runId,
                namespace: 'inspire',
                operation: 'getByArxiv',
                request: { arxiv_id: arxivId },
                fetch: () => inspireApi.getByArxiv(arxivId),
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
              const paper = cached.response as unknown as Paper;
              return { recid: paper.recid, method: 'arxiv', confidence: 1 };
            }
            return null;
          })();

          return {
            attachments_total: attachments.length,
            pdf_attachments_total: attachments.filter(isPdfAttachment).length,
            resolved_recid: resolvedRecid,
            item: {
              zotero_item_key: ids.zotero_item_key,
              title: ids.title,
              identifiers: {
                doi: ids.doi,
                arxiv_id: ids.arxiv_id,
                inspire_recid: ids.inspire_recid,
              },
              resolve: resolvedRecid,
              attachments,
              warnings: ids.warnings,
              zotero_meta: {
                item_url: itemRes.meta.url,
                children_url: childRes.meta.url,
              },
            },
          };
        })
      )
    );

    const items = perItem.map(r => r.item);
    const resolved = perItem.filter(r => r.resolved_recid !== null).length;
    const attachmentsTotal = perItem.reduce((acc, r) => acc + r.attachments_total, 0);
    const pdfAttachmentsTotal = perItem.reduce((acc, r) => acc + r.pdf_attachments_total, 0);

    const mapRef = writeRunJsonArtifact(runId, 'zotero_map_v1.json', {
      version: 1,
      generated_at: new Date().toISOString(),
      run_id: runId,
      project_id: run.project_id,
      source: {
        collection_key: collectionKey,
        list_limit: collectionKey ? limit : undefined,
        list_start: collectionKey ? start : undefined,
        item_keys: itemKeys,
        concurrency,
      },
      items,
    });
    artifacts.push(mapRef);

    const externalCallsRef = writeRunJsonArtifact(runId, 'external_api_calls_inspire_zotero_import_v1.json', {
      version: 1,
      generated_at: new Date().toISOString(),
      run_id: runId,
      project_id: run.project_id,
      calls: externalApiCalls,
      stats: {
        calls_total: externalApiCalls.length,
        cache_hits: externalApiCalls.filter(c => c.cache_hit).length,
        cache_misses: externalApiCalls.filter(c => !c.cache_hit).length,
      },
    });
    artifacts.push(externalCallsRef);

    const diag = writeRunStepDiagnosticsArtifact({
      run_id: runId,
      project_id: run.project_id,
      step: step.step,
      step_index: stepIndex,
      ...budget.snapshot(),
    });
    artifacts.push(diag.run, diag.project);

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
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
      artifacts,
      summary: {
        items_total: itemKeys.length,
        resolved_recids: resolved,
        attachments_total: attachmentsTotal,
        pdf_attachments_total: pdfAttachmentsTotal,
      },
    };
  } catch (err) {
    try {
      await completeRunStep({
        runId,
        stepIndex,
        stepStart: step,
        status: 'failed',
        artifacts,
        notes: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // ignore
    }
    throw err;
  }
}
