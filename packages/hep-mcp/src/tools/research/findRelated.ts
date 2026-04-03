/**
 * Find Related Papers Tool
 * Identifies papers that may be missing from a collection based on citation patterns.
 * Reference: legacy plan - Phase 2 Deep Research Tools
 */

import * as api from '../../api/client.js';
import {
  type FindRelatedParams,
  type RelatedPapers,
  type PaperSummary,
  FindRelatedParamsSchema,
} from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type { FindRelatedParams, RelatedPapers };

interface CandidatePaper {
  recid: string;
  title: string;
  authors: string[];
  year?: number;
  citation_count?: number;
  connection_count: number;
  relevance_reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy Implementations
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 5; // Parallel batch size to avoid rate limiting

async function findHighCitedRefs(
  recids: string[],
  recidSet: Set<string>,
  limit: number
): Promise<CandidatePaper[]> {
  const refCounts = new Map<string, { count: number; paper: PaperSummary }>();
  const targetRecids = [...new Set(recids)];

  // Process in parallel batches
  for (let i = 0; i < targetRecids.length; i += BATCH_SIZE) {
    const batch = targetRecids.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (recid) => {
        try {
          return await api.getReferences(recid);
        } catch (error) {
          // Log at debug level for troubleshooting
          console.debug(`[hep-mcp] findCommonReferences (recid=${recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
          return []; // Skip on error
        }
      })
    );

    // Aggregate results
    for (const refs of results) {
      for (const ref of refs) {
        if (!ref.recid || recidSet.has(ref.recid)) continue;
        const existing = refCounts.get(ref.recid);
        if (existing) {
          existing.count++;
        } else {
          refCounts.set(ref.recid, { count: 1, paper: ref });
        }
      }
    }
  }

  return [...refCounts.entries()]
    .filter(([, data]) => data.count >= 2)
    .sort(([, a], [, b]) => {
      const scoreA = a.count * Math.log10((a.paper.citation_count || 1) + 1);
      const scoreB = b.count * Math.log10((b.paper.citation_count || 1) + 1);
      return scoreB - scoreA;
    })
    .slice(0, limit)
    .map(([recid, data]) => ({
      recid,
      title: data.paper.title || 'Unknown',
      authors: data.paper.authors || [],
      year: data.paper.year,
      citation_count: data.paper.citation_count,
      connection_count: data.count,
      relevance_reason: `Cited by ${data.count} papers in collection`,
    }));
}

async function findCommonRefs(
  recids: string[],
  recidSet: Set<string>,
  limit: number
): Promise<CandidatePaper[]> {
  // Same as high_cited_refs but weighted differently
  return findHighCitedRefs(recids, recidSet, limit);
}

async function findCitingOverlap(
  recids: string[],
  recidSet: Set<string>,
  limit: number
): Promise<CandidatePaper[]> {
  const citingPapers = new Map<string, { count: number; paper: PaperSummary }>();
  const targetRecids = [...new Set(recids)];

  // Process in parallel batches
  for (let i = 0; i < targetRecids.length; i += BATCH_SIZE) {
    const batch = targetRecids.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (recid) => {
        try {
          const fetchSize = Math.min(1000, Math.max(1, limit * 10));
          return await api.getCitations(recid, { size: fetchSize, sort: 'mostcited' });
        } catch (error) {
          // Log at debug level for troubleshooting
          console.debug(`[hep-mcp] findCitingOverlap (recid=${recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
          return { papers: [] }; // Skip on error
        }
      })
    );

    // Aggregate results
    for (const citations of results) {
      for (const citing of citations.papers) {
        if (!citing.recid || recidSet.has(citing.recid)) continue;
        const existing = citingPapers.get(citing.recid);
        if (existing) {
          existing.count++;
        } else {
          citingPapers.set(citing.recid, { count: 1, paper: citing });
        }
      }
    }
  }

  return [...citingPapers.entries()]
    .filter(([, data]) => data.count >= 2)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, limit)
    .map(([recid, data]) => ({
      recid,
      title: data.paper.title || 'Unknown',
      authors: data.paper.authors || [],
      year: data.paper.year,
      citation_count: data.paper.citation_count,
      connection_count: data.count,
      relevance_reason: `Cites ${data.count} papers in collection`,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function findRelatedPapers(
  params: FindRelatedParams
): Promise<RelatedPapers> {
  const validated = FindRelatedParamsSchema.parse(params);
  const { recids, strategy, limit, min_relevance } = validated;

  const recidSet = new Set<string>(recids);
  let candidates: CandidatePaper[] = [];

  switch (strategy) {
    case 'high_cited_refs':
      candidates = await findHighCitedRefs(recids, recidSet, limit * 2);
      break;
    case 'common_refs':
      candidates = await findCommonRefs(recids, recidSet, limit * 2);
      break;
    case 'citing_overlap':
      candidates = await findCitingOverlap(recids, recidSet, limit * 2);
      break;
    case 'co_citation':
      // Co-citation is similar to citing_overlap
      candidates = await findCitingOverlap(recids, recidSet, limit * 2);
      break;
    case 'all':
      const [refs, citing] = await Promise.all([
        findHighCitedRefs(recids, recidSet, limit),
        findCitingOverlap(recids, recidSet, limit),
      ]);
      candidates = [...refs, ...citing];
      break;
  }

  // Calculate relevance scores and filter
  const maxConnections = Math.max(...candidates.map(c => c.connection_count), 1);
  const papers = candidates
    .map(c => ({
      ...c,
      relevance_score: c.connection_count / maxConnections,
    }))
    .filter(p => p.relevance_score >= min_relevance)
    .slice(0, limit);

  return {
    papers,
    total_candidates: candidates.length,
  };
}
