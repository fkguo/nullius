/**
 * Field Survey Tool
 * Implements physicist's literature review workflow:
 * 1. Find reviews → extract seminal papers
 * 2. Analyze seminal papers → understand original ideas
 * 3. Trace citations → find important follow-up work
 * 4. Iterate → expand coverage
 * 5. Identify controversies and open questions
 */

import * as api from '../../api/client.js';
import type { PaperSummary } from '@autoresearch/shared';
import { isConferencePaper } from './paperClassifier.js';
import { traceToOriginal } from './traceToOriginal.js';
import { findSeminalPapers } from './seminalPapers.js';
import { detectConflicts, type ConflictAnalysis } from './conflictDetector.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FieldSurveyParams {
  /** Research topic */
  topic: string;
  /** Seed paper recid (for emerging fields without reviews) */
  seed_recid?: string;
  /** Number of iteration rounds (default: 2) */
  iterations?: number;
  /** Maximum total papers to collect (default: 150) */
  max_papers?: number;
  /** Focus areas */
  focus?: ('controversies' | 'open_questions' | 'methodology' | 'recent_progress')[];
  /** Prefer journal papers over conference papers (default: true) */
  prefer_journal?: boolean;
}

export interface ReviewPaper extends PaperSummary {
  /** Key topics covered */
  key_topics?: string[];
  /** Seminal papers mentioned (recids extracted from references) */
  seminal_refs?: string[];
}

export interface SeminalPaper extends PaperSummary {
  /** Core contribution/idea */
  contribution?: string;
  /** Discovery source: 'review_ref' | 'high_cited' | 'citation_trace' */
  discovery_source: string;
  /** Number of reviews citing this paper */
  review_mentions?: number;
}

export interface CitationCluster {
  /** Cluster theme */
  theme: string;
  /** Papers in cluster */
  papers: PaperSummary[];
  /** Key authors in cluster */
  key_authors: string[];
  /** Time range */
  year_range: { start: number; end: number };
}

export interface Controversy {
  /** Topic of controversy */
  topic: string;
  /** Papers supporting one view */
  papers_view_a: { recid: string; title: string; position?: string }[];
  /** Papers supporting opposing view */
  papers_view_b: { recid: string; title: string; position?: string }[];
  /** Current status */
  status: 'ongoing' | 'resolved' | 'unclear';
  /** Key papers discussing the controversy */
  discussion_papers?: string[];
  /** Numerical measurement conflicts (from conflictDetector) */
  measurement_conflicts?: ConflictAnalysis[];
}

export interface OpenQuestion {
  /** The question */
  question: string;
  /** Papers mentioning this question */
  mentioned_in: { recid: string; title: string }[];
  /** Recent progress (if any) */
  recent_progress?: string;
  /** Importance level */
  importance: 'fundamental' | 'technical' | 'open';
}

export interface FieldSurveyResult {
  topic: string;
  /** Best-effort warnings (non-fatal) */
  warnings: string[];
  /** Phase 1: Reviews found */
  reviews: {
    papers: ReviewPaper[];
    total_found: number;
  };
  /** Phase 2: Seminal papers */
  seminal_papers: {
    papers: SeminalPaper[];
    timeline: { year: number; milestone: string; recid: string }[];
  };
  /** Phase 3-4: Citation network expansion */
  citation_network: {
    /** All collected papers (deduplicated) */
    all_papers: PaperSummary[];
    /** Papers by iteration round */
    by_iteration: { round: number; papers_added: number }[];
    /** Identified clusters */
    clusters: CitationCluster[];
    /** Key authors in the field */
    key_authors: { name: string; paper_count: number; total_citations: number }[];
  };
  /** Phase 5: Controversies and open questions */
  analysis: {
    controversies: Controversy[];
    open_questions: OpenQuestion[];
    /** Field maturity assessment */
    field_status: {
      maturity: 'emerging' | 'growing' | 'mature' | 'declining';
      activity_trend: 'increasing' | 'stable' | 'decreasing';
      consensus_level: 'high' | 'medium' | 'low';
    };
  };
  /** Statistics */
  stats: {
    total_papers: number;
    total_reviews: number;
    total_seminal: number;
    iterations_completed: number;
    year_range: { start: number; end: number };
    conference_papers_traced: number;
    /** Entry mode: how the survey started */
    entry_mode: 'reviews' | 'seed_paper' | 'high_cited';
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ITERATIONS = 2;
const DEFAULT_MAX_PAPERS = 150;
const SEMINAL_MIN_CITATIONS = 100;
const IMPORTANT_PAPER_MIN_CITATIONS = 50;
const MAX_WARNINGS = 50;

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pushWarning(warnings: string[], message: string, error?: unknown): void {
  if (warnings.length >= MAX_WARNINGS) return;
  if (error === undefined) {
    warnings.push(message);
    return;
  }
  warnings.push(`${message}: ${formatErrorMessage(error)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Review Discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find review papers on the topic and extract seminal references
 */
async function discoverReviews(
  topic: string,
  warnings: string[],
  maxPapers: number
): Promise<{ reviews: ReviewPaper[]; seminalRecids: Set<string> }> {
  // Search for review papers
  const query = `${topic} tc:r topcite:50+`;
  const result = await api.searchAll(query, { sort: 'mostcited' });

  const reviews: ReviewPaper[] = [];
  const seminalRecids = new Set<string>();

  for (const paper of result.papers) {
    if (seminalRecids.size >= maxPapers) break;
    if (!paper.recid) continue;

    // Get references from each review
    let seminalRefs: string[] = [];
    try {
      const refs = await api.getReferences(paper.recid!);
      // Filter to high-cited references (likely seminal)
      const highCitedRefs = refs
        .filter(r => (r.citation_count || 0) >= SEMINAL_MIN_CITATIONS && Boolean(r.recid))
        .sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0));

      for (const ref of highCitedRefs) {
        if (seminalRecids.size >= maxPapers) break;
        if (!ref.recid) continue;
        seminalRecids.add(ref.recid);
        seminalRefs.push(ref.recid);
      }
    } catch (error) {
      pushWarning(warnings, `[discoverReviews] getReferences failed for review recid=${paper.recid}`, error);
    }

    reviews.push({
      ...paper,
      // Keep output manageable; full set is preserved in `seminalRecids`.
      seminal_refs: seminalRefs.slice(0, 20),
    });
  }

  return { reviews, seminalRecids };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Seminal Paper Analysis (with cross-validation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze seminal papers using cross-validation from multiple sources
 *
 * Cross-validation algorithm:
 * 1. Use findSeminalPapers which traces citation chains from multiple seeds
 * 2. Papers cited by multiple seeds are more likely to be true originals
 * 3. Merge with review-extracted references, counting mentions
 */
async function analyzeSeminalPapers(
  topic: string,
  reviewSeminalRecids: Set<string>,
  warnings: string[],
  maxPapers: number
): Promise<{
  papers: SeminalPaper[];
  timeline: { year: number; milestone: string; recid: string }[];
}> {
  const seminalPapers: SeminalPaper[] = [];
  const seenRecids = new Set<string>();

  // Step 1: Use findSeminalPapers for cross-validated discovery
  // This traces citation chains and finds papers cited by multiple high-cited papers
  try {
    const seminalResult = await findSeminalPapers({
      topic,
      limit: maxPapers,
      include_reviews: false,
      include_emerging: false,
    });

    for (const paper of seminalResult.seminal_papers) {
      if (paper.recid && !seenRecids.has(paper.recid)) {
        seenRecids.add(paper.recid);
        // traced_by_count indicates cross-validation strength
        const tracedByCount = (paper as { traced_by_count?: number }).traced_by_count || 1;
        seminalPapers.push({
          ...paper,
          discovery_source: 'citation_trace',
          review_mentions: tracedByCount,
        });
      }
    }
  } catch (error) {
    pushWarning(warnings, '[analyzeSeminalPapers] findSeminalPapers failed (falling back to high-cited search)', error);
  }

  // Step 2: Cross-reference with review-extracted papers
  // Papers found in both reviews and citation traces are stronger candidates
  if (reviewSeminalRecids.size > 0) {
    const recidList = Array.from(reviewSeminalRecids);
    const papers = await api.batchGetPapers(recidList);

    for (const paper of papers) {
      if (!paper.recid) continue;

      if (seenRecids.has(paper.recid)) {
        // Already found via citation trace - increment mention count
        const existing = seminalPapers.find(p => p.recid === paper.recid);
        if (existing) {
          existing.review_mentions = (existing.review_mentions || 0) + 1;
        }
      } else {
        // New paper from reviews
        seenRecids.add(paper.recid);
        seminalPapers.push({
          ...paper,
          discovery_source: 'review_ref',
          review_mentions: 1,
        });
      }
    }
  }

  // Step 3: Sort by cross-validation strength (review_mentions), then by citations
  seminalPapers.sort((a, b) => {
    const mentionDiff = (b.review_mentions || 0) - (a.review_mentions || 0);
    if (mentionDiff !== 0) return mentionDiff;
    return (b.citation_count || 0) - (a.citation_count || 0);
  });

  // Build timeline from top papers
  const timelinePapers = seminalPapers
    .filter(p => p.year)
    .sort((a, b) => (a.year || 0) - (b.year || 0));

  const timeline = timelinePapers
    .slice(0, 15)
    .map(p => ({
      year: p.year!,
      milestone: p.title.slice(0, 80) + (p.title.length > 80 ? '...' : ''),
      recid: p.recid!,
    }));

  return { papers: seminalPapers, timeline };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3-4: Citation Network Expansion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expand citation network iteratively
 */
async function expandCitationNetwork(
  seedRecids: string[],
  iterations: number,
  maxPapers: number,
  preferJournal: boolean,
  warnings: string[]
): Promise<{
  allPapers: Map<string, PaperSummary>;
  byIteration: { round: number; papers_added: number }[];
  conferencePapersTraced: number;
}> {
  const allPapers = new Map<string, PaperSummary>();
  const byIteration: { round: number; papers_added: number }[] = [];
  let conferencePapersTraced = 0;

  // Initialize with seeds
  const seedPapers = await api.batchGetPapers(seedRecids);
  for (const paper of seedPapers) {
    if (paper.recid) {
      allPapers.set(paper.recid, paper);
    }
  }
  byIteration.push({ round: 0, papers_added: seedPapers.length });

  // Iterative expansion
  let currentFrontier = new Set(seedRecids);

  for (let round = 1; round <= iterations; round++) {
    if (allPapers.size >= maxPapers) break;

    const newPapers = new Map<string, PaperSummary>();
    const frontierArray = Array.from(currentFrontier);

    for (const recid of frontierArray) {
      if (allPapers.size + newPapers.size >= maxPapers) break;

      try {
        const remainingBudget = Math.max(0, maxPapers - (allPapers.size + newPapers.size));
        // Fetch a sufficiently large candidate pool (bounded by INSPIRE API page limit).
        const fetchSize = Math.min(1000, Math.max(1, remainingBudget * 5));
        const minCitations = IMPORTANT_PAPER_MIN_CITATIONS / (round + 1);

        // Get citations (papers citing this one)
        const citations = await api.getCitations(recid, { size: fetchSize, sort: 'mostcited' });
        for (const paper of citations.papers) {
          if (paper.recid && !allPapers.has(paper.recid) && !newPapers.has(paper.recid)) {
            // Filter by importance
            if ((paper.citation_count || 0) >= minCitations) {
              newPapers.set(paper.recid, paper);
            }
          }
        }

        // Get references
        const refs = await api.getReferences(recid);
        const importantRefs = refs
          .filter(ref => Boolean(ref.recid) && (ref.citation_count || 0) >= minCitations)
          .sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0));
        for (const ref of importantRefs) {
          if (allPapers.size + newPapers.size >= maxPapers) break;
          if (!ref.recid || allPapers.has(ref.recid) || newPapers.has(ref.recid)) continue;
          newPapers.set(ref.recid, ref);
        }
      } catch (error) {
        pushWarning(warnings, `[expandCitationNetwork] citation/ref expansion failed for recid=${recid} (round ${round})`, error);
      }
    }

    // Trace conference papers to originals if preferred
    if (preferJournal) {
      for (const [recid, paper] of newPapers) {
        const confCheck = isConferencePaper(paper);
          if (confCheck.isConference) {
            try {
              const traceResult = await traceToOriginal({ recid });
              if (traceResult.success && traceResult.original_paper) {
                newPapers.delete(recid);
                if (!allPapers.has(traceResult.original_paper.recid!)) {
                  newPapers.set(traceResult.original_paper.recid!, traceResult.original_paper);
                }
                conferencePapersTraced++;
              }
            } catch (error) {
              pushWarning(warnings, `[expandCitationNetwork] traceToOriginal failed for conference recid=${recid}`, error);
            }
          }
        }
      }

    // Add new papers to collection
    for (const [recid, paper] of newPapers) {
      allPapers.set(recid, paper);
    }

    byIteration.push({ round, papers_added: newPapers.size });
    currentFrontier = new Set(newPapers.keys());
  }

  return { allPapers, byIteration, conferencePapersTraced };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: Controversy and Open Question Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect controversies by looking for "Comment on" papers and conflicting claims
 */
async function detectControversies(
  papers: PaperSummary[],
  topic: string,
  warnings: string[],
  maxPapers: number
): Promise<Controversy[]> {
  const controversies: Controversy[] = [];

  // Method 1: Search for "Comment on" papers in the field
  try {
    const commentQuery = `${topic} and t:comment`;
    const commentPageSize = Math.min(1000, Math.max(1, maxPapers));
    const commentResult = await api.search(commentQuery, { size: commentPageSize });
    if (commentResult.has_more) {
      pushWarning(
        warnings,
        `[detectControversies] Comment search truncated (total=${commentResult.total}, returned=${commentResult.papers.length}, size=${commentPageSize}). Consider increasing max_papers or narrowing topic.`
      );
    }

    if (commentResult.papers.length > 0) {
      const commentGroups = new Map<string, PaperSummary[]>();

      const refsResults = await Promise.all(
        commentResult.papers.map(async (comment) => {
          try {
            const refs = await api.getReferences(comment.recid!);
            const targetRecid = refs.find(r => typeof r.recid === 'string' && r.recid.length > 0)?.recid;
            return { comment, targetRecid };
          } catch (error) {
            pushWarning(warnings, `[detectControversies] getReferences failed for comment recid=${comment.recid}`, error);
            return { comment, targetRecid: undefined };
          }
        })
      );

      for (const { comment, targetRecid } of refsResults) {
        if (targetRecid) {
          if (!commentGroups.has(targetRecid)) {
            commentGroups.set(targetRecid, []);
          }
          commentGroups.get(targetRecid)!.push(comment);
        }
      }

      for (const [targetRecid, comments] of commentGroups) {
        if (comments.length >= 2) {
          const targetPaper = papers.find(p => p.recid === targetRecid);
          controversies.push({
            topic: targetPaper?.title || 'Unknown',
            papers_view_a: [{ recid: targetRecid, title: targetPaper?.title || 'Original paper' }],
            papers_view_b: comments.map(c => ({ recid: c.recid!, title: c.title })),
            status: 'ongoing',
            discussion_papers: comments.map(c => c.recid!),
          });
        }
      }
    }
  } catch (error) {
    pushWarning(warnings, '[detectControversies] comment-based detection failed', error);
  }

  // Method 2: Detect numerical measurement conflicts using conflictDetector
  try {
    const recids = papers.map(p => p.recid).filter((r): r is string => !!r);
    if (recids.length >= 2) {
      const conflictResult = await detectConflicts({ recids, min_tension_sigma: 2 });
      if (conflictResult.conflicts.length > 0) {
        // Group conflicts by quantity
        const byQuantity = new Map<string, ConflictAnalysis[]>();
        for (const c of conflictResult.conflicts) {
          if (!byQuantity.has(c.quantity)) byQuantity.set(c.quantity, []);
          byQuantity.get(c.quantity)!.push(c);
        }

        for (const [quantity, conflicts] of byQuantity) {
          const allRecids = new Set<string>();
          for (const c of conflicts) {
            for (const m of c.measurements) allRecids.add(m.recid);
          }
          const involvedPapers = papers.filter(p => p.recid && allRecids.has(p.recid));

          controversies.push({
            topic: `Measurement conflict: ${quantity}`,
            papers_view_a: involvedPapers.slice(0, 2).map(p => ({ recid: p.recid!, title: p.title })),
            papers_view_b: involvedPapers.slice(2, 4).map(p => ({ recid: p.recid!, title: p.title })),
            status: 'ongoing',
            measurement_conflicts: conflicts,
          });
        }
      }
    }
  } catch (error) {
    pushWarning(warnings, '[detectControversies] conflictDetector failed', error);
  }

  return controversies.slice(0, 5);
}

/**
 * Identify open questions from paper titles and abstracts
 */
function identifyOpenQuestions(papers: PaperSummary[]): OpenQuestion[] {
  const questions: OpenQuestion[] = [];
  const questionKeywords = [
    'open question', 'unsolved', 'puzzle', 'mystery', 'challenge',
    'future', 'outlook', 'prospect', 'remains unclear', 'not yet understood'
  ];

  // Look for papers with question-related keywords in title
  for (const paper of papers) {
    const titleLower = paper.title.toLowerCase();
    for (const keyword of questionKeywords) {
      if (titleLower.includes(keyword)) {
        questions.push({
          question: paper.title,
          mentioned_in: [{ recid: paper.recid!, title: paper.title }],
          importance: titleLower.includes('fundamental') ? 'fundamental' : 'open',
        });
        break;
      }
    }
  }

  return questions.slice(0, 10);
}

/**
 * Assess field status based on publication patterns
 */
function assessFieldStatus(
  papers: PaperSummary[]
): { maturity: 'emerging' | 'growing' | 'mature' | 'declining'; activity_trend: 'increasing' | 'stable' | 'decreasing'; consensus_level: 'high' | 'medium' | 'low' } {
  const currentYear = new Date().getFullYear();
  const years = papers.map(p => p.year).filter((y): y is number => !!y);

  if (years.length === 0) {
    return { maturity: 'emerging', activity_trend: 'stable', consensus_level: 'medium' };
  }

  const minYear = Math.min(...years);
  const fieldAge = currentYear - minYear;

  // Count papers by period
  const recentPapers = papers.filter(p => p.year && p.year >= currentYear - 3).length;
  const olderPapers = papers.filter(p => p.year && p.year < currentYear - 3).length;

  // Determine maturity
  let maturity: 'emerging' | 'growing' | 'mature' | 'declining';
  if (fieldAge < 10) maturity = 'emerging';
  else if (fieldAge < 25) maturity = 'growing';
  else maturity = 'mature';

  // Determine activity trend
  const recentRatio = recentPapers / (olderPapers + 1);
  let activity_trend: 'increasing' | 'stable' | 'decreasing';
  if (recentRatio > 0.5) activity_trend = 'increasing';
  else if (recentRatio > 0.2) activity_trend = 'stable';
  else activity_trend = 'decreasing';

  return { maturity, activity_trend, consensus_level: 'medium' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Clustering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple clustering by shared authors
 */
function clusterPapers(papers: PaperSummary[]): CitationCluster[] {
  // Group by first author surname
  const authorGroups = new Map<string, PaperSummary[]>();

  for (const paper of papers) {
    if (paper.authors && paper.authors.length > 0) {
      const firstAuthor = paper.authors[0];
      const surname = firstAuthor.split(',')[0]?.trim() || firstAuthor.split(' ').pop() || '';
      if (!authorGroups.has(surname)) {
        authorGroups.set(surname, []);
      }
      authorGroups.get(surname)!.push(paper);
    }
  }

  // Convert to clusters (only groups with 3+ papers)
  const clusters: CitationCluster[] = [];
  for (const [author, groupPapers] of authorGroups) {
    if (groupPapers.length >= 3) {
      const years = groupPapers.map(p => p.year).filter((y): y is number => !!y);
      clusters.push({
        theme: `${author} et al. contributions`,
        papers: groupPapers.slice(0, 10),
        key_authors: [author],
        year_range: {
          start: years.length > 0 ? Math.min(...years) : 2000,
          end: years.length > 0 ? Math.max(...years) : new Date().getFullYear(),
        },
      });
    }
  }

  return clusters.sort((a, b) => b.papers.length - a.papers.length).slice(0, 5);
}

/**
 * Extract key authors from paper collection
 */
function extractKeyAuthors(
  papers: PaperSummary[]
): { name: string; paper_count: number; total_citations: number }[] {
  const authorStats = new Map<string, { count: number; citations: number }>();

  for (const paper of papers) {
    const citations = paper.citation_count || 0;
    for (const author of (paper.authors || []).slice(0, 3)) {
      const stats = authorStats.get(author) || { count: 0, citations: 0 };
      stats.count++;
      stats.citations += citations;
      authorStats.set(author, stats);
    }
  }

  return Array.from(authorStats.entries())
    .map(([name, stats]) => ({
      name,
      paper_count: stats.count,
      total_citations: stats.citations,
    }))
    .sort((a, b) => b.total_citations - a.total_citations)
    .slice(0, 20);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Perform comprehensive field survey following physicist's workflow
 */
export async function performFieldSurvey(
  params: FieldSurveyParams
): Promise<FieldSurveyResult> {
  const warnings: string[] = [];
  const {
    topic,
    seed_recid,
    iterations = DEFAULT_ITERATIONS,
    max_papers = DEFAULT_MAX_PAPERS,
    focus = ['controversies', 'open_questions'],
    prefer_journal = true,
  } = params;

  // Determine entry mode and discover papers accordingly
  let reviews: ReviewPaper[] = [];
  let seminalRecids = new Set<string>();
  let entryMode: 'reviews' | 'seed_paper' | 'high_cited' = 'reviews';

  // Try to find reviews first (unless seed_recid is provided)
  if (!seed_recid) {
    const reviewResult = await discoverReviews(topic, warnings, max_papers);
    reviews = reviewResult.reviews;
    seminalRecids = reviewResult.seminalRecids;
  }

  // If no reviews found or seed_recid provided, use alternative entry
  if (reviews.length === 0 || seed_recid) {
    if (seed_recid) {
      // Entry via seed paper: trace its references to find seminal papers
      entryMode = 'seed_paper';
      try {
        const refs = await api.getReferences(seed_recid);
        // Filter to high-cited references
        const highCitedRefs = refs.filter(r => (r.citation_count || 0) >= 50);
        for (const ref of highCitedRefs.sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0))) {
          if (seminalRecids.size >= max_papers) break;
          if (ref.recid) seminalRecids.add(ref.recid);
        }
        // Also add the seed paper itself
        seminalRecids.add(seed_recid);
      } catch (error) {
        pushWarning(warnings, `[performFieldSurvey] getReferences failed for seed_recid=${seed_recid} (using seed paper only)`, error);
        seminalRecids.add(seed_recid);
      }
    } else {
      // Entry via high-cited papers (emerging field without reviews)
      entryMode = 'high_cited';
      // seminalRecids will be populated by analyzeSeminalPapers
    }
  }

  // Phase 2: Analyze seminal papers
  const { papers: seminalPapers, timeline } = await analyzeSeminalPapers(topic, seminalRecids, warnings, max_papers);

  // Phase 3-4: Expand citation network
  const seedRecids = seminalPapers.map(p => p.recid!).filter(Boolean);
  const { allPapers, byIteration, conferencePapersTraced } = await expandCitationNetwork(
    seedRecids,
    iterations,
    max_papers,
    prefer_journal,
    warnings
  );

  // Convert to array
  const allPapersArray = Array.from(allPapers.values());

  // Phase 5: Analysis
  let controversies: Controversy[] = [];
  let openQuestions: OpenQuestion[] = [];

  if (focus.includes('controversies')) {
    controversies = await detectControversies(allPapersArray, topic, warnings, max_papers);
  }

  if (focus.includes('open_questions')) {
    openQuestions = identifyOpenQuestions(allPapersArray);
  }

  // Clustering and author extraction
  const clusters = clusterPapers(allPapersArray);
  const keyAuthors = extractKeyAuthors(allPapersArray);

  // Field status assessment
  const fieldStatus = assessFieldStatus(allPapersArray);

  // Calculate year range
  const years = allPapersArray.map(p => p.year).filter((y): y is number => !!y);
  const yearRange = {
    start: years.length > 0 ? Math.min(...years) : 2000,
    end: years.length > 0 ? Math.max(...years) : new Date().getFullYear(),
  };

  return {
    topic,
    warnings,
    reviews: {
      papers: reviews,
      total_found: reviews.length,
    },
    seminal_papers: {
      papers: seminalPapers,
      timeline,
    },
    citation_network: {
      all_papers: allPapersArray,
      by_iteration: byIteration,
      clusters,
      key_authors: keyAuthors,
    },
    analysis: {
      controversies,
      open_questions: openQuestions,
      field_status: fieldStatus,
    },
    stats: {
      total_papers: allPapersArray.length,
      total_reviews: reviews.length,
      total_seminal: seminalPapers.length,
      iterations_completed: byIteration.length - 1,
      year_range: yearRange,
      conference_papers_traced: conferencePapersTraced,
      entry_mode: entryMode,
    },
  };
}
