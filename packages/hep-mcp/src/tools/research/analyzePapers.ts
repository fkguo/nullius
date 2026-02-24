/**
 * Analyze Papers Tool
 * Analyzes a collection of papers to extract insights about authors, topics, timeline, etc.
 * Reference: legacy plan - Phase 2 Deep Research Tools
 */

import * as api from '../../api/client.js';
import {
  type AnalyzePapersParams,
  type CollectionAnalysis,
  type PaperSummary,
  type Paper,
  AnalyzePapersParamsSchema,
} from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type { AnalyzePapersParams, CollectionAnalysis };

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

interface AuthorStats {
  name: string;
  paper_count: number;
  total_citations: number;
  bai?: string;
}

interface CollaborationStats {
  name: string;
  count: number;
}

interface CategoryStats {
  category: string;
  count: number;
}

function extractAuthors(papers: PaperSummary[]): AuthorStats[] {
  const authorMap = new Map<string, AuthorStats>();

  for (const paper of papers) {
    for (const author of paper.authors || []) {
      const existing = authorMap.get(author);
      if (existing) {
        existing.paper_count++;
        existing.total_citations += paper.citation_count || 0;
      } else {
        authorMap.set(author, {
          name: author,
          paper_count: 1,
          total_citations: paper.citation_count || 0,
        });
      }
    }
  }

  return [...authorMap.values()]
    .sort((a, b) => b.paper_count - a.paper_count)
    .slice(0, 20);
}

function extractCollaborations(papers: Paper[]): CollaborationStats[] {
  const collabMap = new Map<string, number>();

  for (const paper of papers) {
    for (const collab of paper.collaborations || []) {
      collabMap.set(collab, (collabMap.get(collab) || 0) + 1);
    }
  }

  return [...collabMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

function extractCategories(papers: Paper[]): CategoryStats[] {
  const catMap = new Map<string, number>();

  for (const paper of papers) {
    for (const cat of paper.arxiv_categories || []) {
      catMap.set(cat, (catMap.get(cat) || 0) + 1);
    }
  }

  return [...catMap.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

function buildTimeline(papers: PaperSummary[]): { year: number; count: number; key_papers: string[] }[] {
  const yearMap = new Map<number, { count: number; papers: PaperSummary[] }>();

  for (const paper of papers) {
    if (!paper.year) continue;
    const existing = yearMap.get(paper.year);
    if (existing) {
      existing.count++;
      existing.papers.push(paper);
    } else {
      yearMap.set(paper.year, { count: 1, papers: [paper] });
    }
  }

  return [...yearMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, data]) => ({
      year,
      count: data.count,
      key_papers: data.papers
        .sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0))
        .slice(0, 3)
        .map(p => p.recid)
        .filter((id): id is string => !!id),
    }));
}

function extractTopics(papers: Paper[]): { keywords: string[]; paper_count: number; representative_papers: string[] }[] {
  // Simple keyword extraction from paper keywords
  const keywordMap = new Map<string, { count: number; papers: string[] }>();

  for (const paper of papers) {
    if (!paper.recid) continue; // Skip papers without recid
    for (const kw of paper.keywords || []) {
      const existing = keywordMap.get(kw);
      if (existing) {
        existing.count++;
        existing.papers.push(paper.recid);
      } else {
        keywordMap.set(kw, { count: 1, papers: [paper.recid] });
      }
    }
  }

  // Group related keywords (simple approach: top keywords)
  const topKeywords = [...keywordMap.entries()]
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 10);

  if (topKeywords.length === 0) return [];

  // Return as single topic cluster for now
  return [{
    keywords: topKeywords.map(([kw]) => kw),
    paper_count: papers.length,
    representative_papers: papers
      .sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0))
      .slice(0, 5)
      .map(p => p.recid)
      .filter((id): id is string => !!id),
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzePapers(params: AnalyzePapersParams): Promise<CollectionAnalysis> {
  // Validate params
  const validated = AnalyzePapersParamsSchema.parse(params);
  const { recids, analysis_type } = validated;

  const types = analysis_type || ['all'];
  const includeAll = types.includes('all');
  const needsFullPapers = includeAll || types.includes('overview') || types.includes('topics');

  // Fetch paper details
  const papers = await api.batchGetPapers(recids);

  // Also fetch full paper details for collaborations, keywords, etc. (parallel batches)
  const fullPapers: Paper[] = [];
  if (needsFullPapers) {
    const uniqueRecids = [...new Set(recids)];
    for (let i = 0; i < uniqueRecids.length; i += BATCH_SIZE) {
      const batch = uniqueRecids.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (recid) => {
          try {
            return await api.getPaper(recid);
          } catch (error) {
            // Log at debug level for troubleshooting
            console.debug(
              `[hep-research-mcp] analyzePapers getPaper (recid=${recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`
            );
            return null; // Skip papers that fail to fetch
          }
        })
      );
      for (const paper of batchResults) {
        if (paper) fullPapers.push(paper);
      }
    }
  }

  // Calculate date range
  const years = papers.map(p => p.year).filter((y): y is number => y !== undefined);
  const dateRange = {
    earliest: years.length > 0 ? String(Math.min(...years)) : 'unknown',
    latest: years.length > 0 ? String(Math.max(...years)) : 'unknown',
  };

  const result: CollectionAnalysis = {
    item_count: papers.length,
    date_range: dateRange,
  };

  // Overview analysis
  if (includeAll || types.includes('overview')) {
    const totalCitations = papers.reduce((sum, p) => sum + (p.citation_count || 0), 0);
    const topCited = [...papers]
      .sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0))
      .slice(0, 5);

    result.overview = {
      total_citations: totalCitations,
      avg_citations: papers.length > 0 ? Math.round(totalCitations / papers.length) : 0,
      top_cited: topCited,
      collaborations: extractCollaborations(fullPapers),
      arxiv_categories: extractCategories(fullPapers),
    };
  }

  // Timeline analysis
  if (includeAll || types.includes('timeline')) {
    result.timeline = buildTimeline(papers);
  }

  // Authors analysis
  if (includeAll || types.includes('authors')) {
    result.authors = extractAuthors(papers);
  }

  // Topics analysis
  if (includeAll || types.includes('topics')) {
    result.topics = extractTopics(fullPapers);
  }

  return result;
}
