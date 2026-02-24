/**
 * Trace Conference Paper to Original Journal Paper
 * Automatically finds the corresponding journal publication for conference papers
 *
 * Algorithm:
 * 1. Detect if paper is a conference paper
 * 2. Extract author list and title keywords
 * 3. Search for journal papers by same authors (excluding tc:c)
 * 4. Calculate title/abstract similarity
 * 5. Return best matching journal paper
 */

import * as api from '../../api/client.js';
import type { PaperSummary } from '@autoresearch/shared';
import { isConferencePaper, classifyPaper } from './paperClassifier.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TraceToOriginalParams {
  /** Paper recid to trace */
  recid: string;
  /** Minimum similarity threshold (default: 0.6) */
  min_similarity?: number;
}

export type PaperRelationship = 'same_content' | 'extended' | 'preliminary' | 'unknown';

export interface TraceToOriginalResult {
  /** Whether tracing was successful */
  success: boolean;
  /** The input conference paper */
  conference_paper: PaperSummary;
  /** The found original journal paper (if any) */
  original_paper: PaperSummary | null;
  /** Relationship between papers */
  relationship: PaperRelationship;
  /** Confidence score (0-1) */
  confidence: number;
  /** Reason if not found */
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract first author's BAI or surname for search
 */
function extractFirstAuthorQuery(authors: string[]): string | null {
  if (!authors || authors.length === 0) return null;

  const firstAuthor = authors[0];
  // Handle "Surname, FirstName" format
  const commaMatch = firstAuthor.match(/^([^,]+),/);
  if (commaMatch) {
    return commaMatch[1].trim();
  }
  // Handle "FirstName Surname" format
  const parts = firstAuthor.trim().split(/\s+/);
  if (parts.length > 0) {
    return parts[parts.length - 1];
  }
  return null;
}

/**
 * Extract key words from title for matching
 */
function extractTitleKeywords(title: string): string[] {
  // Remove common words and punctuation
  const stopWords = new Set([
    'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'with',
    'from', 'by', 'at', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
    'new', 'study', 'analysis', 'results', 'measurement', 'measurements',
  ]);

  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
}

/**
 * Calculate similarity between two titles
 * Uses Jaccard similarity on keywords
 */
function calculateTitleSimilarity(title1: string, title2: string): number {
  const keywords1 = new Set(extractTitleKeywords(title1));
  const keywords2 = new Set(extractTitleKeywords(title2));

  if (keywords1.size === 0 || keywords2.size === 0) return 0;

  const intersection = new Set([...keywords1].filter(x => keywords2.has(x)));
  const union = new Set([...keywords1, ...keywords2]);

  return intersection.size / union.size;
}

/**
 * Check if two author lists have significant overlap
 */
function hasAuthorOverlap(authors1: string[], authors2: string[]): boolean {
  if (!authors1?.length || !authors2?.length) return false;

  const surnames1 = new Set(
    authors1.map(a => {
      const match = a.match(/^([^,]+),/);
      return match ? match[1].toLowerCase().trim() : a.split(/\s+/).pop()?.toLowerCase() || '';
    })
  );

  const surnames2 = new Set(
    authors2.map(a => {
      const match = a.match(/^([^,]+),/);
      return match ? match[1].toLowerCase().trim() : a.split(/\s+/).pop()?.toLowerCase() || '';
    })
  );

  // Check if first authors match (most important)
  const firstAuthor1 = [...surnames1][0];
  const firstAuthor2 = [...surnames2][0];
  if (firstAuthor1 && firstAuthor2 && firstAuthor1 === firstAuthor2) {
    return true;
  }

  // Check overlap ratio
  const overlap = [...surnames1].filter(s => surnames2.has(s)).length;
  const minSize = Math.min(surnames1.size, surnames2.size);
  return overlap / minSize >= 0.5;
}

/**
 * Determine relationship between conference and journal paper
 */
function determineRelationship(
  confPaper: PaperSummary,
  journalPaper: PaperSummary,
  titleSimilarity: number
): PaperRelationship {
  const confYear = confPaper.year || 0;
  const journalYear = journalPaper.year || 0;

  // Same content: very high similarity, similar year
  if (titleSimilarity >= 0.8) {
    return 'same_content';
  }

  // Extended: journal paper is later and has different title
  if (journalYear > confYear && titleSimilarity >= 0.5) {
    return 'extended';
  }

  // Preliminary: conference paper is later (unusual but possible)
  if (confYear > journalYear && titleSimilarity >= 0.5) {
    return 'preliminary';
  }

  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trace a conference paper to its original journal publication
 */
export async function traceToOriginal(
  params: TraceToOriginalParams
): Promise<TraceToOriginalResult> {
  const { recid, min_similarity = 0.6 } = params;

  // Step 1: Get the paper and check if it's a conference paper
  const paper = await api.getPaper(recid);
  const confCheck = isConferencePaper(paper);

  if (!confCheck.isConference) {
    return {
      success: false,
      conference_paper: paper,
      original_paper: null,
      relationship: 'unknown',
      confidence: 0,
      reason: 'Input paper is not a conference paper',
    };
  }

  // Step 2: Extract search parameters
  const firstAuthor = extractFirstAuthorQuery(paper.authors || []);
  if (!firstAuthor) {
    return {
      success: false,
      conference_paper: paper,
      original_paper: null,
      relationship: 'unknown',
      confidence: 0,
      reason: 'Could not extract author information',
    };
  }

  // Step 3: Search for journal papers by same first author
  // Exclude conference papers (tc:c) and reviews (tc:r)
  // Use 'and' operator to combine author with title keywords
  const titleKeywords = extractTitleKeywords(paper.title).slice(0, 3).join(' ');
  const searchQuery = `a:${firstAuthor} and t:${titleKeywords} not tc:c not tc:r`;

  const searchResult = await api.search(searchQuery, {
    sort: 'mostcited',
    // Avoid truncating candidate pool; INSPIRE allows up to 1000 per page.
    size: 1000,
  });

  if (searchResult.papers.length === 0) {
    return {
      success: false,
      conference_paper: paper,
      original_paper: null,
      relationship: 'unknown',
      confidence: 0,
      reason: 'No matching journal papers found',
    };
  }

  // Step 4: Find best matching paper
  let bestMatch: PaperSummary | null = null;
  let bestSimilarity = 0;

  for (const candidate of searchResult.papers) {
    // Skip if same paper
    if (candidate.recid === paper.recid) continue;

    // Check author overlap
    if (!hasAuthorOverlap(paper.authors || [], candidate.authors || [])) {
      continue;
    }

    // Calculate title similarity
    const similarity = calculateTitleSimilarity(paper.title, candidate.title);

    if (similarity > bestSimilarity && similarity >= min_similarity) {
      bestSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  if (!bestMatch) {
    return {
      success: false,
      conference_paper: paper,
      original_paper: null,
      relationship: 'unknown',
      confidence: 0,
      reason: `No journal paper with similarity >= ${min_similarity} found`,
    };
  }

  // Step 5: Determine relationship and return result
  const relationship = determineRelationship(paper, bestMatch, bestSimilarity);

  return {
    success: true,
    conference_paper: paper,
    original_paper: bestMatch,
    relationship,
    confidence: bestSimilarity,
  };
}

/**
 * Batch trace multiple papers, replacing conference papers with originals
 */
export async function batchTraceToOriginal(
  recids: string[],
  options?: { min_similarity?: number }
): Promise<{
  papers: PaperSummary[];
  traced: number;
  failed: number;
  trace_map: Map<string, string>; // conference recid -> original recid
}> {
  const papers: PaperSummary[] = [];
  const traceMap = new Map<string, string>();
  let traced = 0;
  let failed = 0;

  for (const recid of recids) {
    try {
      const paper = await api.getPaper(recid);
      const classified = classifyPaper(paper);

      if (classified.is_conference) {
        // Try to trace to original
        const result = await traceToOriginal({
          recid,
          min_similarity: options?.min_similarity,
        });

        if (result.success && result.original_paper) {
          papers.push(result.original_paper);
          traceMap.set(recid, result.original_paper.recid!);
          traced++;
        } else {
          // Keep conference paper if no original found
          papers.push(paper);
          failed++;
        }
      } else {
        // Not a conference paper, keep as is
        papers.push(paper);
      }
    } catch {
      // On error, try to get paper directly
      try {
        const paper = await api.getPaper(recid);
        papers.push(paper);
      } catch {
        failed++;
      }
    }
  }

  return { papers, traced, failed, trace_map: traceMap };
}
