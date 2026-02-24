/**
 * Citation Momentum Calculator
 * Detects emerging papers based on recent citation growth
 */

import * as api from '../../api/client.js';
import type { PaperSummary } from '@autoresearch/shared';
import { getConfig, getCurrentYear } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CitationMomentum {
  total_citations: number;
  recent_citations: number;      // Last N years (default 2)
  hot_citations: number;         // Last N months (default 6)
  older_citations: number;
  momentum_score: number;        // 0-1, higher = faster growth
  acceleration: number;          // > 1 means accelerating
  is_emerging: boolean;          // Based on yearly window
  is_hot: boolean;               // Based on monthly window (rapid growth)
}

export interface EmergingPaper extends PaperSummary {
  momentum: CitationMomentum;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Note: Thresholds are now loaded from config.ts
// Use getConfig() to access current configuration

// ─────────────────────────────────────────────────────────────────────────────
// Momentum Calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate citation momentum for a paper
 * Uses INSPIRE API to get recent vs older citations
 */
export async function calculateMomentum(
  recid: string,
  totalCitations: number
): Promise<CitationMomentum> {
  const config = getConfig();
  const { thresholds } = config;

  const currentYear = getCurrentYear();
  const recentStart = currentYear - thresholds.recentYearsWindow;

  // Calculate hot window start date (months ago)
  const now = new Date();
  const hotStartDate = new Date(now);
  hotStartDate.setMonth(hotStartDate.getMonth() - thresholds.recentMonthsWindow);
  const hotStartStr = `${hotStartDate.getFullYear()}-${String(hotStartDate.getMonth() + 1).padStart(2, '0')}`;

  try {
    // Get recent citations count (yearly window)
    const recentResult = await api.search(
      `refersto:recid:${recid} date:${recentStart}->`,
      { size: 1 }
    );
    const recent_citations = recentResult.total;

    // Get hot citations count (monthly window)
    const hotResult = await api.search(
      `refersto:recid:${recid} date:${hotStartStr}->`,
      { size: 1 }
    );
    const hot_citations = hotResult.total;

    const older_citations = totalCitations - recent_citations;

    // Calculate momentum score (ratio of recent to total)
    const momentum_score = totalCitations > 0
      ? recent_citations / totalCitations
      : 0;

    // Calculate acceleration (recent rate vs older rate)
    const recentRate = recent_citations / thresholds.recentYearsWindow;
    const paperAge = 5; // Assume average age for calculation
    const olderYears = Math.max(paperAge - thresholds.recentYearsWindow, 1);
    const olderRate = older_citations / olderYears;
    const acceleration = olderRate > 0 ? recentRate / olderRate : recentRate;

    const is_emerging =
      momentum_score >= thresholds.emergingMomentumThreshold ||
      acceleration >= thresholds.emergingAccelerationThreshold;

    // Hot detection: significant citations in short window
    const hotRate = hot_citations / (thresholds.recentMonthsWindow / 12);
    const is_hot = hot_citations >= 10 && hotRate > recentRate * 1.5;

    return {
      total_citations: totalCitations,
      recent_citations,
      hot_citations,
      older_citations,
      momentum_score,
      acceleration,
      is_emerging,
      is_hot,
    };
  } catch {
    // Return default values on error
    return {
      total_citations: totalCitations,
      recent_citations: 0,
      hot_citations: 0,
      older_citations: totalCitations,
      momentum_score: 0,
      acceleration: 0,
      is_emerging: false,
      is_hot: false,
    };
  }
}

/**
 * Batch calculate momentum for multiple papers
 * Optimized to reduce API calls
 */
export async function batchCalculateMomentum(
  papers: PaperSummary[],
  maxConcurrent: number = 5
): Promise<Map<string, CitationMomentum>> {
  const config = getConfig();
  const { thresholds } = config;

  const results = new Map<string, CitationMomentum>();

  // Filter papers that are old enough to be "emerging" and have recid
  const eligiblePapers = papers.filter((p): p is PaperSummary & { recid: string } => {
    if (!p.recid) return false;
    const age = p.year ? getCurrentYear() - p.year : 0;
    return age >= thresholds.emergingMinAge && (p.citation_count || 0) > 10;
  });

  // Process in batches
  for (let i = 0; i < eligiblePapers.length; i += maxConcurrent) {
    const batch = eligiblePapers.slice(i, i + maxConcurrent);
    const batchResults = await Promise.all(
      batch.map(async (paper) => {
        const momentum = await calculateMomentum(
          paper.recid,
          paper.citation_count || 0
        );
        return { recid: paper.recid, momentum };
      })
    );

    for (const { recid, momentum } of batchResults) {
      results.set(recid, momentum);
    }
  }

  return results;
}
