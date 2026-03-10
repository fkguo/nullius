/**
 * Trace Original Source Tool
 * Traces citation chains to find original sources with cross-validation
 */

import * as api from '../../api/client.js';
import type { PaperSummary } from '@autoresearch/shared';
import { isReviewPaper, type ReviewPaperAssessment } from './paperClassifier.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TraceOriginalSourceParams {
  /** Starting paper recid */
  recid: string;
  /** Maximum trace depth (default: 3) */
  max_depth?: number;
  /** Maximum references per level (default: 3) */
  max_refs_per_level?: number;
  /** Enable cross-validation (default: true) */
  cross_validate?: boolean;
}

export type SourceConfidence = 'original' | 'likely_original' | 'secondary' | 'unknown';

export interface TracedSource extends PaperSummary {
  /** Confidence level */
  confidence: SourceConfidence;
  /** Confidence score (0-1) */
  confidence_score: number;
  /** Number of citation chains pointing to this source */
  chain_count: number;
  /** Number of independent (non-self-citation) chains */
  independent_chains: number;
  /** Number of self-citation chains */
  self_citation_chains: number;
  /** Depth in citation chain (0 = starting paper) */
  depth: number;
  /** Whether this is a review paper */
  is_review: boolean;
  /** Review classification provenance for fail-closed downstream consumers */
  review_classification: ReviewPaperAssessment;
}

export interface TraceOriginalSourceResult {
  /** Starting paper */
  starting_paper: PaperSummary;
  /** Identified original sources */
  original_sources: TracedSource[];
  /** All traced papers in the chain */
  trace_chain: TracedSource[];
  /** Trace statistics */
  stats: {
    total_traced: number;
    max_depth_reached: number;
    chains_analyzed: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract normalized author surnames for comparison
 * Handles formats like "Guo, Feng-Kun" or "F.K. Guo"
 */
function extractSurnames(authors: string[]): Set<string> {
  const surnames = new Set<string>();
  for (const author of authors) {
    // Handle "Surname, FirstName" format
    const commaMatch = author.match(/^([^,]+),/);
    if (commaMatch) {
      surnames.add(commaMatch[1].trim().toLowerCase());
      continue;
    }
    // Handle "F.K. Surname" or "FirstName Surname" format
    const parts = author.trim().split(/\s+/);
    if (parts.length > 0) {
      surnames.add(parts[parts.length - 1].toLowerCase());
    }
  }
  return surnames;
}

/**
 * Check if two papers share any authors (potential self-citation)
 */
function hasAuthorOverlap(paper1: PaperSummary, paper2: PaperSummary): boolean {
  if (!paper1.authors?.length || !paper2.authors?.length) return false;
  const surnames1 = extractSurnames(paper1.authors);
  const surnames2 = extractSurnames(paper2.authors);
  for (const surname of surnames1) {
    if (surnames2.has(surname)) return true;
  }
  return false;
}

/**
 * Get references for a paper, sorted by year (oldest first)
 */
async function getOldestReferences(recid: string, limit = 10): Promise<PaperSummary[]> {
  const refs = await api.getReferences(recid);
  return refs
    .filter(r => r.year)
    .sort((a, b) => (a.year || 9999) - (b.year || 9999))
    .slice(0, limit);
}

/**
 * Calculate self-citation adjustment score
 */
function calculateSelfCitationAdjustment(
  selfCitationChains: number,
  independentChains: number
): number {
  // Reward independent citations
  if (independentChains >= 2) {
    return 0.1;  // Multiple independent chains → high credibility
  } else if (independentChains === 1) {
    return 0.05;  // One independent chain
  }

  // Penalize pure self-citations (but not too much)
  if (selfCitationChains >= 2 && independentChains === 0) {
    return -0.1;  // Pure self-citation with multiple chains
  } else if (selfCitationChains === 1 && independentChains === 0) {
    return -0.15;  // Single self-citation chain → lowest credibility
  }

  return 0;
}

/**
 * Calculate source confidence based on multiple factors
 */
function calculateConfidence(
  chainCount: number,
  depth: number,
  isReview: boolean,
  hasOlderRefs: boolean,
  selfCitationChains: number,
  independentChains: number
): { confidence: SourceConfidence; score: number } {
  let score = 0;

  // Chain convergence: more chains = higher confidence
  score += Math.min(chainCount * 0.2, 0.4);

  // Depth: shallower = more likely secondary
  if (depth >= 2) score += 0.2;

  // Not a review paper
  if (!isReview) score += 0.2;

  // No older references = likely original
  if (!hasOlderRefs) score += 0.2;

  // Self-citation adjustment
  score += calculateSelfCitationAdjustment(selfCitationChains, independentChains);

  // Clamp score to [0, 1]
  score = Math.max(0, Math.min(1, score));

  // Determine confidence level
  let confidence: SourceConfidence;
  if (score >= 0.8) {
    confidence = 'original';
  } else if (score >= 0.5) {
    confidence = 'likely_original';
  } else if (score >= 0.3) {
    confidence = 'secondary';
  } else {
    confidence = 'unknown';
  }

  return { confidence, score };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function traceOriginalSource(
  params: TraceOriginalSourceParams
): Promise<TraceOriginalSourceResult> {
  const { recid, max_depth = 3, max_refs_per_level = 3, cross_validate = true } = params;

  // Get starting paper
  const startingPaper = await api.getPaper(recid);

  // Track visited papers with chain counts and self-citation info
  const visited = new Map<string, {
    paper: PaperSummary;
    depth: number;
    chainCount: number;
    selfCitationChains: number;
    independentChains: number;
  }>();
  const traceChain: TracedSource[] = [];

  // BFS to trace citation chains, tracking citing paper for self-citation detection
  let currentLevel = [{ paper: startingPaper, depth: 0, citingPaper: startingPaper }];
  let chainsAnalyzed = 0;
  let maxDepthReached = 0;

  for (let depth = 0; depth < max_depth && currentLevel.length > 0; depth++) {
    const nextLevel: { paper: PaperSummary; depth: number; citingPaper: PaperSummary }[] = [];

    for (const { paper, citingPaper } of currentLevel) {
      // Skip papers without recid
      if (!paper.recid) continue;

      // Check if this is a self-citation (citing paper shares authors with cited paper)
      const isSelfCitation = depth > 0 && hasAuthorOverlap(citingPaper, paper);

      if (visited.has(paper.recid)) {
        // Increment chain count for convergence
        const existing = visited.get(paper.recid)!;
        existing.chainCount++;
        if (isSelfCitation) {
          existing.selfCitationChains++;
        } else {
          existing.independentChains++;
        }
        continue;
      }

      visited.set(paper.recid, {
        paper,
        depth,
        chainCount: 1,
        selfCitationChains: isSelfCitation ? 1 : 0,
        independentChains: isSelfCitation ? 0 : 1,
      });
      chainsAnalyzed++;
      maxDepthReached = Math.max(maxDepthReached, depth);

      // Get oldest references
      if (depth < max_depth - 1) {
        const refs = await getOldestReferences(paper.recid, max_refs_per_level);
        for (const ref of refs) {
          nextLevel.push({ paper: ref, depth: depth + 1, citingPaper: paper });
        }
      }
    }

    currentLevel = nextLevel;
  }

  // Build trace chain with confidence scores
  for (const [, { paper, depth, chainCount, selfCitationChains, independentChains }] of visited) {
    // Skip papers without recid (shouldn't happen, but for type safety)
    if (!paper.recid) continue;

    const reviewCheck = isReviewPaper(paper);
    const refs = depth < max_depth - 1 ? await getOldestReferences(paper.recid, 1) : [];
    const hasOlderRefs = refs.length > 0;

    const { confidence, score } = calculateConfidence(
      chainCount, depth, reviewCheck.isReview, hasOlderRefs,
      selfCitationChains, independentChains
    );

    traceChain.push({
      ...paper,
      confidence,
      confidence_score: score,
      chain_count: chainCount,
      independent_chains: independentChains,
      self_citation_chains: selfCitationChains,
      depth,
      is_review: reviewCheck.isReview,
      review_classification: reviewCheck,
    });
  }

  // Sort by confidence score and filter original sources
  traceChain.sort((a, b) => b.confidence_score - a.confidence_score);

  const originalSources = traceChain.filter(
    p => (p.confidence === 'original' || p.confidence === 'likely_original') &&
         (!cross_validate || p.chain_count >= 2)
  );

  return {
    starting_paper: startingPaper,
    original_sources: originalSources,
    trace_chain: traceChain,
    stats: {
      total_traced: visited.size,
      max_depth_reached: maxDepthReached,
      chains_analyzed: chainsAnalyzed,
    },
  };
}
