/**
 * OpenAlex API client functions.
 *
 * All functions go through the rate-limited singleton fetcher.
 * Pagination uses cursor-based mode exclusively (never page-based beyond page 1)
 * to avoid the OpenAlex 10k page-based limit.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { invalidParams, notFound, upstreamError } from '@autoresearch/shared';
import { openalexFetch, getCostSummary, getResponseMeta, isBudgetExceeded } from './rateLimiter.js';
import { buildQueryParams } from './paramMapping.js';
import { augmentSelect } from './selectAugment.js';
import { detectIdentifier } from './identifiers.js';
import type {
  OpenAlexListResponse,
  OpenAlexGroupByEntry,
  OpenAlexAutocompleteResponse,
  OpenAlexEntity,
  Work,
} from './types.js';

// ── Data directory ────────────────────────────────────────────────────────────

function expandTilde(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

export function getDataDir(): string {
  const explicit = process.env.OPENALEX_DATA_DIR;
  if (explicit?.trim().length) return path.resolve(expandTilde(explicit));
  const hepDataDir = process.env.HEP_DATA_DIR;
  if (hepDataDir?.trim().length) return path.resolve(path.join(expandTilde(hepDataDir), 'openalex'));
  return path.resolve(path.join(os.homedir(), '.autoresearch', 'openalex'));
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Response parsing ──────────────────────────────────────────────────────────

async function parseJson<T>(response: Response, context: string): Promise<T> {
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw upstreamError(`${context}: failed to read response body`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const snippet = text.slice(0, 200);
    throw upstreamError(`${context}: invalid JSON from OpenAlex: ${snippet}`);
  }
}

async function assertOk(response: Response, context: string): Promise<void> {
  if (response.ok) return;
  if (response.status === 404) {
    throw notFound(`${context}: not found (HTTP 404)`);
  }
  if (response.status === 400) {
    let msg = `${context}: bad request (HTTP 400)`;
    try {
      const body = await response.json() as { message?: string; error?: string };
      if (body.message) msg = `${context}: ${body.message}`;
      else if (body.error) msg = `${context}: ${body.error}`;
    } catch {}
    throw invalidParams(msg);
  }
  if (response.status === 401) {
    throw invalidParams(`${context}: invalid or missing API key (HTTP 401)`);
  }
  if (response.status === 403) {
    throw invalidParams(`${context}: quota exhausted or forbidden (HTTP 403)`);
  }
  throw upstreamError(`${context}: HTTP ${response.status}`);
}

// ── Pagination result types ───────────────────────────────────────────────────

export interface PaginatedResult<T> {
  total_count: number;
  returned_count: number;
  complete: boolean;
  stop_reason?: 'max_results' | 'budget_exceeded' | 'rate_limited' | 'end_of_results';
  results?: T[];
  results_file?: string;
  cursor?: string;
  has_more: boolean;
  cost: ReturnType<typeof getCostSummary>;
  _meta: ReturnType<typeof getResponseMeta>;
}

interface PaginationOptions {
  perPage: number;
  page?: number;
  cursor?: string;
  maxResults?: number;
  dataDir?: string;
}

// ── Core pagination engine ────────────────────────────────────────────────────

async function paginatedFetch<T>(
  basePath: string,
  baseParams: URLSearchParams,
  opts: PaginationOptions,
): Promise<PaginatedResult<T>> {
  const { perPage, page, cursor: initialCursor, maxResults, dataDir } = opts;
  // isInteractive = true when no explicit maxResults, or maxResults fits in a single page
  // (maxResults === perPage also uses single-page to avoid a needless second request)
  const isInteractive = !maxResults || maxResults <= perPage;

  // Build base params
  const qs = new URLSearchParams(baseParams);
  qs.set('per-page', String(perPage));

  if (isInteractive) {
    // Single-page request
    if (initialCursor) {
      qs.set('cursor', initialCursor);
    } else if (page && page > 1) {
      qs.set('page', String(page));
    } else {
      // Use cursor for first page too (enables continuation)
      qs.set('cursor', '*');
    }

    const response = await openalexFetch(`${basePath}?${qs}`);
    await assertOk(response, `openalex ${basePath}`);
    const data = await parseJson<OpenAlexListResponse<T>>(response, `openalex ${basePath}`);

    const nextCursor = data.meta.next_cursor ?? undefined;
    const hasMore = Boolean(nextCursor);
    const totalCount = data.meta.count ?? 0;

    return {
      total_count: totalCount,
      returned_count: data.results.length,
      complete: true,
      stop_reason: hasMore ? undefined : 'end_of_results',
      results: data.results,
      cursor: nextCursor,
      has_more: hasMore,
      cost: getCostSummary(),
      _meta: getResponseMeta(),
    };
  }

  // Bulk mode: auto-paginate via cursor, write JSONL to file
  const resultsDir = path.join(dataDir ?? getDataDir(), 'results');
  ensureDir(resultsDir);
  const fileId = crypto.randomUUID();
  const outFile = path.join(resultsDir, `${fileId}.jsonl`);
  const tmpFile = `${outFile}.tmp`;

  let collected = 0;
  let totalCount = 0;
  let currentCursor: string | null = initialCursor ?? '*';
  let stopReason: PaginatedResult<T>['stop_reason'] = 'max_results';
  let complete = false;

  const fd = fs.openSync(tmpFile, 'w');
  try {
    while (collected < maxResults && currentCursor != null) {
      if (isBudgetExceeded()) {
        stopReason = 'budget_exceeded';
        break;
      }

      const pageQs = new URLSearchParams(qs);
      pageQs.set('cursor', currentCursor);

      let response: Response;
      try {
        response = await openalexFetch(`${basePath}?${pageQs}`);
        await assertOk(response, `openalex ${basePath}`);
      } catch (err) {
        // Treat rate-limit during bulk fetch as partial success
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('rate limit') || msg.includes('rate_limit')) {
          stopReason = 'rate_limited';
          break;
        }
        throw err;
      }

      const data = await parseJson<OpenAlexListResponse<T>>(response, `openalex ${basePath}`);
      if (collected === 0) totalCount = data.meta.count ?? 0;

      for (const item of data.results) {
        if (collected >= maxResults) break;
        fs.writeSync(fd, JSON.stringify(item) + '\n');
        collected++;
      }

      currentCursor = data.meta.next_cursor ?? null;
      if (!currentCursor) {
        stopReason = 'end_of_results';
        complete = true;
        break;
      }
    }

    if (collected >= maxResults && currentCursor != null) {
      stopReason = 'max_results';
      complete = false;
    }
  } finally {
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  }

  fs.renameSync(tmpFile, outFile);
  // fsync parent directory AFTER rename to durably commit the new directory entry
  const dirFd = fs.openSync(resultsDir, 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }

  return {
    total_count: totalCount,
    returned_count: collected,
    complete,
    stop_reason: stopReason,
    results_file: outFile,
    has_more: currentCursor != null,
    cost: getCostSummary(),
    _meta: getResponseMeta(),
  };
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

import type { z } from 'zod';
import type {
  OpenAlexSearchSchema,
  OpenAlexSemanticSearchSchema,
  OpenAlexGetSchema,
  OpenAlexFilterSchema,
  OpenAlexGroupSchema,
  OpenAlexReferencesSchema,
  OpenAlexCitationsSchema,
  OpenAlexBatchSchema,
  OpenAlexAutocompleteSchema,
} from '../tools/schemas.js';

export async function handleSearch(
  args: z.output<typeof OpenAlexSearchSchema>,
): Promise<PaginatedResult<Work>> {
  const qs = buildQueryParams({
    search: args.query,
    filter: args.filter,
    sort: args.sort,
    select: augmentSelect(args.select, 'works'),
    ...(args.sample != null ? { sample: args.sample } : {}),
    ...(args.seed != null ? { seed: args.seed } : {}),
  });

  return paginatedFetch<Work>('/works', qs, {
    perPage: args.per_page,
    page: args.cursor ? undefined : args.page,
    cursor: args.cursor,
    maxResults: args.max_results,
  });
}

export async function handleSemanticSearch(
  args: z.output<typeof OpenAlexSemanticSearchSchema>,
): Promise<PaginatedResult<Work>> {
  const qs = buildQueryParams({
    q: args.query,
    filter: args.filter,
    select: augmentSelect(args.select, 'works'),
  });

  return paginatedFetch<Work>('/works', qs, {
    perPage: args.per_page,
    page: args.page,
  });
}

export async function handleGet(
  args: z.output<typeof OpenAlexGetSchema>,
): Promise<{ entity_type: string; result: OpenAlexEntity; cost: ReturnType<typeof getCostSummary> }> {
  const detected = detectIdentifier(args.id);
  const entityType = args.entity ?? detected?.entity ?? 'works';

  // Build the lookup path
  const entityPath = `/${entityType}`;
  const normalized = detected?.normalized ?? args.id;

  const qs = new URLSearchParams();
  // Use the direct entity lookup for OpenAlex IDs; filter for others
  let path: string;
  if (detected?.type === 'openalex' || detected?.type === 'openalex_url') {
    const id = detected.type === 'openalex_url'
      ? normalized.split('/').pop() ?? normalized
      : normalized;
    path = `${entityPath}/${id}`;
    if (args.select) qs.set('select', augmentSelect(args.select, entityType) ?? '');
  } else {
    // Use filter for DOI, ORCID, ROR, ISSN, PMID
    const filterField = detected?.type === 'doi' ? 'doi'
      : detected?.type === 'orcid' ? 'orcid'
      : detected?.type === 'ror' ? 'ror'
      : detected?.type === 'issn' ? 'issn'
      : detected?.type === 'pmid' ? 'ids.pmid'
      : 'ids.openalex';
    const filterValue = detected?.type === 'doi'
      ? `https://doi.org/${normalized.slice(4)}` // doi:10.xxx -> https://doi.org/10.xxx
      : detected?.type === 'pmid'
      ? normalized.slice(5) // pmid:12345 -> 12345
      : normalized;
    qs.set('filter', `${filterField}:${filterValue}`);
    if (args.select) qs.set('select', augmentSelect(args.select, entityType) ?? '');
    path = entityPath;
  }

  const queryStr = qs.toString();
  const response = await openalexFetch(`${path}${queryStr ? `?${queryStr}` : ''}`);
  await assertOk(response, `openalex_get ${args.id}`);
  const data = await parseJson<OpenAlexEntity | OpenAlexListResponse<OpenAlexEntity>>(
    response, `openalex_get ${args.id}`,
  );

  // Direct lookup returns the entity; filter returns a list
  let result: OpenAlexEntity;
  if ('results' in data && Array.isArray(data.results)) {
    if (data.results.length === 0) throw notFound(`Entity not found: ${args.id}`);
    result = data.results[0] as OpenAlexEntity;
  } else {
    result = data as OpenAlexEntity;
  }

  return { entity_type: entityType, result, cost: getCostSummary() };
}

export async function handleFilter(
  args: z.output<typeof OpenAlexFilterSchema>,
): Promise<PaginatedResult<OpenAlexEntity>> {
  const qs = buildQueryParams({
    filter: args.filter,
    search: args.search,
    sort: args.sort,
    select: augmentSelect(args.select, args.entity),
  });

  return paginatedFetch<OpenAlexEntity>(`/${args.entity}`, qs, {
    perPage: args.per_page,
    page: args.cursor ? undefined : args.page,
    cursor: args.cursor,
    maxResults: args.max_results,
  });
}

export async function handleGroup(
  args: z.output<typeof OpenAlexGroupSchema>,
): Promise<{
  entity_type: string;
  group_by: string;
  groups: OpenAlexGroupByEntry[];
  total_groups: number;
  cost: ReturnType<typeof getCostSummary>;
}> {
  const qs = buildQueryParams({
    group_by: args.group_by,
    filter: args.filter,
  });

  const response = await openalexFetch(`/${args.entity}?${qs}`);
  await assertOk(response, `openalex_group ${args.entity}`);
  const data = await parseJson<OpenAlexListResponse<OpenAlexEntity>>(
    response, `openalex_group ${args.entity}`,
  );

  return {
    entity_type: args.entity,
    group_by: args.group_by,
    groups: data.group_by ?? [],
    total_groups: data.meta.groups_count ?? (data.group_by?.length ?? 0),
    cost: getCostSummary(),
  };
}

export async function handleReferences(
  args: z.output<typeof OpenAlexReferencesSchema>,
): Promise<PaginatedResult<Work>> {
  // Resolve to a short OpenAlex work ID
  const detected = detectIdentifier(args.work_id);
  let workId: string;
  if (detected?.type === 'openalex') {
    workId = detected.normalized;
  } else if (detected?.type === 'openalex_url') {
    workId = detected.normalized.split('/').pop() ?? args.work_id;
  } else {
    // Resolve by DOI etc. first
    const getResult = await handleGet({ id: args.work_id });
    workId = String((getResult.result as Record<string, unknown>).id ?? args.work_id)
      .split('/').pop() ?? args.work_id;
  }

  // Fetch the work to get its outgoing reference IDs (referenced_works field).
  // filter=referenced_works:W returns INCOMING citations; to get OUTGOING references
  // we must read the work's referenced_works array directly.
  const workResponse = await openalexFetch(`/works/${workId}?select=id,referenced_works`);
  await assertOk(workResponse, `openalex_references_fetch ${workId}`);
  const workData = await parseJson<{ id: string; referenced_works?: string[] }>(
    workResponse, `openalex_references_fetch ${workId}`,
  );
  const refUrls = workData.referenced_works ?? [];

  if (refUrls.length === 0) {
    return {
      total_count: 0,
      returned_count: 0,
      complete: true,
      stop_reason: 'end_of_results',
      results: [],
      has_more: false,
      cost: getCostSummary(),
      _meta: getResponseMeta(),
    };
  }

  // Strip to short IDs (https://openalex.org/W123 → W123)
  const shortIds = refUrls.map(id => String(id).split('/').pop() ?? id);

  // Fetch referenced works in chunks to respect OpenAlex OR filter limit (~100 values).
  // Uses BATCH_CHUNK_SIZE (50) for safety margin and consistency with handleBatch.
  const allResults: Work[] = [];
  for (let i = 0; i < shortIds.length; i += BATCH_CHUNK_SIZE) {
    const chunk = shortIds.slice(i, i + BATCH_CHUNK_SIZE);
    const qs = buildQueryParams({
      filter: `ids.openalex:${chunk.join('|')}`,
      select: augmentSelect(args.select, 'works'),
    });
    qs.set('per-page', String(chunk.length));
    const chunkResponse = await openalexFetch(`/works?${qs}`);
    await assertOk(chunkResponse, `openalex_references_chunk_${i}`);
    const chunkData = await parseJson<OpenAlexListResponse<Work>>(
      chunkResponse, `openalex_references_chunk_${i}`,
    );
    allResults.push(...chunkData.results);
  }

  return {
    total_count: shortIds.length,
    returned_count: allResults.length,
    complete: true,
    stop_reason: 'end_of_results',
    results: allResults,
    has_more: false,
    cost: getCostSummary(),
    _meta: getResponseMeta(),
  };
}

export async function handleCitations(
  args: z.output<typeof OpenAlexCitationsSchema>,
): Promise<PaginatedResult<Work>> {
  const detected = detectIdentifier(args.work_id);
  let workId: string;
  if (detected?.type === 'openalex') {
    workId = detected.normalized;
  } else if (detected?.type === 'openalex_url') {
    workId = detected.normalized.split('/').pop() ?? args.work_id;
  } else {
    const getResult = await handleGet({ id: args.work_id });
    workId = String((getResult.result as Record<string, unknown>).id ?? args.work_id)
      .split('/').pop() ?? args.work_id;
  }

  const citesFilter = args.filter
    ? `cites:${workId},${args.filter}`
    : `cites:${workId}`;
  const qs = buildQueryParams({
    filter: citesFilter,
    sort: args.sort,
    select: augmentSelect(args.select, 'works'),
  });

  return paginatedFetch<Work>('/works', qs, {
    perPage: args.per_page,
    page: args.cursor ? undefined : args.page,
    cursor: args.cursor,
    maxResults: args.max_results,
  });
}

// Batch lookup chunk size — OpenAlex pipe-OR has a URL length limit (~4000 bytes)
const BATCH_CHUNK_SIZE = 50;

/** Maps OpenAlex entity ID prefix to its REST endpoint segment. */
const OPENALEX_PREFIX_ENDPOINT: Record<string, string> = {
  W: 'works',
  A: 'authors',
  S: 'sources',
  I: 'institutions',
  T: 'topics',
  P: 'publishers',
  F: 'funders',
  C: 'concepts',
};

function openalexEndpoint(normalizedId: string): string {
  const prefix = normalizedId[0]?.toUpperCase() ?? 'W';
  return OPENALEX_PREFIX_ENDPOINT[prefix] ?? 'works';
}

export async function handleBatch(
  args: z.output<typeof OpenAlexBatchSchema>,
): Promise<{
  total_requested: number;
  total_found: number;
  results: Array<{ id_input: string; status: 'found' | 'not_found' | 'error'; result?: OpenAlexEntity; error?: string }>;
  cost: ReturnType<typeof getCostSummary>;
}> {
  const results: Array<{ id_input: string; status: 'found' | 'not_found' | 'error'; result?: OpenAlexEntity; error?: string }> = [];

  // Group IDs into chunks to avoid URL length overflow
  for (let i = 0; i < args.ids.length; i += BATCH_CHUNK_SIZE) {
    const chunk = args.ids.slice(i, i + BATCH_CHUNK_SIZE);

    // Build pipe-OR filter for OpenAlex IDs; handle others individually
    const openalexIds: string[] = [];
    const otherIds: string[] = [];
    for (const id of chunk) {
      const detected = detectIdentifier(id);
      if (detected?.type === 'openalex' || detected?.type === 'openalex_url') {
        openalexIds.push(detected.normalized);
      } else if (detected?.type === 'doi') {
        otherIds.push(id);
      } else {
        otherIds.push(id);
      }
    }

    // Fetch OpenAlex-ID batch — group by entity type (W→works, A→authors, etc.)
    if (openalexIds.length > 0) {
      // Group IDs by their entity endpoint
      const byEndpoint: Map<string, string[]> = new Map();
      for (const id of openalexIds) {
        const shortId = id.split('/').pop() ?? id;
        const ep = openalexEndpoint(shortId);
        const existing = byEndpoint.get(ep);
        if (existing) { existing.push(id); } else { byEndpoint.set(ep, [id]); }
      }

      for (const [endpoint, idsForEndpoint] of byEndpoint) {
        try {
          // Correct OR syntax: ids.openalex:W1|W2|W3
          const filterVal = `ids.openalex:${idsForEndpoint.join('|')}`;
          const qs = buildQueryParams({
            filter: filterVal,
            per_page: idsForEndpoint.length,
            select: augmentSelect(args.select, endpoint),
          });
          const response = await openalexFetch(`/${endpoint}?${qs}`);
          await assertOk(response, 'openalex_batch');
          const data = await parseJson<OpenAlexListResponse<OpenAlexEntity>>(response, 'openalex_batch');
          for (const id of idsForEndpoint) {
            const shortId = id.split('/').pop()?.toLowerCase() ?? id;
            // Use exact path-segment match (not includes) to avoid W1 matching W10, W100, etc.
            const found = data.results.find(r => String(r.id).split('/').pop()?.toLowerCase() === shortId);
            if (found) {
              results.push({ id_input: id, status: 'found', result: found });
            } else {
              results.push({ id_input: id, status: 'not_found' });
            }
          }
        } catch (err) {
          for (const id of idsForEndpoint) {
            results.push({ id_input: id, status: 'error', error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    }

    // Fetch others individually
    for (const id of otherIds) {
      try {
        const r = await handleGet({ id, select: augmentSelect(args.select, 'works') });
        results.push({ id_input: id, status: 'found', result: r.result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found') || msg.includes('404')) {
          results.push({ id_input: id, status: 'not_found' });
        } else {
          results.push({ id_input: id, status: 'error', error: msg });
        }
      }
    }
  }

  return {
    total_requested: args.ids.length,
    total_found: results.filter(r => r.status === 'found').length,
    results,
    cost: getCostSummary(),
  };
}

export async function handleAutocomplete(
  args: z.output<typeof OpenAlexAutocompleteSchema>,
): Promise<{ entity_type: string; results: OpenAlexAutocompleteResponse['results']; cost: ReturnType<typeof getCostSummary> }> {
  const qs = new URLSearchParams({ q: args.query });
  const response = await openalexFetch(`/autocomplete/${args.entity}?${qs}`);
  await assertOk(response, `openalex_autocomplete ${args.entity}`);
  const data = await parseJson<OpenAlexAutocompleteResponse>(response, `openalex_autocomplete ${args.entity}`);

  return {
    entity_type: args.entity,
    results: data.results,
    cost: getCostSummary(),
  };
}
