/**
 * resolveArxivId — INSPIRE-aware identifier resolution for hep-mcp
 *
 * Wraps arxiv-mcp's normalizeArxivId with INSPIRE API fallback
 * for DOIs, recids, and generic identifiers.
 */

import { normalizeArxivId } from '@autoresearch/arxiv-mcp/tooling';
import * as api from '../api/client.js';

export interface ResolveResult {
  arxivId: string | null;
  recid?: string;
  doi?: string;
}

function extractIdentifiers(paper: { arxiv_id?: string; recid?: string; doi?: string } | null | undefined): ResolveResult {
  return {
    arxivId: paper?.arxiv_id ?? null,
    recid: paper?.recid,
    doi: paper?.doi,
  };
}

/** Resolve any identifier (arXiv ID, DOI, INSPIRE recid) to arXiv ID. */
export async function resolveArxivId(identifier: string): Promise<string | null> {
  const normalized = normalizeArxivId(identifier);
  if (normalized) return normalized;

  const recidMatch = identifier.match(/^(?:inspire:)?(\d+)$/);
  if (recidMatch) {
    const paper = await api.getPaper(recidMatch[1]);
    return paper.arxiv_id ?? null;
  }
  if (identifier.startsWith('10.')) {
    const paper = await api.getByDoi(identifier);
    return paper.arxiv_id ?? null;
  }

  const query = identifier;
  const result = await api.search(query, { size: 1 });
  return result.papers[0]?.arxiv_id ?? null;
}

/** Rich resolve — returns all discovered identifiers for URL supplementation. */
export async function resolveArxivIdRich(identifier: string): Promise<ResolveResult> {
  const normalized = normalizeArxivId(identifier);
  if (normalized) return { arxivId: normalized };

  const recidMatch = identifier.match(/^(?:inspire:)?(\d+)$/);
  if (recidMatch) {
    const recid = recidMatch[1];
    const resolved = extractIdentifiers(await api.getPaper(recid));
    return { ...resolved, recid: resolved.recid ?? recid };
  }
  if (identifier.startsWith('10.')) {
    const resolved = extractIdentifiers(await api.getByDoi(identifier));
    return { ...resolved, doi: resolved.doi ?? identifier };
  }

  const query = identifier;
  const result = await api.search(query, { size: 1 });
  const paper = result.papers[0];
  return extractIdentifiers(paper);
}
