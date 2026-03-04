/**
 * OpenAlex identifier detection and normalization.
 *
 * Supports: OpenAlex ID (W/A/S/I/T/P/F/C prefix), DOI, ORCID, ROR, ISSN, PMID,
 * and full OpenAlex URLs (https://openalex.org/...).
 */

export type OpenAlexEntity =
  | 'works'
  | 'authors'
  | 'sources'
  | 'institutions'
  | 'topics'
  | 'publishers'
  | 'funders'
  | 'concepts';

export interface IdentifierResult {
  type: 'openalex' | 'doi' | 'orcid' | 'ror' | 'issn' | 'pmid' | 'openalex_url';
  entity: OpenAlexEntity;
  /** API-ready normalized form */
  normalized: string;
}

const PREFIX_TO_ENTITY: Record<string, OpenAlexEntity> = {
  W: 'works',
  A: 'authors',
  S: 'sources',
  I: 'institutions',
  T: 'topics',
  P: 'publishers',
  F: 'funders',
  C: 'concepts',
};

// Regex patterns
const OPENALEX_ID_RE = /^([WAISITPFC])(\d+)$/i;
const OPENALEX_URL_RE = /^https?:\/\/openalex\.org\/([WAISITPFC]\d+)(?:\/.*)?$/i;
const DOI_RE = /^(?:https?:\/\/(?:dx\.)?doi\.org\/)?(?:doi:)?(10\.\d{4,}\/\S+)$/i;
const ORCID_URL_RE = /^https?:\/\/orcid\.org\/([\dX]{4}-[\dX]{4}-[\dX]{4}-[\dX]{4})$/i;
const ORCID_BARE_RE = /^(?:orcid:)?([\dX]{4}-[\dX]{4}-[\dX]{4}-[\dX]{4})$/i;
const ROR_URL_RE = /^https?:\/\/ror\.org\/(0\w+)$/i;
const ROR_BARE_RE = /^(?:ror:)?(0\w+)$/i;
const ISSN_RE = /^(?:issn:)?(\d{4}-[\dX]{4})$/i;
const PMID_RE = /^(?:pmid:|pubmed:)?(\d{7,})$/i;

/**
 * Detect and normalize an identifier string.
 * Returns null if the format is unrecognized or ambiguous.
 */
export function detectIdentifier(raw: string): IdentifierResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Full OpenAlex URL: https://openalex.org/W1234567
  const openalexUrlMatch = OPENALEX_URL_RE.exec(trimmed);
  if (openalexUrlMatch) {
    const id = openalexUrlMatch[1].toUpperCase();
    const prefix = id[0] as string;
    const entity = PREFIX_TO_ENTITY[prefix];
    if (!entity) return null;
    return { type: 'openalex_url', entity, normalized: trimmed };
  }

  // Bare OpenAlex ID: W1234567
  const openalexIdMatch = OPENALEX_ID_RE.exec(trimmed);
  if (openalexIdMatch) {
    const prefix = openalexIdMatch[1].toUpperCase();
    const entity = PREFIX_TO_ENTITY[prefix];
    if (!entity) return null;
    return { type: 'openalex', entity, normalized: `${prefix}${openalexIdMatch[2]}` };
  }

  // DOI (with or without https://doi.org/ or doi: prefix)
  const doiMatch = DOI_RE.exec(trimmed);
  if (doiMatch) {
    const doiPath = doiMatch[1].toLowerCase();
    return { type: 'doi', entity: 'works', normalized: `doi:${doiPath}` };
  }

  // ORCID URL
  const orcidUrlMatch = ORCID_URL_RE.exec(trimmed);
  if (orcidUrlMatch) {
    return { type: 'orcid', entity: 'authors', normalized: `orcid:${orcidUrlMatch[1]}` };
  }

  // ORCID bare or with prefix
  const orcidBareMatch = ORCID_BARE_RE.exec(trimmed);
  if (orcidBareMatch) {
    return { type: 'orcid', entity: 'authors', normalized: `orcid:${orcidBareMatch[1]}` };
  }

  // ROR URL
  const rorUrlMatch = ROR_URL_RE.exec(trimmed);
  if (rorUrlMatch) {
    return { type: 'ror', entity: 'institutions', normalized: `ror:${rorUrlMatch[1]}` };
  }

  // ROR bare or with prefix (must start with 0, not a PMID)
  const rorBareMatch = ROR_BARE_RE.exec(trimmed);
  if (rorBareMatch && !PMID_RE.test(trimmed)) {
    return { type: 'ror', entity: 'institutions', normalized: `ror:${rorBareMatch[1]}` };
  }

  // ISSN
  const issnMatch = ISSN_RE.exec(trimmed);
  if (issnMatch) {
    return { type: 'issn', entity: 'sources', normalized: `issn:${issnMatch[1]}` };
  }

  // PMID (with prefix or 7+ digit bare number)
  const pmidMatch = PMID_RE.exec(trimmed);
  if (pmidMatch) {
    return { type: 'pmid', entity: 'works', normalized: `pmid:${pmidMatch[1]}` };
  }

  return null;
}

/**
 * Infer entity type from a raw identifier string.
 * Returns the entity type, or null if detection fails.
 */
export function inferEntity(raw: string): OpenAlexEntity | null {
  return detectIdentifier(raw)?.entity ?? null;
}
