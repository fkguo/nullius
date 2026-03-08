import type { ArxivMetadata } from '@autoresearch/arxiv-mcp/tooling';
import type { CanonicalCandidate, DiscoveryCandidateChannel, PaperSummary } from '@autoresearch/shared';

type OpenAlexWorkLike = Record<string, unknown>;

function rankScore(index: number): number {
  return Math.max(0, 1 - index * 0.05);
}

function normalizeDoi(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.replace(/^https?:\/\/doi\.org\//i, '').trim();
}

function openAlexAuthors(work: OpenAlexWorkLike): string[] {
  const authorships = Array.isArray(work.authorships) ? work.authorships : [];
  return authorships
    .map(entry => {
      if (!entry || typeof entry !== 'object') return null;
      const author = (entry as Record<string, unknown>).author;
      if (!author || typeof author !== 'object') return null;
      const display = (author as Record<string, unknown>).display_name;
      return typeof display === 'string' && display.trim() ? display.trim() : null;
    })
    .filter((value): value is string => Boolean(value));
}

export function fromPaperSummary(
  provider: CanonicalCandidate['provider'],
  paper: PaperSummary,
  channel: DiscoveryCandidateChannel,
  query: string,
  index: number,
): CanonicalCandidate {
  return {
    provider,
    identifiers: {
      recid: paper.recid,
      doi: paper.doi,
      arxiv_id: paper.arxiv_id,
      texkey: paper.texkey,
    },
    title: paper.title,
    authors: paper.authors ?? [],
    year: paper.year,
    citation_count: paper.citation_count,
    score: rankScore(index),
    matched_by: [channel],
    provenance: {
      source: provider === 'inspire' ? 'inspire_search' : `${provider}_paper_summary`,
      query,
      channel,
      provider_rank: index + 1,
      provider_score: rankScore(index),
    },
  };
}

export function fromOpenAlexWork(
  work: OpenAlexWorkLike,
  channel: DiscoveryCandidateChannel,
  query: string,
  index: number,
): CanonicalCandidate | null {
  const title = typeof work.title === 'string' && work.title.trim() ? work.title.trim() : null;
  const id = typeof work.id === 'string' && work.id.trim() ? work.id.trim() : null;
  if (!title || !id) return null;
  const openalex_id = id.split('/').pop()?.trim();
  return {
    provider: 'openalex',
    identifiers: {
      openalex_id,
      doi: normalizeDoi(work.doi),
      arxiv_id: typeof (work as { ids?: { arxiv?: unknown } }).ids?.arxiv === 'string'
        ? String((work as { ids?: { arxiv?: unknown } }).ids?.arxiv).split('/').pop()
        : undefined,
    },
    title,
    authors: openAlexAuthors(work),
    year: typeof work.publication_year === 'number' ? work.publication_year : undefined,
    citation_count: typeof work.cited_by_count === 'number' ? work.cited_by_count : undefined,
    score: rankScore(index),
    matched_by: [channel],
    provenance: {
      source: channel === 'identifier_lookup' ? 'openalex_get' : channel === 'semantic_search' ? 'openalex_semantic_search' : 'openalex_search',
      query,
      channel,
      provider_rank: index + 1,
      provider_score: rankScore(index),
    },
  };
}

export function fromArxivMetadata(
  metadata: ArxivMetadata,
  channel: DiscoveryCandidateChannel,
  query: string,
  index: number,
): CanonicalCandidate {
  return {
    provider: 'arxiv',
    identifiers: {
      arxiv_id: metadata.arxiv_id,
      doi: metadata.doi,
    },
    title: metadata.title,
    authors: metadata.authors,
    year: metadata.published ? Number.parseInt(metadata.published.slice(0, 4), 10) : undefined,
    score: rankScore(index),
    matched_by: [channel],
    provenance: {
      source: channel === 'identifier_lookup' ? 'arxiv_get_metadata' : 'arxiv_search',
      query,
      channel,
      provider_rank: index + 1,
      provider_score: rankScore(index),
    },
  };
}
