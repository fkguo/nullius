/**
 * New Entrant Ratio Calculator
 * Detects paradigm shifts by analyzing author migration patterns
 */

import * as api from '../../api/client.js';
import type { PaperSummary } from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface NewEntrantParams {
  /** Papers to analyze */
  papers: PaperSummary[];
  /** Topic keywords for checking author history */
  topic: string;
  /** Sampling mode: 'full' for all authors, 'fast' for top authors only */
  sample_mode?: 'full' | 'fast';
  /** Sample size for fast mode (default: 20 authors) */
  fast_mode_sample_size?: number;
  /** Years to look back for author history (default: 5) */
  lookback_years?: number;
}

export interface NewEntrantAnalysis {
  /** Ratio of new entrants (0-1) */
  new_entrant_ratio: number;
  /** Number of new entrants */
  new_entrant_count: number;
  /** Total unique authors analyzed */
  total_unique_authors: number;
  /** Sample size (number of authors actually checked) */
  sample_size: number;
  /** Warnings about sampling / truncation */
  warnings?: string[];
  /** Notable new entrants (only in full mode) */
  notable_new_entrants?: string[];
  /** Sample mode used */
  sample_mode: 'full' | 'fast';
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_LOOKBACK_YEARS = 5;
const DEFAULT_FAST_MODE_SAMPLE_SIZE = 20;
const BATCH_SIZE = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanitize input for INSPIRE query to prevent injection
 */
function sanitizeQueryPart(input: string): string {
  // Remove special characters that could affect query parsing
  return input.replace(/[:"\\()[\]{}]/g, ' ').trim();
}

/**
 * Extract unique authors from papers
 * Returns authors sorted by total citations of their papers
 */
function extractUniqueAuthors(papers: PaperSummary[]): string[] {
  const authorCitations = new Map<string, number>();

  for (const paper of papers) {
    const citations = paper.citation_count || 0;
    for (const author of paper.authors || []) {
      const current = authorCitations.get(author) || 0;
      authorCitations.set(author, current + citations);
    }
  }

  // Sort by total citations (most influential first)
  return [...authorCitations.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([author]) => author);
}

/**
 * Check if an author has previous publications in a topic
 */
async function checkAuthorHistory(
  author: string,
  topic: string,
  lookbackYears: number
): Promise<boolean> {
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - lookbackYears;

  // Sanitize inputs to prevent query injection
  const safeAuthor = sanitizeQueryPart(author);
  const safeTopic = sanitizeQueryPart(topic);

  // Search for author's papers in this topic before lookback period
  // Use 'and' operator to combine author with topic search
  // Use keyword search (k:) for broader matching than title (t:)
  const query = `a:${safeAuthor} and k:${safeTopic} date:->${startYear - 1}`;

  const result = await api.search(query, { size: 1 });
  return result.total > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze new entrant ratio for a set of papers
 *
 * New entrants are authors who have no previous publications
 * in the topic before the lookback period.
 */
export async function analyzeNewEntrants(
  params: NewEntrantParams
): Promise<NewEntrantAnalysis> {
  const {
    papers,
    topic,
    sample_mode = 'fast',
    fast_mode_sample_size,
    lookback_years = DEFAULT_LOOKBACK_YEARS,
  } = params;

  const warnings: string[] = [];

  const truncatedAuthorPapers = papers.filter(p => (p.author_count ?? p.authors.length) > p.authors.length).length;
  if (truncatedAuthorPapers > 0) {
    warnings.push(
      `[newEntrantRatio] Author lists are truncated in ${truncatedAuthorPapers}/${papers.length} paper(s) (author_count>authors.length); analysis uses available author subset only.`
    );
  }

  // Extract unique authors
  const allAuthors = extractUniqueAuthors(papers);

  if (allAuthors.length === 0) {
    return {
      new_entrant_ratio: 0,
      new_entrant_count: 0,
      total_unique_authors: 0,
      sample_size: 0,
      sample_mode,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // Select sample based on mode
  const effectiveFastSampleSize = Math.max(
    1,
    Math.trunc(fast_mode_sample_size ?? DEFAULT_FAST_MODE_SAMPLE_SIZE)
  );
  const sampleAuthors = sample_mode === 'fast'
    ? allAuthors.slice(0, effectiveFastSampleSize)
    : allAuthors;

  if (sample_mode === 'fast' && sampleAuthors.length < allAuthors.length) {
    warnings.push(
      `[newEntrantRatio] Fast mode checks only top ${sampleAuthors.length}/${allAuthors.length} unique authors (fast_mode_sample_size=${effectiveFastSampleSize}). Use sample_mode="full" or increase fast_mode_sample_size for better coverage.`
    );
  }

  // Check each author's history
  const newEntrants: string[] = [];
  let checked = 0;
  let historyCheckErrors = 0;

  for (let i = 0; i < sampleAuthors.length; i += BATCH_SIZE) {
    const batch = sampleAuthors.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (author) => {
        try {
          const hasPreviousWork = await checkAuthorHistory(
            author,
            topic,
            lookback_years
          );
          return { author, isNewEntrant: !hasPreviousWork, ok: true as const };
        } catch {
          // Conservative fallback: treat as not a new entrant on error.
          return { author, isNewEntrant: false, ok: false as const };
        }
      })
    );

    for (const { author, isNewEntrant, ok } of results) {
      checked++;
      if (!ok) historyCheckErrors++;
      if (isNewEntrant) {
        newEntrants.push(author);
      }
    }
  }

  if (historyCheckErrors > 0) {
    warnings.push(
      `[newEntrantRatio] ${historyCheckErrors}/${checked} author history checks failed; conservative fallback treats them as not new entrants.`
    );
  }

  const new_entrant_ratio = checked > 0 ? newEntrants.length / checked : 0;

  return {
    new_entrant_ratio,
    new_entrant_count: newEntrants.length,
    total_unique_authors: allAuthors.length,
    sample_size: checked,
    warnings: warnings.length > 0 ? warnings : undefined,
    notable_new_entrants: sample_mode === 'full' ? newEntrants.slice(0, 10) : undefined,
    sample_mode,
  };
}
