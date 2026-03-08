const DOI_RE = /\b10\.\d{4,9}\/[!-~]+\b/i;
const OPENALEX_RE = /\bW\d{4,}\b/i;
const ARXIV_RE = /\b(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)\b/i;
const RECID_RE = /^\d{4,}$/;

export type DiscoveryQueryIdentifiers = {
  doi?: string;
  arxiv_id?: string;
  openalex_id?: string;
  recid?: string;
};

function normalizeArxivIdentifier(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/^arxiv:/, '');
  return /^\d{4}\.\d{4,5}(?:v\d+)?$/.test(trimmed) ? trimmed : null;
}

export function extractQueryIdentifiers(query: string): DiscoveryQueryIdentifiers {
  const trimmed = query.trim();
  const doi = DOI_RE.exec(trimmed)?.[0]?.replace(/[),.;]$/, '');
  const openalex_id = OPENALEX_RE.exec(trimmed)?.[0]?.toUpperCase();
  const arxivRaw = ARXIV_RE.exec(trimmed)?.[1];
  const arxiv_id = arxivRaw ? normalizeArxivIdentifier(arxivRaw) ?? undefined : undefined;
  const recid = !doi && !openalex_id && !arxiv_id && RECID_RE.test(trimmed) ? trimmed : undefined;
  return { doi, arxiv_id, openalex_id, recid };
}

export function hasStructuredIdentifier(ids: DiscoveryQueryIdentifiers): boolean {
  return Boolean(ids.doi || ids.arxiv_id || ids.openalex_id || ids.recid);
}
