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
}

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

export async function searchRecords(params: SearchParams): Promise<HepDataSearchResult> {
  const qs = new URLSearchParams({
    page: String(params.page ?? 1),
    size: String(Math.min(params.size ?? 10, 25)),
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

  const response = await hepdataFetch(`/search/?${qs}`);
  if (!response.ok) {
    throw upstreamError(`HEPData search failed: ${response.status} ${response.statusText}`);
  }

  type RawResult = {
    id: number;
    title: string;
    inspire_id: string | number | null;
    arxiv_id: string | null;
    collaborations: string[];
    total_tables: number;
    doi: string | null;
  };
  const data = await response.json() as { total: number; results: RawResult[] };

  return {
    total: data.total,
    results: (data.results ?? []).map(r => ({
      hepdata_id: r.id,
      title: r.title,
      inspire_recid: normalizeInspireRecid(r.inspire_id),
      arxiv_id: r.arxiv_id ?? null,
      collaborations: r.collaborations ?? [],
      data_tables_count: r.total_tables ?? 0,
      doi: r.doi ?? null,
    })),
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

export async function getTable(tableId: number, format: 'json' | 'yaml'): Promise<HepDataTableData | string> {
  const response = await hepdataFetch(`/download/table/${tableId}/${format}`);
  if (response.status === 404) throw notFound(`HEPData table not found: ${tableId}`);
  if (!response.ok) throw upstreamError(`HEPData table fetch failed: ${response.status}`);

  if (format === 'yaml') return response.text();

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

export async function downloadSubmission(hepdataId: number): Promise<ArrayBuffer> {
  const response = await hepdataFetch(`/download/submission/${hepdataId}/original`);
  if (response.status === 404) throw notFound(`HEPData submission not found: ${hepdataId}`);
  if (!response.ok) throw upstreamError(`HEPData download failed: ${response.status}`);
  return response.arrayBuffer();
}
