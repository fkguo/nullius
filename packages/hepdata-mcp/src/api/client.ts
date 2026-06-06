import { notFound, upstreamError } from '@autoresearch/shared';
import { hepdataFetch } from './rateLimiter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HepDataSearchResult {
  total: number;
  results: Array<{
    hepdata_id: number;
    title: string;
    inspire_recid: number | null;
    arxiv_id: string | null;
    collaborations: string[];
    data_tables_count: number;
    doi: string | null;
  }>;
}

export interface HepDataRecord {
  hepdata_id: number;
  title: string;
  inspire_recid: number | null;
  arxiv_id: string | null;
  doi: string | null;
  hepdata_doi: string | null;
  collaborations: string[];
  abstract: string;
  data_tables: Array<{ table_id: number; name: string; doi: string | null }>;
}

export interface HepDataTableData {
  name: string;
  description: string;
  doi: string | null;
  headers: Array<{ name: string; colspan: number }>;
  values: Array<{
    x: Array<{ value?: string; low?: string; high?: string }>;
    y: Array<{
      value: string | number;
      errors?: Array<{
        label?: string;
        symerror?: number | string;
        asymerror?: { plus: number | string; minus: number | string };
      }>;
      group?: number;
    }>;
  }>;
}

export interface SearchParams {
  inspire_recid?: number;
  arxiv_id?: string;
  doi?: string;
  query?: string;
  reactions?: string;
  collaboration?: string;
  observables?: string;
  phrases?: string;
  cmenergies?: string;
  subject_areas?: string;
  sort_by?: 'relevance' | 'collaborations' | 'title' | 'date' | 'latest';
  page?: number;
  size?: number;
  max_results?: number;
}

// HARD upper bound on bounded auto-pagination. Requests above this are clamped
// down to this value so a single search can never trigger an unbounded crawl.
export const HEPDATA_MAX_RESULTS_CAP = 200;

function normalizeInspireRecid(value: unknown): number | null {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return value;
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// API functions
// ─────────────────────────────────────────────────────────────────────────────

type RawSearchResult = {
  id: number;
  title: string;
  inspire_id: string | number | null;
  arxiv_id: string | null;
  collaborations: string[];
  total_tables: number;
  doi: string | null;
};

function buildSearchQuery(params: SearchParams, page: number, size: number): URLSearchParams {
  const qs = new URLSearchParams({
    page: String(page),
    size: String(size),
    format: 'json',
  });

  if (params.inspire_recid != null) {
    qs.set('q', `ins${params.inspire_recid}`);
  } else if (params.arxiv_id != null) {
    qs.set('q', params.arxiv_id.replace(/^arXiv:/i, '').trim());
  } else if (params.doi != null) {
    qs.set('q', params.doi);
  } else if (params.query != null) {
    qs.set('q', params.query);
  }

  if (params.reactions != null)     qs.set('reactions', params.reactions);
  if (params.collaboration != null) qs.set('collaboration', params.collaboration);
  if (params.observables != null)   qs.set('observables', params.observables);
  if (params.phrases != null)       qs.set('phrases', params.phrases);
  if (params.cmenergies != null)    qs.set('cmenergies', params.cmenergies);
  if (params.subject_areas != null) qs.set('subject_areas', params.subject_areas);
  if (params.sort_by != null)       qs.set('sort_by', params.sort_by);

  return qs;
}

function normalizeSearchResult(r: RawSearchResult): HepDataSearchResult['results'][number] {
  return {
    hepdata_id: r.id,
    title: r.title,
    inspire_recid: normalizeInspireRecid(r.inspire_id),
    arxiv_id: r.arxiv_id ?? null,
    collaborations: r.collaborations ?? [],
    data_tables_count: r.total_tables ?? 0,
    doi: r.doi ?? null,
  };
}

/** Fetch one search page. `total` is HEPData's overall match count for the query. */
async function fetchSearchPage(
  params: SearchParams,
  page: number,
  size: number,
): Promise<{ total: number; raw: RawSearchResult[] }> {
  const qs = buildSearchQuery(params, page, size);
  const response = await hepdataFetch(`/search/?${qs}`);
  if (!response.ok) {
    throw upstreamError(`HEPData search failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as { total: number; results: RawSearchResult[] };
  return { total: data.total, raw: data.results ?? [] };
}

export async function searchRecords(params: SearchParams): Promise<HepDataSearchResult> {
  const size = Math.min(params.size ?? 10, 25);
  const startPage = params.page ?? 1;

  // Bounded auto-pagination: when max_results exceeds one page, walk forward
  // page-by-page (each call naturally rate-limited) accumulating results until
  // we have enough or a short page tells us HEPData has no more matches.
  const cap = Math.min(params.max_results ?? size, HEPDATA_MAX_RESULTS_CAP);

  const first = await fetchSearchPage(params, startPage, size);
  const accumulated: RawSearchResult[] = [...first.raw];

  // Stop conditions: cap reached, the page came back short (no more data), or
  // the page was empty. The short-page check uses the requested `size`.
  let page = startPage;
  let lastPageLen = first.raw.length;
  while (accumulated.length < cap && lastPageLen >= size && lastPageLen > 0) {
    page += 1;
    const next = await fetchSearchPage(params, page, size);
    lastPageLen = next.raw.length;
    if (lastPageLen === 0) break;
    accumulated.push(...next.raw);
  }

  return {
    total: first.total,
    results: accumulated.slice(0, cap).map(normalizeSearchResult),
  };
}

export async function getRecord(hepdataId: number): Promise<HepDataRecord> {
  const response = await hepdataFetch(`/record/${hepdataId}?format=json`);
  if (response.status === 404) throw notFound(`HEPData record not found: ${hepdataId}`);
  if (!response.ok) throw upstreamError(`HEPData record fetch failed: ${response.status}`);

  type RawRecord = {
    recid: number;
    record: {
      title: string;
      inspire_id: string | number | null;
      arxiv_id: string | null;
      doi: string | null;
      hepdata_doi: string | null;
      collaborations: string[];
      abstract?: string;
      data_abstract?: string;
    };
    data_tables: Array<{ id: number; name: string; doi: string | null }>;
  };
  const data = await response.json() as RawRecord;
  const rec = data.record;

  return {
    hepdata_id: data.recid,
    title: rec.title,
    inspire_recid: normalizeInspireRecid(rec.inspire_id),
    arxiv_id: rec.arxiv_id ?? null,
    doi: rec.doi ?? null,
    hepdata_doi: rec.hepdata_doi ?? null,
    collaborations: rec.collaborations ?? [],
    abstract: rec.abstract ?? rec.data_abstract ?? '',
    data_tables: (data.data_tables ?? []).map(t => ({
      table_id: t.id,
      name: t.name,
      doi: t.doi ?? null,
    })),
  };
}

export async function getTable(
  tableId: number,
  format: 'json' | 'yaml' | 'csv',
): Promise<HepDataTableData | string> {
  const response = await hepdataFetch(`/download/table/${tableId}/${format}`);
  if (response.status === 404) throw notFound(`HEPData table not found: ${tableId}`);
  if (!response.ok) throw upstreamError(`HEPData table fetch failed: ${response.status}`);

  // Text-renderable non-json formats are returned verbatim.
  if (format === 'yaml' || format === 'csv') return response.text();

  type RawTable = {
    name: string;
    description: string;
    doi: string | null;
    headers: Array<{ name: string; colspan: number }>;
    values: HepDataTableData['values'];
  };
  const data = await response.json() as RawTable;

  return {
    name: data.name,
    description: data.description,
    doi: data.doi ?? null,
    headers: data.headers ?? [],
    values: data.values ?? [],
  };
}

export type HepDataDownloadFormat =
  | 'original'
  | 'json'
  | 'csv'
  | 'root'
  | 'yaml'
  | 'yoda'
  | 'yoda1'
  | 'yoda.h5';

export async function downloadSubmission(
  hepdataId: number,
  format: HepDataDownloadFormat = 'original',
): Promise<ArrayBuffer> {
  // `original` keeps the historical submission-zip path; every other format
  // is a sibling on the same /download/submission/{id}/{format} endpoint.
  const response = await hepdataFetch(`/download/submission/${hepdataId}/${format}`);
  if (response.status === 404) throw notFound(`HEPData submission not found: ${hepdataId}`);
  if (!response.ok) throw upstreamError(`HEPData download failed: ${response.status}`);
  return response.arrayBuffer();
}
