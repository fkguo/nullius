/**
 * Compact PaperSummary projection (H-13 L1)
 * Retains LLM-decision-relevant fields, drops redundant URLs and classification arrays.
 * ~63% size reduction per paper (~600 bytes → ~220 bytes).
 */

import type { PaperSummary } from '@autoresearch/shared';

export interface CompactPaperSummary {
  recid?: string;
  arxiv_id?: string;
  title: string;
  authors?: string[];
  author_count?: number;
  collaborations?: string[];
  year?: number;
  citation_count?: number;
  texkey?: string;
  arxiv_primary_category?: string;
  publication_summary?: string;
}

/** Project a full PaperSummary to the compact LLM-decision subset. */
export function compactPaperSummary(p: PaperSummary): CompactPaperSummary {
  return {
    recid: p.recid,
    arxiv_id: p.arxiv_id,
    title: p.title,
    authors: p.authors?.slice(0, 3),
    author_count: p.author_count ?? p.authors?.length,
    collaborations: p.collaborations,
    year: p.year,
    citation_count: p.citation_count,
    texkey: p.texkey,
    arxiv_primary_category: p.arxiv_primary_category,
    publication_summary: p.publication_summary,
  };
}

/**
 * Apply compact projection to any paper arrays found in a result object.
 * Returns a shallow copy with papers compacted; does not mutate the original.
 * Handles both raw PaperSummary[] arrays and objects with a `papers` key.
 */
export function compactPapersInResult(result: unknown): unknown {
  // M-21 R2 fix: handle raw PaperSummary[] arrays (e.g. inspire_literature get_references)
  if (Array.isArray(result)) {
    let anyCompacted = false;
    const compacted = result.map((p: unknown) => {
      if (p && typeof p === 'object' && 'title' in p) {
        anyCompacted = true;
        return compactPaperSummary(p as PaperSummary);
      }
      return p;
    });
    return anyCompacted ? compacted : result;
  }

  if (!result || typeof result !== 'object') return result;

  const record = result as Record<string, unknown>;
  let changed = false;
  const copy: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (key === 'papers' && Array.isArray(value)) {
      copy[key] = value.map((p: unknown) => {
        if (p && typeof p === 'object' && 'title' in p) {
          return compactPaperSummary(p as PaperSummary);
        }
        return p;
      });
      changed = true;
    } else {
      copy[key] = value;
    }
  }

  return changed ? copy : result;
}
