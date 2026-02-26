import * as fs from 'fs';
import { createHash } from 'crypto';

import * as api from '../../api/client.js';
import { writeRunJsonArtifact } from '../citations.js';
import { BudgetTrackerV1, writeRunStepDiagnosticsArtifact } from '../diagnostics.js';
import { getRun, type RunArtifactRef } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { cachedExternalApiJsonCall } from '../cache/externalApiCache.js';
import { startRunStep, completeRunStep } from '../zotero/runSteps.js';

type SearchExportFormatV1 = 'jsonl' | 'json';

export interface InspireSearchExportMetaV1 {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  query: string;
  sort?: string;
  page_size: number;
  max_results: number;
  output_format: SearchExportFormatV1;
  total: number;
  exported: number;
  pages_fetched: number;
  has_more: boolean;
  next_url?: string;
  warnings: string[];
  artifacts: {
    export_uri: string;
    meta_uri: string;
    diagnostics_uri?: string;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function runArtifactUri(runId: string, artifactName: string): string {
  return `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactName)}`;
}

function makeArtifactNames(params: {
  query: string;
  sort?: string;
  page_size: number;
  max_results: number;
  output_format: SearchExportFormatV1;
  artifact_name?: string;
  meta_artifact_name?: string;
}): { exportName: string; metaName: string } {
  const ext = params.output_format === 'jsonl' ? 'jsonl' : 'json';
  if (params.artifact_name && params.meta_artifact_name) {
    return { exportName: params.artifact_name, metaName: params.meta_artifact_name };
  }

  const material = JSON.stringify({
    query: params.query,
    sort: params.sort ?? null,
    page_size: params.page_size,
    max_results: params.max_results,
    output_format: params.output_format,
  });
  const hash = sha256Hex(material).slice(0, 16);
  return {
    exportName: params.artifact_name ?? `inspire_search_export_${hash}.${ext}`,
    metaName: params.meta_artifact_name ?? `inspire_search_export_${hash}_meta.json`,
  };
}

function preprocessQuery(query: string): string {
  return query.replace(/\ba:["']([^"']+)["']/gi, 'a:$1');
}

function artifactRef(runId: string, name: string, mimeType: string): RunArtifactRef {
  return { name, uri: runArtifactUri(runId, name), mimeType };
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

export async function hepInspireSearchExport(params: {
  run_id: string;
  query: string;
  sort?: string;
  size: number;
  max_results: number;
  output_format: SearchExportFormatV1;
  artifact_name?: string;
  meta_artifact_name?: string;
  budget_hints?: {
    size_provided?: boolean;
    max_results_provided?: boolean;
  };
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  export_uri: string;
  meta_uri: string;
  summary: {
    total: number;
    exported: number;
    pages_fetched: number;
    has_more: boolean;
    warnings_total: number;
    warnings: string[];
  };
}> {
  const runId = params.run_id;
  const run = getRun(runId);

  const { stepIndex, step } = await startRunStep(runId, 'inspire_search_export');

  const artifacts: RunArtifactRef[] = [];
  const warnings: string[] = [];
  const budget = new BudgetTrackerV1();

  const pageSize = budget.resolveInt({
    key: 'inspire.search_export.page_size',
    dimension: 'breadth',
    unit: 'items',
    arg_path: 'size',
    tool_value: params.size,
    tool_value_present: params.budget_hints?.size_provided ?? true,
    env_var: 'HEP_BUDGET_INSPIRE_SEARCH_PAGE_SIZE',
    default_value: 1000,
    min: 1,
    max: 1000,
  });

  const maxResults = budget.resolveInt({
    key: 'inspire.search_export.max_results',
    dimension: 'breadth',
    unit: 'items',
    arg_path: 'max_results',
    tool_value: params.max_results,
    tool_value_present: params.budget_hints?.max_results_provided ?? true,
    env_var: 'HEP_BUDGET_INSPIRE_SEARCH_MAX_RESULTS',
    default_value: 10_000,
    min: 1,
    max: 10_000,
  });

  const outputFormat: SearchExportFormatV1 = params.output_format;
  const query = preprocessQuery(params.query);

  const namingMaterial = JSON.stringify({
    query,
    sort: params.sort ?? null,
    page_size: pageSize,
    max_results: maxResults,
    output_format: outputFormat,
  });
  const exportKeyHash = sha256Hex(namingMaterial).slice(0, 16);

  const { exportName, metaName } = makeArtifactNames({
    query,
    sort: params.sort,
    page_size: pageSize,
    max_results: maxResults,
    output_format: outputFormat,
    artifact_name: params.artifact_name,
    meta_artifact_name: params.meta_artifact_name,
  });

  const exportUri = runArtifactUri(runId, exportName);
  const metaUri = runArtifactUri(runId, metaName);

  let exported = 0;
  let pagesFetched = 0;
  let total = 0;
  let nextUrl: string | undefined;
  let truncatedMidPage = false;
  const externalApiCalls: ExternalApiCallIndexItemV1[] = [];

  const exportPath = getRunArtifactPath(runId, exportName);
  const out = fs.createWriteStream(exportPath, { encoding: 'utf-8' });
  let wroteAny = false;

  const writeItem = (paper: unknown) => {
    if (outputFormat === 'jsonl') {
      out.write(`${JSON.stringify(paper)}\n`);
      return;
    }

    if (wroteAny) out.write(',\n');
    out.write(JSON.stringify(paper));
    wroteAny = true;
  };

  try {
    if (outputFormat === 'json') {
      out.write('[\n');
    }

    let pageRes = await (async () => {
      const cached = await cachedExternalApiJsonCall({
        run_id: runId,
        namespace: 'inspire',
        operation: 'search',
        request: { query, sort: params.sort ?? null, size: pageSize, page: 1 },
        fetch: () => api.search(query, { sort: params.sort, size: pageSize, page: 1 }),
      });
      const [requestRef, responseRef] = cached.artifacts;
      externalApiCalls.push({
        version: 1,
        namespace: 'inspire',
        operation: 'search',
        request_hash: cached.request_hash,
        cache_hit: cached.cache_hit,
        cached_response_uri: cached.cached_response_uri,
        request_uri: requestRef.uri,
        response_uri: responseRef.uri,
      });
      return cached.response;
    })();
    pagesFetched += 1;
    total = pageRes.total;

    if (pageRes.warning) {
      warnings.push(pageRes.warning);
      budget.warn({ severity: 'warning', code: 'inspire_api_limit', message: pageRes.warning });
    }

    while (true) {
      const remaining = maxResults - exported;
      const batch = pageRes.papers.slice(0, Math.max(0, remaining));
      for (const paper of batch) {
        writeItem(paper);
        exported += 1;
      }

      if (pageRes.papers.length > batch.length) {
        truncatedMidPage = true;
      }

      nextUrl = pageRes.next_url;

      if (exported >= maxResults) break;
      if (!pageRes.has_more) break;
      if (!nextUrl) break;

      const url = nextUrl;
      pageRes = await (async () => {
        const cached = await cachedExternalApiJsonCall({
          run_id: runId,
          namespace: 'inspire',
          operation: 'searchByUrl',
          request: { url },
          fetch: () => api.searchByUrl(url),
        });
        const [requestRef, responseRef] = cached.artifacts;
        externalApiCalls.push({
          version: 1,
          namespace: 'inspire',
          operation: 'searchByUrl',
          request_hash: cached.request_hash,
          cache_hit: cached.cache_hit,
          cached_response_uri: cached.cached_response_uri,
          request_uri: requestRef.uri,
          response_uri: responseRef.uri,
        });
        return cached.response;
      })();
      pagesFetched += 1;
      if (pageRes.papers.length === 0) break;
    }

    if (outputFormat === 'json') {
      out.write('\n]\n');
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
      // ignore secondary failures
    }
    throw err;
  }

  await new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.on('finish', resolve);
    out.end();
  });

  const hasMore = Boolean(nextUrl) && total > exported;

  if (total > exported) {
    const msg = `INSPIRE search export truncated at max_results=${maxResults} (total=${total}, exported=${exported}).`;
    warnings.push(msg);
    budget.recordHit({
      key: 'inspire.search_export.max_results',
      dimension: 'breadth',
      unit: 'items',
      limit: maxResults,
      observed: total,
      action: 'truncate',
      message: msg,
      data: { total, exported, truncated_mid_page: truncatedMidPage },
    });
  }

  if (truncatedMidPage) {
    const msg = 'Export stopped mid-page due to max_results; rerun with a higher max_results to avoid partial pagination.';
    warnings.push(msg);
    budget.warn({ severity: 'warning', code: 'pagination_mid_page_truncation', message: msg });
  }

  const exportRef = artifactRef(
    runId,
    exportName,
    outputFormat === 'jsonl' ? 'application/x-ndjson' : 'application/json'
  );
  artifacts.push(exportRef);

  const externalApiCallsName = `external_api_calls_inspire_search_export_${exportKeyHash}.json`;
  const externalApiCallsRef = writeRunJsonArtifact(runId, externalApiCallsName, {
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

  const diag = writeRunStepDiagnosticsArtifact({
    run_id: runId,
    project_id: run.project_id,
    step: step.step,
    step_index: stepIndex,
    ...budget.snapshot(),
  });
  artifacts.push(diag.run, diag.project);

  const metaPayload: InspireSearchExportMetaV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    query,
    sort: params.sort,
    page_size: pageSize,
    max_results: maxResults,
    output_format: outputFormat,
    total,
    exported,
    pages_fetched: pagesFetched,
    has_more: hasMore,
    next_url: hasMore ? nextUrl : undefined,
    warnings,
    artifacts: {
      export_uri: exportUri,
      meta_uri: metaUri,
      diagnostics_uri: diag.run.uri,
    },
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
    manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
    artifacts,
    export_uri: exportRef.uri,
    meta_uri: metaRef.uri,
    summary: {
      total,
      exported,
      pages_fetched: pagesFetched,
      has_more: hasMore,
      warnings_total: warnings.length,
      warnings: warnings.slice(0, 20),
    },
  };
}
