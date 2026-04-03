/**
 * Find Emerging Papers Tool
 * Identifies papers with rapidly growing citation momentum
 * Enhanced with sociological metrics (New Entrant Ratio, Disruption Index)
 */

import * as api from '../../api/client.js';
import type { PaperSummary } from '@autoresearch/shared';
import { getConfig, getCurrentYear } from './config.js';
import { calculateMomentum, type CitationMomentum } from './citationMomentum.js';
import { classifyPaper } from './paperClassifier.js';
import { analyzeNewEntrants } from './newEntrantRatio.js';
import { calculateDisruptionIndex, type DisruptionDiagnostics } from './disruptionIndex.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SociologyOptions {
  disruption?: {
    max_refs_to_check?: number;
    max_refs_for_nj_query?: number;
    max_refs_for_nk_estimate?: number;
    nk_search_limit_fast?: number;
    nk_search_limit_full?: number;
  };
  new_entrant?: {
    lookback_years?: number;
    fast_mode_sample_size?: number;
  };
}

export interface FindEmergingParams {
  topic: string;
  time_range?: { start: number; end: number };
  limit?: number;
  min_citations?: number;
  min_momentum?: number;
  /** Enable sociological metrics (default: false) */
  include_sociology?: boolean;
  /** Sampling mode for sociology metrics (default: 'fast') */
  sample_mode?: 'full' | 'fast';
  sociology_options?: SociologyOptions;
}

export interface SociologyMetrics {
  new_entrant_ratio?: number;
  disruption_index?: number;
}

export interface EmergingPaperResult extends PaperSummary {
  recid?: string;
  title: string;
  authors: string[];
  year?: number;
  citation_count?: number;
  momentum: CitationMomentum;
  emergence_reason: string;
  /** Sociological metrics (only if include_sociology=true) */
  sociology?: SociologyMetrics;
  /** Emergence type classification */
  emergence_type: 'kinematic' | 'sociological' | 'both';
  /** Overall confidence */
  emergence_confidence: 'high' | 'medium' | 'low';
}

export interface FindEmergingResult {
  topic: string;
  papers: EmergingPaperResult[];
  total_candidates: number;
  /** Group-level new entrant ratio (if sociology enabled) */
  group_new_entrant_ratio?: number;
  warnings?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine emergence confidence based on kinematic and sociological signals
 */
function determineConfidence(
  momentum: CitationMomentum,
  sociology?: SociologyMetrics
): 'high' | 'medium' | 'low' {
  let score = 0;

  // Kinematic signals
  if (momentum.momentum_score >= 0.5) score += 2;
  else if (momentum.momentum_score >= 0.4) score += 1;

  if (momentum.acceleration >= 2) score += 1;
  if (momentum.is_hot) score += 1;

  // Sociological signals
  if (sociology?.new_entrant_ratio !== undefined && sociology.new_entrant_ratio >= 0.3) {
    score += 2;
  }
  if (sociology?.disruption_index !== undefined && sociology.disruption_index >= 0.2) {
    score += 2;
  }

  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

/**
 * Determine emergence type
 */
function determineEmergenceType(
  momentum: CitationMomentum,
  sociology?: SociologyMetrics
): 'kinematic' | 'sociological' | 'both' {
  const hasKinematic = momentum.momentum_score >= 0.4 || momentum.acceleration >= 1.5 || momentum.is_hot;

  const hasSociological = (
    (sociology?.new_entrant_ratio !== undefined && sociology.new_entrant_ratio >= 0.3) ||
    (sociology?.disruption_index !== undefined && sociology.disruption_index >= 0.2)
  );

  if (hasKinematic && hasSociological) return 'both';
  if (hasSociological) return 'sociological';
  return 'kinematic';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function findEmergingPapers(
  params: FindEmergingParams
): Promise<FindEmergingResult> {
  const config = getConfig();
  const { thresholds } = config;

  const {
    topic,
    time_range,
    limit = 10,
    min_citations = 20,
    min_momentum = thresholds.emergingMomentumThreshold,
    include_sociology = false,
    sample_mode = 'fast',
    sociology_options = {},
  } = params;

  const warnings: string[] = [];

  // Build query for papers in the emerging age range
  const currentYear = getCurrentYear();
  const minYear = currentYear - thresholds.emergingMaxAge;
  const maxYear = currentYear - thresholds.emergingMinAge;

  let query = `${topic} topcite:${min_citations}+ date:${minYear}->${maxYear}`;
  if (time_range) {
    query = `${topic} topcite:${min_citations}+ date:${time_range.start}->${time_range.end}`;
  }
  query += ' not tc:r'; // Exclude reviews

  // Search for candidate papers
  const candidateSize = Math.min(1000, Math.max(1, limit * 10));
  const result = await api.search(query, {
    sort: 'mostcited',
    size: candidateSize,
  });
  if (result.warning) warnings.push(`[emergingPapers] ${result.warning}`);
  if (result.has_more) {
    warnings.push(
      `[emergingPapers] Candidate search truncated (total=${result.total}, returned=${result.papers.length}, size=${candidateSize}). Increase limit or narrow the query for better coverage.`
    );
  }

  // Filter papers with valid recid
  const candidates = result.papers.filter(p => p.recid);

  // Calculate momentum for each candidate
  const emergingPapers: EmergingPaperResult[] = [];

  for (let i = 0; i < candidates.length && emergingPapers.length < limit * 2; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (paper) => {
        const momentum = await calculateMomentum(
          paper.recid!,
          paper.citation_count || 0
        );
        return { paper, momentum };
      })
    );

    for (const { paper, momentum } of batchResults) {
      if (momentum.is_emerging || momentum.momentum_score >= min_momentum) {
        const classified = classifyPaper(paper);
        if (classified.is_review) continue;

        const emergence_reason = buildEmergenceReason(momentum);

        emergingPapers.push({
          ...paper,
          momentum,
          emergence_reason,
          sociology: undefined,
          emergence_type: 'kinematic',
          emergence_confidence: determineConfidence(momentum, undefined),
        });
      }
    }
  }

  // OPTIMIZED: Calculate disruption index in parallel for all emerging papers
  if (include_sociology && emergingPapers.length > 0) {
    const disruptionResults = await Promise.all(
      emergingPapers.map(async (paper) => {
        if (!paper.recid) return null;
        try {
          const disruption = await calculateDisruptionIndex({
            recid: paper.recid,
            sample_mode,
            ...sociology_options.disruption,
          });
          return {
            recid: paper.recid,
            disruption_index: disruption.disruption_index,
            diagnostics: disruption.diagnostics,
          };
        } catch (err) {
          console.warn(`[emergingPapers] Disruption index failed for ${paper.recid}: ${(err as Error).message}`);
          return null;
        }
      })
    );

    type DisruptionRow = Exclude<(typeof disruptionResults)[number], null>;
    const nonNullResults: DisruptionRow[] = disruptionResults.filter((r): r is DisruptionRow => r !== null);

    // Merge disruption results back into papers
    const disruptionMap = new Map(
      nonNullResults.map(r => [r.recid, r.disruption_index])
    );

    // Aggregate disruption truncation diagnostics into warnings
    const disruptionDiagnostics: DisruptionDiagnostics[] = nonNullResults
      .map(r => r.diagnostics)
      .filter((d): d is DisruptionDiagnostics => Boolean(d));

    if (disruptionDiagnostics.length > 0) {
      const refsTruncated = disruptionDiagnostics.filter(d => d.refs_total > d.refs_used_for_set).length;
      const njSampled = disruptionDiagnostics.filter(d => d.nj_refs_available > d.nj_refs_used).length;
      const nkSampled = disruptionDiagnostics.filter(d => d.nk_refs_available > d.nk_refs_used).length;
      const nkTruncQueries = disruptionDiagnostics.reduce((sum, d) => sum + (d.nk_search_truncated_queries || 0), 0);
      const citationCap = disruptionDiagnostics.filter(d => Boolean(d.citations_total_warning)).length;

      const maxRefsUsed = Math.max(...disruptionDiagnostics.map(d => d.refs_used_for_set));
      const maxNjUsed = Math.max(...disruptionDiagnostics.map(d => d.nj_refs_used));
      const maxNkUsed = Math.max(...disruptionDiagnostics.map(d => d.nk_refs_used));
      const nkSearchLimit = disruptionDiagnostics[0].nk_search_limit;

      if (refsTruncated > 0) {
        warnings.push(
          `[emergingPapers] Disruption index: refs budget hit in ${refsTruncated}/${disruptionDiagnostics.length} paper(s) (max_refs_to_check≈${maxRefsUsed}).`
        );
      }
      if (njSampled > 0) {
        warnings.push(
          `[emergingPapers] Disruption index: N_j query samples refs in ${njSampled}/${disruptionDiagnostics.length} paper(s) (max_refs_for_nj_query≈${maxNjUsed}).`
        );
      }
      if (nkSampled > 0) {
        warnings.push(
          `[emergingPapers] Disruption index: N_k estimated from sampled refs in ${nkSampled}/${disruptionDiagnostics.length} paper(s) (max_refs_for_nk_estimate≈${maxNkUsed}).`
        );
      }
      if (nkTruncQueries > 0) {
        warnings.push(
          `[emergingPapers] Disruption index: N_k searches truncated in ${nkTruncQueries} query(ies) (nk_search_limit=${nkSearchLimit}).`
        );
      }
      if (citationCap > 0) {
        warnings.push(
          `[emergingPapers] Disruption index: ${citationCap}/${disruptionDiagnostics.length} paper(s) hit INSPIRE search cap warnings for citation totals; results may be incomplete.`
        );
      }
    }

    for (const paper of emergingPapers) {
      const disruption = paper.recid ? disruptionMap.get(paper.recid) : undefined;
      if (disruption !== undefined) {
        paper.sociology = { disruption_index: disruption };
        paper.emergence_type = determineEmergenceType(paper.momentum, paper.sociology);
        paper.emergence_confidence = determineConfidence(paper.momentum, paper.sociology);
      }
    }
  }

  // Sort by momentum score
  emergingPapers.sort((a, b) => b.momentum.momentum_score - a.momentum.momentum_score);

  const resultPapers = emergingPapers.slice(0, limit);

  // Calculate group-level new entrant ratio if sociology enabled
  let group_new_entrant_ratio: number | undefined;
  if (include_sociology && resultPapers.length > 0) {
    try {
      const entrantAnalysis = await analyzeNewEntrants({
        papers: resultPapers,
        topic,
        sample_mode,
        lookback_years: sociology_options.new_entrant?.lookback_years,
        fast_mode_sample_size: sociology_options.new_entrant?.fast_mode_sample_size,
      });
      group_new_entrant_ratio = entrantAnalysis.new_entrant_ratio;
      if (entrantAnalysis.warnings?.length) {
        warnings.push(...entrantAnalysis.warnings.map(w => `[emergingPapers] ${w}`));
      }

      // Update individual papers with group ratio
      for (const paper of resultPapers) {
        if (paper.sociology) {
          paper.sociology.new_entrant_ratio = group_new_entrant_ratio;
        } else {
          paper.sociology = { new_entrant_ratio: group_new_entrant_ratio };
        }
        // Recalculate type and confidence with new data
        paper.emergence_type = determineEmergenceType(paper.momentum, paper.sociology);
        paper.emergence_confidence = determineConfidence(paper.momentum, paper.sociology);
      }
    } catch (err) {
      console.warn(`[emergingPapers] New entrant analysis failed: ${(err as Error).message}`);
    }
  }

  return {
    topic,
    papers: resultPapers,
    total_candidates: result.total,
    group_new_entrant_ratio,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function buildEmergenceReason(momentum: CitationMomentum): string {
  const reasons: string[] = [];

  // Hot detection (monthly window) - prioritize this
  if (momentum.is_hot && momentum.hot_citations > 0) {
    reasons.push(`${momentum.hot_citations} citations in last 6 months (hot)`);
  }

  if (momentum.momentum_score >= 0.5) {
    reasons.push(`${Math.round(momentum.momentum_score * 100)}% of citations in last 2 years`);
  } else if (momentum.momentum_score >= 0.4) {
    reasons.push(`${Math.round(momentum.momentum_score * 100)}% recent citations`);
  }

  if (momentum.acceleration >= 2) {
    reasons.push(`${momentum.acceleration.toFixed(1)}x citation acceleration`);
  } else if (momentum.acceleration >= 1.5) {
    reasons.push(`growing ${momentum.acceleration.toFixed(1)}x faster`);
  }

  return reasons.length > 0 ? reasons.join(', ') : 'Rising citation trend';
}
