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

/** Resolve any identifier (arXiv ID, DOI, INSPIRE recid) to arXiv ID. */
export async function resolveArxivId(identifier: string): Promise<string | null> {
  const normalized = normalizeArxivId(identifier);
  if (normalized) return normalized;

  let query: string;
  const recidMatch = identifier.match(/^(?:inspire:)?(\d+)$/);
  if (recidMatch) query = `recid:${recidMatch[1]}`;
  else if (identifier.startsWith('10.')) query = `doi:${identifier}`;
  else query = identifier;

  const result = await api.search(query, { size: 1 });
  return result.papers[0]?.arxiv_id ?? null;
}

/** Rich resolve — returns all discovered identifiers for URL supplementation. */
export async function resolveArxivIdRich(identifier: string): Promise<ResolveResult> {
  const normalized = normalizeArxivId(identifier);
  if (normalized) return { arxivId: normalized };

  let query: string;
  let inputRecid: string | undefined;
  let inputDoi: string | undefined;
  const recidMatch = identifier.match(/^(?:inspire:)?(\d+)$/);
  if (recidMatch) { query = `recid:${recidMatch[1]}`; inputRecid = recidMatch[1]; }
  else if (identifier.startsWith('10.')) { query = `doi:${identifier}`; inputDoi = identifier; }
  else query = identifier;

  const result = await api.search(query, { size: 1 });
  const paper = result.papers[0];
  return {
    arxivId: paper?.arxiv_id ?? null,
    recid: paper?.recid ?? inputRecid,
    doi: paper?.doi ?? inputDoi,
  };
}
