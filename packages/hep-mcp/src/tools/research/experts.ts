/**
 * Find Experts
 * Reference: legacy plan - inspire_find_experts
 */

import * as api from '../../api/client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FindExpertsParams {
  topic: string;
  limit?: number;  // default 10
}

export interface Expert {
  name: string;
  paper_count: number;
  total_citations: number;
  h_index_estimate: number;
  top_papers: { recid: string; title: string; citations: number }[];
}

export interface FindExpertsResult {
  topic: string;
  experts: Expert[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function findExperts(
  params: FindExpertsParams
): Promise<FindExpertsResult> {
  const { topic, limit = 10 } = params;

  // Search for high-cited papers on the topic
  const result = await api.searchAll(`${topic} topcite:50+`, { sort: 'mostcited' });

  // Count author contributions
  const authorStats = new Map<string, {
    papers: { recid: string; title: string; citations: number }[];
    totalCitations: number;
  }>();

  for (const paper of result.papers) {
    if (!paper.recid) continue;
    const citations = paper.citation_count || 0;
    for (const author of paper.authors) {
      if (!authorStats.has(author)) {
        authorStats.set(author, { papers: [], totalCitations: 0 });
      }
      const stats = authorStats.get(author)!;
      stats.papers.push({
        recid: paper.recid,
        title: paper.title,
        citations,
      });
      stats.totalCitations += citations;
    }
  }

  // Calculate h-index estimate and sort
  const experts: Expert[] = [...authorStats.entries()]
    .map(([name, stats]) => {
      const sortedCitations = stats.papers
        .map(p => p.citations)
        .sort((a, b) => b - a);
      let h = 0;
      for (let i = 0; i < sortedCitations.length; i++) {
        if (sortedCitations[i] >= i + 1) h = i + 1;
        else break;
      }
      return {
        name,
        paper_count: stats.papers.length,
        total_citations: stats.totalCitations,
        h_index_estimate: h,
        top_papers: stats.papers.slice(0, 3),
      };
    })
    .sort((a, b) => b.h_index_estimate - a.h_index_estimate)
    .slice(0, limit);

  return { topic, experts };
}
