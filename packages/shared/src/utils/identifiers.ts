// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const INSPIRE_BASE_URL = 'https://inspirehep.net';
export const INSPIRE_API_URL = 'https://inspirehep.net/api';
export const INSPIRE_LITERATURE_URL = 'https://inspirehep.net/literature';
export const ARXIV_BASE_URL = 'https://arxiv.org';
export const ARXIV_ABS_URL = 'https://arxiv.org/abs';
export const DOI_ORG_URL = 'https://doi.org';

// ─────────────────────────────────────────────────────────────────────────────
// Recid Extraction
// ─────────────────────────────────────────────────────────────────────────────

export function extractRecidFromUrl(url?: string | null): string | null {
  if (!url) return null;
  const match = url.match(/(?:literature|record)\/(\d+)/);
  return match ? match[1] : null;
}

export function extractRecidFromRecordRef(ref?: string): string | null {
  if (!ref) return null;
  const match = ref.match(/\/(\d+)(?:\?.*)?$/);
  return match ? match[1] : null;
}

export function extractRecidFromUrls(
  urls?: Array<{ value: string }>
): string | null {
  if (!Array.isArray(urls)) return null;
  for (const entry of urls) {
    const candidate = extractRecidFromUrl(entry?.value);
    if (candidate) return candidate;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// arXiv ID Handling
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeArxivID(raw?: string | null): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^arxiv\s*:/i, '').trim();
}

export function normalizeArxivCategories(input?: unknown): string[] {
  if (!input) return [];
  const values = Array.isArray(input) ? input : [input];
  return values
    .map((v) => (typeof v === 'string' ? v.trim() : undefined))
    .filter((v): v is string => Boolean(v));
}

// ─────────────────────────────────────────────────────────────────────────────
// URL Building
// ─────────────────────────────────────────────────────────────────────────────

export function buildInspireUrl(recid: string): string {
  return `${INSPIRE_LITERATURE_URL}/${recid}`;
}

export function buildArxivUrl(arxivId: string): string {
  return `${ARXIV_ABS_URL}/${arxivId}`;
}

export function buildDoiUrl(doi: string): string {
  return `${DOI_ORG_URL}/${doi}`;
}
