import { createHash } from 'crypto';

import {
  INSPIRE_API_URL,
  buildArxivUrl,
  buildDoiUrl,
  buildInspireUrl,
  cleanMathTitle,
  invalidParams,
  upstreamError,
  type Paper,
  type PublicationInfo,
} from '@autoresearch/shared';

type InspireHit = {
  metadata?: {
    control_number?: number;
    titles?: Array<{ title?: string }>;
    authors?: Array<{ full_name?: string }>;
    earliest_date?: string;
    dois?: Array<{ value?: string }>;
    arxiv_eprints?: Array<{ value?: string; categories?: string[] }>;
    publication_info?: Array<Record<string, unknown>>;
    abstracts?: Array<{ value?: string }>;
    collaborations?: Array<{ value?: string }>;
    keywords?: Array<{ value?: string }>;
  };
  id?: string;
};

function inferPublicationInfo(publicationInfo: Array<Record<string, unknown>> | undefined): PublicationInfo | undefined {
  const first = publicationInfo?.[0];
  if (!first) return undefined;

  const journal =
    (typeof (first as any).journal_title === 'string' ? String((first as any).journal_title) : undefined)
    ?? (typeof (first as any).journal === 'string' ? String((first as any).journal) : undefined);
  const volume =
    (typeof (first as any).journal_volume === 'string' ? String((first as any).journal_volume) : undefined)
    ?? (typeof (first as any).volume === 'string' ? String((first as any).volume) : undefined);
  const issue =
    (typeof (first as any).journal_issue === 'string' ? String((first as any).journal_issue) : undefined)
    ?? (typeof (first as any).issue === 'string' ? String((first as any).issue) : undefined);

  const pageStart = typeof (first as any).page_start === 'string' ? String((first as any).page_start) : undefined;
  const pageEnd = typeof (first as any).page_end === 'string' ? String((first as any).page_end) : undefined;
  const artid = typeof (first as any).artid === 'string' ? String((first as any).artid) : undefined;
  const pages = artid ?? (pageStart ? (pageEnd ? `${pageStart}-${pageEnd}` : pageStart) : undefined);

  const year = typeof (first as any).year === 'number' && Number.isFinite((first as any).year) ? (first as any).year : undefined;
  const publisher = typeof (first as any).publisher === 'string' ? String((first as any).publisher) : undefined;

  if (!journal && !volume && !issue && !pages && !year && !publisher) return undefined;
  return { journal, volume, issue, pages, year, publisher };
}

function extractPaper(hit: InspireHit): Paper {
  const meta = hit.metadata ?? {};
  const recid = String(meta.control_number ?? hit.id ?? '').trim();
  const arxiv_id = meta.arxiv_eprints?.[0]?.value;
  const doi = meta.dois?.[0]?.value;

  const titleRaw = meta.titles?.[0]?.title ?? '';
  const title = cleanMathTitle(titleRaw) || 'Untitled';
  const authors = Array.isArray(meta.authors) ? meta.authors.map(a => a.full_name || '').filter(Boolean).slice(0, 200) : [];
  const year = meta.earliest_date ? Number.parseInt(meta.earliest_date.slice(0, 4), 10) : undefined;

  const paper: Paper = {
    recid: recid || undefined,
    arxiv_id,
    doi,
    title,
    authors,
    year: Number.isFinite(year as number) ? year : undefined,
    earliest_date: meta.earliest_date,
    inspire_url: recid ? buildInspireUrl(recid) : undefined,
    arxiv_url: arxiv_id ? buildArxivUrl(arxiv_id) : undefined,
    doi_url: doi ? buildDoiUrl(doi) : undefined,
    abstract: meta.abstracts?.[0]?.value,
    collaborations: meta.collaborations?.map(c => c.value).filter((v): v is string => typeof v === 'string' && v.trim().length > 0) ?? [],
    keywords: meta.keywords?.map(k => k.value).filter((v): v is string => typeof v === 'string' && v.trim().length > 0) ?? [],
    arxiv_categories: meta.arxiv_eprints?.[0]?.categories ?? [],
    publication: inferPublicationInfo(meta.publication_info as any),
  };

  return paper;
}

async function fetchInspireJson(url: string): Promise<InspireHit> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.cause) : undefined;
    throw upstreamError('INSPIRE API request failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
      cause,
    });
  }

  if (!res.ok) {
    throw upstreamError(`INSPIRE API error: ${res.status}`, { url, status: res.status });
  }

  return (await res.json()) as InspireHit;
}

export async function getPaper(recid: string): Promise<Paper> {
  const trimmed = recid.trim();
  if (!/^\d+$/.test(trimmed)) throw invalidParams('recid must be numeric', { recid });
  const url = `${INSPIRE_API_URL}/literature/${encodeURIComponent(trimmed)}`;
  return extractPaper(await fetchInspireJson(url));
}

export async function getByDoi(doi: string): Promise<Paper> {
  const trimmed = doi.trim();
  if (!trimmed) throw invalidParams('doi cannot be empty');
  const url = `${INSPIRE_API_URL}/doi/${encodeURIComponent(trimmed)}`;
  return extractPaper(await fetchInspireJson(url));
}

export async function getByArxiv(arxivId: string): Promise<Paper> {
  const trimmed = arxivId.trim();
  if (!trimmed) throw invalidParams('arxiv_id cannot be empty');
  const url = `${INSPIRE_API_URL}/arxiv/${encodeURIComponent(trimmed)}`;
  return extractPaper(await fetchInspireJson(url));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

