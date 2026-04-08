import { upstreamError, type Paper } from '@autoresearch/shared';

const CROSSREF_API_URL = 'https://api.crossref.org';
const MIN_REQUEST_INTERVAL_MS = 500;

const CROSSREF_MAILTO = process.env.CROSSREF_MAILTO || 'autoresearch@users.noreply.github.com';
const CROSSREF_USER_AGENT = `autoresearch-zotero-mcp/1.0 (https://github.com/fkg/autoresearch-lab; mailto:${CROSSREF_MAILTO})`;

// Serialized throttle: chains promises to ensure sequential spacing even under concurrent calls
let throttleChain = Promise.resolve();

function throttle(): Promise<void> {
  throttleChain = throttleChain.then(
    () => new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS))
  );
  return throttleChain;
}

interface CrossRefWork {
  DOI?: string;
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  'container-title'?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  'published-print'?: { 'date-parts'?: number[][] };
  'published-online'?: { 'date-parts'?: number[][] };
  issued?: { 'date-parts'?: number[][] };
  publisher?: string;
  URL?: string;
  abstract?: string;
  type?: string;
}

function extractYear(work: CrossRefWork): number | undefined {
  const dateParts =
    work['published-print']?.['date-parts']?.[0] ??
    work['published-online']?.['date-parts']?.[0] ??
    work.issued?.['date-parts']?.[0];
  const year = dateParts?.[0];
  return typeof year === 'number' && Number.isFinite(year) ? year : undefined;
}

function crossrefTypeToPaper(work: CrossRefWork): Paper {
  const doi = work.DOI?.trim() || undefined;
  const title = work.title?.[0]?.trim() || 'Untitled';

  const authors: string[] = (work.author ?? [])
    .map(a => {
      if (a.name) return a.name;
      const parts = [a.given, a.family].filter(Boolean);
      return parts.length > 0 ? parts.join(' ') : '';
    })
    .filter(Boolean)
    .slice(0, 200);

  const year = extractYear(work);
  const journal = work['container-title']?.[0]?.trim() || undefined;

  return {
    title,
    authors,
    doi,
    year,
    doi_url: doi ? `https://doi.org/${doi}` : undefined,
    abstract: work.abstract?.replace(/<[^>]*>/g, '').trim() || undefined,
    publication: journal || work.volume || work.issue || work.page
      ? {
          journal,
          volume: work.volume,
          issue: work.issue,
          pages: work.page,
          publisher: work.publisher,
        }
      : undefined,
  };
}

export async function getByDoi(doi: string): Promise<Paper> {
  await throttle();

  const url = `${CROSSREF_API_URL}/works/${encodeURIComponent(doi)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': CROSSREF_USER_AGENT,
      },
    });
  } catch (err) {
    throw upstreamError('CrossRef API request failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!res.ok) {
    throw upstreamError(`CrossRef API error: ${res.status}`, { url, status: res.status, doi });
  }

  const json = (await res.json()) as { message?: CrossRefWork };
  if (!json.message) {
    throw upstreamError('CrossRef API returned empty message', { url, doi });
  }

  return crossrefTypeToPaper(json.message);
}
