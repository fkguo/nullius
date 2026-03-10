/**
 * Find Seminal Papers - Enhanced Algorithm
 * Features:
 * - Paper type classification (review vs original)
 * - Emerging papers detection (recent citation growth)
 * - Citation quality scoring
 */

import * as api from '../../api/client.js';
import type { PaperSummary } from '@autoresearch/shared';
import { classifyPaper, type PaperType, type ReviewPaperAssessment } from './paperClassifier.js';
import { calculateMomentum, type CitationMomentum } from './citationMomentum.js';
import { getConfig, getCurrentYear } from './config.js';
import type { SemanticAssessmentProvenance } from './semantic/semanticProvenance.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FindSeminalParams {
  topic: string;
  time_range?: { start: number; end: number };
  limit?: number;
  include_reviews?: boolean;      // Include review papers (default: false)
  include_emerging?: boolean;     // Include emerging papers section (default: true)
  min_citations?: number;         // Minimum citations (default: 50)
}

export type PaperCategory = 'seminal' | 'emerging' | 'classic' | 'review';

export interface EnhancedSeminalPaper extends PaperSummary {
  seminal_score: number;
  category: PaperCategory;
  paper_type: PaperType;
  is_review: boolean;
  paper_type_provenance: SemanticAssessmentProvenance;
  review_classification: ReviewPaperAssessment;
  score_breakdown: {
    citation_score: number;
    age_score: number;
    influence_score: number;
    review_penalty: number;
  };
  momentum?: CitationMomentum;
  /** Number of seed papers citing this paper (for traced papers) */
  traced_by_count?: number;
}

/** Result from citation chain tracing */
interface TracedPaper {
  recid: string;
  paper: PaperSummary;
  /** Number of seed papers that cite this paper */
  cited_by_count: number;
  /** Recids of seed papers that cite this paper */
  cited_by_seeds: string[];
  /** Tracing score = cited_by_count × age_weight */
  trace_score: number;
}

export interface FindSeminalResult {
  topic: string;
  seminal_papers: EnhancedSeminalPaper[];
  emerging_papers: EnhancedSeminalPaper[];
  review_papers: EnhancedSeminalPaper[];
  total_candidates: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 5;
const SEED_COUNT = 50;           // Increased from 20 for better coverage
const MIN_TRACED_BY_COUNT = 2;   // Lowered from 3 for more results
const DEFAULT_LIMIT = 30;        // Increased from 10 for comprehensive surveys

// Note: Weights and thresholds are now loaded from config.ts

// ─────────────────────────────────────────────────────────────────────────────
// Citation Chain Tracing Algorithm
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trace foundational papers through citation chains
 *
 * Algorithm:
 * 1. Get high-cited papers as seeds (excluding reviews)
 * 2. Collect references from each seed
 * 3. Count how many seeds cite each reference
 * 4. Papers cited by multiple seeds are likely foundational
 * 5. Score by (cited_by_count × age_weight)
 */
async function traceFoundationalPapers(
  topic: string,
  options: {
    seedCount?: number;
    timeRange?: { start: number; end: number };
    minCitations?: number;
  } = {}
): Promise<{ traced: TracedPaper[]; totalSearched: number }> {
  const { seedCount = SEED_COUNT, timeRange, minCitations = 50 } = options;
  const currentYear = getCurrentYear();

  // Step 1: Determine citation threshold dynamically
  // Start with minCitations (default 50) which covers most fields including niche areas
  // The tracing algorithm itself filters by "cited by multiple seeds"
  let citationThreshold = minCitations;

  // For well-established fields, use higher threshold for better seed quality
  const probeQuery = `${topic} topcite:100+ not tc:r`;
  const probeResult = await api.search(probeQuery, { size: 1 });
  if (probeResult.total >= 20) {
    citationThreshold = 100;
  }

  // Step 2: Get high-cited papers as seeds (excluding reviews)
  let seedQuery = `${topic} topcite:${citationThreshold}+ not tc:r`;
  if (timeRange) {
    // For seeds, we want papers that could cite foundational work
    // So we don't restrict time range too much for seeds
    seedQuery = `${topic} topcite:${citationThreshold}+ not tc:r`;
  }

  const seedResult = await api.search(seedQuery, {
    sort: 'mostcited',
    size: seedCount,
  });

  const seeds = seedResult.papers.filter(p => {
    if (!p.recid) return false;
    const classified = classifyPaper(p);
    return classified.review_classification.decision !== 'review';
  });

  if (seeds.length === 0) {
    return { traced: [], totalSearched: seedResult.total };
  }

  // Step 3: Collect references from each seed
  const refStats = new Map<string, {
    count: number;
    paper?: PaperSummary;
    citedBy: string[];
  }>();

  // Process seeds in batches
  for (let i = 0; i < seeds.length; i += BATCH_SIZE) {
    const batch = seeds.slice(i, i + BATCH_SIZE);

    const batchRefs = await Promise.all(
      batch.map(async (seed) => {
        try {
          const refs = await api.getReferences(seed.recid!);
          return { seedRecid: seed.recid!, refs };
        } catch {
          return { seedRecid: seed.recid!, refs: [] };
        }
      })
    );

    for (const { seedRecid, refs } of batchRefs) {
      for (const ref of refs) {
        if (!ref.recid) continue;

        const existing = refStats.get(ref.recid);
        if (existing) {
          existing.count++;
          existing.citedBy.push(seedRecid);
        } else {
          refStats.set(ref.recid, {
            count: 1,
            paper: ref,
            citedBy: [seedRecid],
          });
        }
      }
    }
  }

  // Step 3: Filter papers cited by multiple seeds
  const candidates = [...refStats.entries()]
    .filter(([_, stats]) => stats.count >= MIN_TRACED_BY_COUNT)
    .map(([recid, stats]) => ({
      recid,
      paper: stats.paper!,
      cited_by_count: stats.count,
      cited_by_seeds: stats.citedBy,
    }));

  // Step 4: Calculate trace score with age weight
  const traced: TracedPaper[] = candidates.map(c => {
    const year = c.paper.year || currentYear;
    const age = currentYear - year;

    // Age weight: older papers get higher weight (max 2x)
    const ageWeight = Math.min(2, 1 + age / 30);
    const trace_score = c.cited_by_count * ageWeight;

    return { ...c, trace_score };
  });

  // Step 5: Sort by trace score
  const sorted = traced.sort((a, b) => b.trace_score - a.trace_score);
  return { traced: sorted, totalSearched: seedResult.total };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring Algorithm
// ─────────────────────────────────────────────────────────────────────────────

function calculateEnhancedScore(
  paper: PaperSummary,
  isReview: boolean
): {
  total: number;
  citation_score: number;
  age_score: number;
  influence_score: number;
  review_penalty: number;
} {
  const config = getConfig();
  const { weights, thresholds } = config;
  const currentYear = getCurrentYear();

  const citations = paper.citation_count || 0;
  const year = paper.year || currentYear;
  const age = currentYear - year;

  // Citation score: log scale, normalized
  const citation_score = citations > 0
    ? Math.min(1, Math.log10(citations + 1) / 4)
    : 0;

  // Age score: rewards early high-cited papers
  const age_score = age > 0 && citations > 0
    ? Math.min(1, (age / 20) * Math.log10(citations / (age * 10) + 1))
    : 0;

  // Influence score: citations per year, normalized
  const citationsPerYear = age > 0 ? citations / age : citations;
  const influence_score = Math.min(1, citationsPerYear / thresholds.highInfluenceCitationsPerYear);

  // Review penalty
  const review_penalty = isReview ? thresholds.reviewPenalty : 0;

  // Total score
  const rawTotal =
    weights.citation * citation_score +
    weights.age * age_score +
    weights.influence * influence_score;

  const total = rawTotal * (1 - review_penalty);

  return { total, citation_score, age_score, influence_score, review_penalty };
}

function categorize(
  paper: PaperSummary,
  isReview: boolean,
  momentum?: CitationMomentum
): PaperCategory {
  if (isReview) return 'review';

  const config = getConfig();
  const { thresholds } = config;
  const currentYear = getCurrentYear();

  const age = paper.year ? currentYear - paper.year : 0;
  const citations = paper.citation_count || 0;

  // Emerging: recent growth, not too old
  if (momentum?.is_emerging && age >= thresholds.emergingMinAge && age <= thresholds.emergingMaxAge) {
    return 'emerging';
  }

  // Seminal: old, high-cited, foundational
  if (age >= thresholds.seminalMinAge && citations >= thresholds.seminalMinCitations) {
    return 'seminal';
  }

  // Classic: high-cited but not necessarily foundational
  return 'classic';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function findSeminalPapers(
  params: FindSeminalParams
): Promise<FindSeminalResult> {
  const {
    topic,
    time_range,
    limit = DEFAULT_LIMIT,  // Use constant instead of hardcoded 10
    include_reviews = false,
    include_emerging = true,
    min_citations = 50,
  } = params;

  const seedCount = Math.min(1000, Math.max(SEED_COUNT, limit * 2));
  // PRIMARY ALGORITHM: Citation chain tracing
  // Find papers that are cited by multiple high-cited papers in the field
  const { traced: tracedPapers, totalSearched } = await traceFoundationalPapers(topic, {
    seedCount,
    timeRange: time_range,
    minCitations: min_citations,
  });

  // Convert traced papers to EnhancedSeminalPaper format
  const seminalFromTracing: EnhancedSeminalPaper[] = [];

  for (const traced of tracedPapers.slice(0, limit * 2)) {
      const paper = traced.paper;
      const classified = classifyPaper(paper);

      // Skip reviews
    if (classified.review_classification.decision === 'review') {
      continue;
    }

    const scores = calculateEnhancedScore(paper, false);

    seminalFromTracing.push({
      ...paper,
        seminal_score: traced.trace_score,
        category: 'seminal',
        paper_type: classified.paper_type,
        is_review: false,
        paper_type_provenance: classified.paper_type_provenance,
        review_classification: classified.review_classification,
        score_breakdown: scores,
        traced_by_count: traced.cited_by_count,
      });
  }

  // FALLBACK: If tracing yields few results, supplement with high-cited search
  let supplementalPapers: EnhancedSeminalPaper[] = [];

  if (seminalFromTracing.length < limit) {
    let query = topic;
    if (time_range) {
      query += ` date:${time_range.start}->${time_range.end}`;
    }
    query += ` topcite:${min_citations}+ not tc:r`;

    const result = await api.search(query, {
      sort: 'mostcited',
      size: Math.min(1000, Math.max(50, limit * 5)),
    });

    // Exclude papers already found by tracing
    const tracedRecids = new Set(seminalFromTracing.map(p => p.recid));

    for (const paper of result.papers) {
      if (tracedRecids.has(paper.recid)) continue;

      const classified = classifyPaper(paper);
      if (classified.is_review) continue;

      const scores = calculateEnhancedScore(paper, false);

      supplementalPapers.push({
        ...paper,
        seminal_score: scores.total,
        category: categorize(paper, false),
        paper_type: classified.paper_type,
        is_review: false,
        paper_type_provenance: classified.paper_type_provenance,
        review_classification: classified.review_classification,
        score_breakdown: scores,
      });
    }

    supplementalPapers.sort((a, b) => b.seminal_score - a.seminal_score);
  }

  // Combine traced (primary) + supplemental results
  const seminal = [
    ...seminalFromTracing,
    ...supplementalPapers.slice(0, limit - seminalFromTracing.length),
  ].slice(0, limit);

  // EMERGING PAPERS: Detect papers with recent citation growth
  let emerging: EnhancedSeminalPaper[] = [];

  if (include_emerging) {
    const config = getConfig();
    const { thresholds } = config;
    const currentYear = getCurrentYear();

    // Search for recent papers with good citations
    const emergingQuery = `${topic} topcite:20+ date:${currentYear - thresholds.emergingMaxAge}->${currentYear - thresholds.emergingMinAge} not tc:r`;

    const emergingResult = await api.search(emergingQuery, {
      sort: 'mostcited',
      size: Math.min(1000, Math.max(30, limit * 5)),
    });

    const emergingCandidates = emergingResult.papers.filter(p => p.recid);

    // Calculate momentum in parallel
    const candidateBudget = Math.min(emergingCandidates.length, Math.max(20, limit * 5));
    const momentumResults = await Promise.all(
      emergingCandidates.slice(0, candidateBudget).map(async (paper) => {
        try {
          const momentum = await calculateMomentum(
            paper.recid!,
            paper.citation_count || 0
          );
          return { paper, momentum };
        } catch {
          return { paper, momentum: null };
        }
      })
    );

    for (const { paper, momentum } of momentumResults) {
      if (momentum?.is_emerging) {
        const classified = classifyPaper(paper);
        const scores = calculateEnhancedScore(paper, classified.is_review);

        emerging.push({
          ...paper,
          seminal_score: scores.total,
          category: 'emerging',
          paper_type: classified.paper_type,
          is_review: classified.is_review,
          paper_type_provenance: classified.paper_type_provenance,
          review_classification: classified.review_classification,
          score_breakdown: scores,
          momentum,
        });
      }
    }

    emerging.sort((a, b) =>
      (b.momentum?.momentum_score || 0) - (a.momentum?.momentum_score || 0)
    );
    emerging = emerging.slice(0, Math.ceil(limit / 2));
  }

  // REVIEW PAPERS (if requested)
  let reviews: EnhancedSeminalPaper[] = [];

  if (include_reviews) {
    const reviewQuery = `${topic} topcite:${min_citations}+ tc:r`;
    const reviewResult = await api.search(reviewQuery, {
      sort: 'mostcited',
      size: Math.min(1000, Math.max(20, limit * 2)),
    });

    for (const paper of reviewResult.papers) {
      const classified = classifyPaper(paper);
      const scores = calculateEnhancedScore(paper, true);

      reviews.push({
        ...paper,
        seminal_score: scores.total,
        category: 'review',
        paper_type: classified.paper_type,
        is_review: true,
        paper_type_provenance: classified.paper_type_provenance,
        review_classification: classified.review_classification,
        score_breakdown: scores,
      });
    }

    reviews = reviews.slice(0, Math.ceil(limit / 2));
  }

  return {
    topic,
    seminal_papers: seminal,
    emerging_papers: emerging,
    review_papers: reviews,
    total_candidates: totalSearched,  // Total papers searched, not just returned results
  };
}
