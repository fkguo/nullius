/**
 * Generate Survey Tool
 * Generates a structured reading list based on seed papers and research goal.
 * Reference: legacy plan - Phase 2 Deep Research Tools
 */

import * as api from '../../api/client.js';
import {
  type GenerateSurveyParams,
  type SurveyResult,
  type PaperSummary,
  GenerateSurveyParamsSchema,
} from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type { GenerateSurveyParams, SurveyResult };

interface SurveyPaper {
  recid: string;
  title: string;
  authors: string[];
  year?: number;
  citation_count?: number;
  why_include: string;
  priority: 'essential' | 'recommended' | 'optional';
  is_review: boolean;
}

/** Intermediate type for collecting papers before conversion to SurveyPaper */
type CollectedPaper = PaperSummary & { depth: number };

interface SurveySection {
  name: string;
  description: string;
  papers: SurveyPaper[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Goal Strategies
// ─────────────────────────────────────────────────────────────────────────────

const GOAL_CONFIG = {
  comprehensive_review: {
    sections: ['Foundational Papers', 'Key Methods', 'Recent Advances', 'Reviews'],
    max_papers: 50,
    backward_depth: 3,
    forward_depth: 2,
  },
  quick_overview: {
    sections: ['Key Papers', 'Reviews'],
    max_papers: 10,
    backward_depth: 1,
    forward_depth: 1,
  },
  find_methods: {
    sections: ['Methodological Papers', 'Applications'],
    max_papers: 20,
    backward_depth: 2,
    forward_depth: 1,
  },
  historical_context: {
    sections: ['Origins', 'Milestones', 'Evolution'],
    max_papers: 30,
    backward_depth: 4,
    forward_depth: 1,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function isReviewPaper(paper: PaperSummary): boolean {
  const title = (paper.title || '').toLowerCase();
  return title.includes('review') || title.includes('status') || title.includes('overview');
}

function determinePriority(
  paper: PaperSummary,
  citationThreshold: number
): 'essential' | 'recommended' | 'optional' {
  const citations = paper.citation_count || 0;
  if (citations >= citationThreshold * 2) return 'essential';
  if (citations >= citationThreshold) return 'recommended';
  return 'optional';
}

const SURVEY_BATCH_SIZE = 5;

async function collectFoundationalPapers(
  seedRecids: string[],
  depth: number,
  maxPapers: number
): Promise<SurveyPaper[]> {
  const papers = new Map<string, CollectedPaper>();
  const seedSet = new Set(seedRecids);

  let currentLayer = seedRecids;
  for (let d = 1; d <= depth; d++) {
    const nextLayer: string[] = [];
    const layerRecids = currentLayer.slice(0, maxPapers);
    const fetchSize = Math.min(1000, Math.max(1, maxPapers * 5));

    // Process in parallel batches
    for (let i = 0; i < layerRecids.length; i += SURVEY_BATCH_SIZE) {
      const batch = layerRecids.slice(i, i + SURVEY_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (recid) => {
          try {
            return { recid, refs: await api.getReferences(recid, fetchSize) };
          } catch (error) {
            // Log at debug level for troubleshooting
            console.debug(`[hep-mcp] survey getReferences (recid=${recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
            return { recid, refs: [] }; // Skip on error
          }
        })
      );

      for (const { refs } of batchResults) {
        for (const ref of refs) {
          if (!ref.recid || seedSet.has(ref.recid)) continue;
          if (!papers.has(ref.recid)) {
            papers.set(ref.recid, { ...ref, depth: d });
            nextLayer.push(ref.recid);
          }
        }
      }
    }
    currentLayer = nextLayer.slice(0, maxPapers);
  }

  return [...papers.values()]
    .filter((p): p is CollectedPaper & { recid: string } => !!p.recid)
    .sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0))
    .slice(0, maxPapers)
    .map(p => ({
      recid: p.recid,
      title: p.title || 'Unknown',
      authors: p.authors || [],
      year: p.year,
      citation_count: p.citation_count,
      why_include: `Foundational paper cited at depth ${p.depth}`,
      priority: determinePriority(p, 100),
      is_review: isReviewPaper(p),
    }));
}

async function collectRecentPapers(
  seedRecids: string[],
  depth: number,
  maxPapers: number
): Promise<SurveyPaper[]> {
  const papers = new Map<string, CollectedPaper>();
  const seedSet = new Set(seedRecids);
  const currentYear = new Date().getFullYear();

  let currentLayer = seedRecids;
  for (let d = 1; d <= depth; d++) {
    const nextLayer: string[] = [];
    const layerRecids = currentLayer.slice(0, maxPapers);
    const fetchSize = Math.min(1000, Math.max(1, maxPapers * 5));

    // Process in parallel batches
    for (let i = 0; i < layerRecids.length; i += SURVEY_BATCH_SIZE) {
      const batch = layerRecids.slice(i, i + SURVEY_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (recid) => {
          try {
            return { recid, citations: await api.getCitations(recid, { size: fetchSize, sort: 'mostrecent' }) };
          } catch (error) {
            // Log at debug level for troubleshooting
            console.debug(`[hep-mcp] survey getCitations (recid=${recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
            return { recid, citations: { papers: [] } }; // Skip on error
          }
        })
      );

      for (const { citations } of batchResults) {
        for (const paper of citations.papers) {
          if (!paper.recid || seedSet.has(paper.recid)) continue;
          if (!papers.has(paper.recid)) {
            papers.set(paper.recid, { ...paper, depth: d });
            nextLayer.push(paper.recid);
          }
        }
      }
    }
    currentLayer = nextLayer.slice(0, maxPapers);
  }

  return [...papers.values()]
    .filter((p): p is CollectedPaper & { recid: string } => !!p.recid && !!p.year && p.year >= currentYear - 3)
    .sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0))
    .slice(0, maxPapers)
    .map(p => ({
      recid: p.recid,
      title: p.title || 'Unknown',
      authors: p.authors || [],
      year: p.year,
      citation_count: p.citation_count,
      why_include: 'Recent advance in the field',
      priority: determinePriority(p, 20),
      is_review: isReviewPaper(p),
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function generateSurvey(
  params: GenerateSurveyParams
): Promise<SurveyResult> {
  const validated = GenerateSurveyParamsSchema.parse(params);
  const { seed_recids, goal, max_papers, prioritize, include_reviews } = validated;

  const config = GOAL_CONFIG[goal];
  const limit = max_papers || config.max_papers;

  const sections: SurveySection[] = [];

  // Collect foundational papers
  const foundational = await collectFoundationalPapers(
    seed_recids,
    config.backward_depth,
    limit
  );

  if (foundational.length > 0) {
    sections.push({
      name: 'Foundational Papers',
      description: 'Key papers that established the field',
      papers: foundational.slice(0, Math.ceil(limit / 3)),
    });
  }

  // Collect recent advances
  const recent = await collectRecentPapers(seed_recids, config.forward_depth, limit);

  if (recent.length > 0) {
    sections.push({
      name: 'Recent Advances',
      description: 'Recent developments in the field',
      papers: recent.slice(0, Math.ceil(limit / 3)),
    });
  }

  // Extract reviews if requested
  if (include_reviews) {
    const allPapers = [...foundational, ...recent];
    const reviews = allPapers.filter(p => p.is_review);
    if (reviews.length > 0) {
      sections.push({
        name: 'Review Articles',
        description: 'Comprehensive reviews of the topic',
        papers: reviews.slice(0, 5),
      });
    }
  }

  // Build suggested reading order
  const allPapers = sections.flatMap(s => s.papers);
  let orderedPapers = [...allPapers];

  switch (prioritize) {
    case 'citations':
      orderedPapers.sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0));
      break;
    case 'recency':
      orderedPapers.sort((a, b) => (b.year || 0) - (a.year || 0));
      break;
    case 'relevance':
    default:
      const priorityOrder = { essential: 0, recommended: 1, optional: 2 };
      orderedPapers.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
      break;
  }

  return {
    goal,
    sections,
    suggested_reading_order: orderedPapers.map(p => p.recid),
  };
}
