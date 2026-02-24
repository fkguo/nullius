/**
 * Find Crossover Topics Tool
 * Discovers emerging interdisciplinary research areas
 */

import * as api from '../../api/client.js';
import type { PaperSummary } from '@autoresearch/shared';
import { getConfig, getCurrentYear } from './config.js';
import { getDistance } from './npmi/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FindCrossoverParams {
  categories?: [string, string];  // Specific pair to analyze
  scan_popular?: boolean;         // Scan predefined popular pairs
  analyze_from_category?: string; // NEW: Analyze cross-list patterns from a primary category
  time_range?: { start: number; end: number };
  min_papers?: number;            // Minimum papers for valid crossover
  limit?: number;                 // Max results
}

export interface CrossoverMetrics {
  total_papers: number;
  recent_papers: number;
  crossover_intensity: number;    // CI = N(A∩B) / sqrt(N(A) × N(B))
  trend_ratio: number;            // CT = CI_recent / CI_historical
  acceleration: number;           // Growth acceleration (new metric)
  is_emerging: boolean;
}

export interface CrossoverResult {
  category_pair: [string, string];
  distance: number;               // NPMI Distance
  confidence: 'high' | 'medium' | 'low';
  reason: string;                 // Why it was flagged
  metrics: CrossoverMetrics;
  key_papers: PaperSummary[];
  bridge_authors: { name: string; paper_count: number }[];
  topics: string[];
}

export interface FindCrossoverResult {
  crossovers: CrossoverResult[];
  scan_mode: 'specific' | 'popular_pairs' | 'from_category';
  total_pairs_analyzed: number;
  // NEW: Cross-list analysis results (when using analyze_from_category)
  cross_list_analysis?: {
    primary_category: string;
    papers_analyzed: number;
    cross_list_distribution: { category: string; count: number; percentage: number }[];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 3;

// Popular crossover pairs in HEP (using specific sub-categories for accurate distance lookup)
const POPULAR_CROSSOVER_PAIRS: [string, string][] = [
  ['hep-th', 'cond-mat.str-el'],   // AdS/CMT (D=0.45)
  ['hep-th', 'cond-mat.stat-mech'], // Statistical mechanics crossover (D=0.46)
  ['hep-ex', 'cs.LG'],             // ML for HEP experiments (D=0.46)
  ['hep-ph', 'cs.LG'],             // ML for phenomenology (D=0.55)
  ['gr-qc', 'astro-ph.HE'],        // Multi-messenger astronomy (D=0.48)
  ['hep-th', 'quant-ph'],          // Quantum information + HEP (D=0.60)
  ['hep-lat', 'cond-mat.stat-mech'], // Lattice methods (D=0.46)
  ['hep-th', 'math-ph'],           // Mathematical physics (D=0.41)
  ['hep-ph', 'astro-ph.CO'],       // Cosmology phenomenology (D=0.50)
  ['nucl-th', 'quant-ph'],         // Nuclear + quantum (D=0.64)
];

// Thresholds loaded from config (see config.ts for defaults)
// - distanceThresholdCore: 0.4 (below = related/core, ignore)
// - distanceThresholdCrossover: 0.6 (above = true crossover)
// - accelerationThreshold: 0.1 (10% growth for ambiguous pairs)

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query papers count for a category or category pair
 */
async function getCategoryCount(
  categories: string | [string, string],
  dateRange?: { start: number; end: number }
): Promise<number> {
  // INSPIRE uses "primarch" operator for primary arXiv category search
  // See: https://help.inspirehep.net/knowledge-base/inspire-paper-search/#eprints
  let query: string;
  if (Array.isArray(categories)) {
    query = `primarch:${categories[0]} and primarch:${categories[1]}`;
  } else {
    query = `primarch:${categories}`;
  }

  if (dateRange) {
    query += ` date:${dateRange.start}->${dateRange.end}`;
  }

  const result = await api.search(query, { size: 1 });
  return result.total;
}

/**
 * Analyze a single category pair for crossover
 */
async function analyzeCrossoverPair(
  pair: [string, string],
  timeRange?: { start: number; end: number }
): Promise<CrossoverResult | null> {
  const config = getConfig();
  const recentYears = config.thresholds.crossoverRecentYears;
  const emergingThreshold = config.thresholds.crossoverEmergingThreshold;
  const minRecentPapers = config.thresholds.crossoverMinRecentPapers;

  // Crossover detection thresholds from config
  const distanceCore = config.crossoverDetection?.distanceThresholdCore ?? 0.4;
  const distanceCrossover = config.crossoverDetection?.distanceThresholdCrossover ?? 0.6;
  const accelerationThreshold = config.crossoverDetection?.accelerationThreshold ?? 0.1;

  const recentStart = getCurrentYear() - recentYears;
  const recentRange = { start: recentStart, end: getCurrentYear() };

  // 1. Check NPMI Distance first (Fast Filter)
  const distance = getDistance(pair[0], pair[1]);

  // Tier 1: Core/Related -> Ignore immediately
  if (distance < distanceCore) {
    return null;
  }

  // Get counts in parallel
  const [totalCross, recentCross, countA, countB] = await Promise.all([
    getCategoryCount(pair, timeRange),
    getCategoryCount(pair, recentRange),
    getCategoryCount(pair[0]),
    getCategoryCount(pair[1]),
  ]);

  if (totalCross < 5) return null; // Too few papers

  // Calculate crossover intensity
  const ci = totalCross / Math.sqrt(countA * countB);

  // Calculate trend ratio & acceleration
  const historicalYears = timeRange
    ? timeRange.end - timeRange.start - recentYears
    : 10;
  const historicalCross = totalCross - recentCross;
  
  const rateRecent = recentCross / recentYears;
  const rateHistorical = historicalCross / Math.max(historicalYears, 1);
  
  const trendRatio = rateHistorical > 0 ? rateRecent / rateHistorical : rateRecent;
  
  // Acceleration: (Rate_Recent - Rate_Historical) / Rate_Historical
  // Represents percentage growth in publication rate
  const acceleration = rateHistorical > 0 
    ? (rateRecent - rateHistorical) / rateHistorical 
    : 1.0; // 100% growth if new

  // Tiered Classification Logic
  let confidence: 'high' | 'medium' | 'low' = 'low';
  let reason = '';

  if (distance >= distanceCrossover) {
    // Tier 3: True Crossover (High Distance)
    confidence = 'high';
    reason = `High semantic distance (${distance.toFixed(2)}). Distinct fields.`;

    if (trendRatio > emergingThreshold) {
      reason += ' Showing emerging growth.';
    }
  } else {
    // Tier 2: Ambiguous (Medium Distance)
    // Must show acceleration to be considered a crossover
    if (acceleration > accelerationThreshold) {
      confidence = 'medium';
      reason = `Medium distance (${distance.toFixed(2)}) but accelerating growth (+${(acceleration * 100).toFixed(0)}%).`;
    } else {
      // Stagnant medium distance -> likely just a standard overlap
      return null;
    }
  }

  const isEmerging = trendRatio >= emergingThreshold && recentCross >= minRecentPapers;

  // Get key papers (use primarch for arXiv category search)
  const query = `primarch:${pair[0]} and primarch:${pair[1]}`;
  const papersResult = await api.search(query, { sort: 'mostcited', size: 1000 });

  // Extract bridge authors
  const authorCounts = new Map<string, number>();
  for (const paper of papersResult.papers) {
    for (const author of paper.authors.slice(0, 3)) {
      authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
    }
  }
  const bridgeAuthors = [...authorCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, paper_count]) => ({ name, paper_count }));

  // Extract topics from titles
  const topics = extractTopics(papersResult.papers);

  return {
    category_pair: pair,
    distance,
    confidence,
    reason,
    metrics: {
      total_papers: totalCross,
      recent_papers: recentCross,
      crossover_intensity: ci,
      trend_ratio: trendRatio,
      acceleration,
      is_emerging: isEmerging,
    },
    key_papers: papersResult.papers.slice(0, 5),
    bridge_authors: bridgeAuthors,
    topics,
  };
}

/**
 * Extract common topics from paper titles
 */
function extractTopics(papers: PaperSummary[]): string[] {
  const wordCounts = new Map<string, number>();
  const stopWords = new Set([
    'the', 'a', 'an', 'in', 'on', 'of', 'for', 'and', 'or', 'to', 'with',
    'from', 'by', 'at', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  ]);

  for (const paper of papers) {
    const words = paper.title.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w));

    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }
  }

  return [...wordCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

/**
 * Analyze cross-list patterns from papers in a primary category
 * Uses arxiv_categories field to discover actual cross-list behavior
 */
async function analyzeCrossListPatterns(
  primaryCategory: string,
  timeRange?: { start: number; end: number },
  sampleSize: number = 100
): Promise<{
  papers_analyzed: number;
  cross_list_distribution: { category: string; count: number; percentage: number }[];
  discovered_pairs: [string, string][];
}> {
  // Search for papers in the primary category (use primarch for arXiv category)
  let query = `primarch:${primaryCategory}`;
  if (timeRange) {
    query += ` date:${timeRange.start}->${timeRange.end}`;
  }

  const result = await api.search(query, { sort: 'mostrecent', size: sampleSize });

  // Get threshold from config
  const config = getConfig();
  const distanceCore = config.crossoverDetection?.distanceThresholdCore ?? 0.4;

  // Count cross-list categories (excluding related categories)
  const crossListCounts = new Map<string, number>();
  const relatedCounts = new Map<string, number>(); // Track related for info

  for (const paper of result.papers) {
    const categories = paper.arxiv_categories || [];
    if (categories.length > 1) {
      // Skip the primary category, count others
      for (const cat of categories) {
        if (cat !== primaryCategory) {
          const distance = getDistance(primaryCategory, cat);
          if (distance < distanceCore) {
            // Related category - not a true crossover
            relatedCounts.set(cat, (relatedCounts.get(cat) || 0) + 1);
          } else {
            // True crossover
            crossListCounts.set(cat, (crossListCounts.get(cat) || 0) + 1);
          }
        }
      }
    }
  }

  // Build distribution
  const distribution = [...crossListCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({
      category,
      count,
      percentage: Math.round((count / result.papers.length) * 100),
    }));

  // Discover top pairs for further analysis
  const discovered_pairs: [string, string][] = distribution
    .slice(0, 5)
    .map(({ category }) => [primaryCategory, category] as [string, string]);

  return {
    papers_analyzed: result.papers.length,
    cross_list_distribution: distribution,
    discovered_pairs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function findCrossoverTopics(
  params: FindCrossoverParams
): Promise<FindCrossoverResult> {
  const {
    categories,
    scan_popular = true,
    analyze_from_category,
    time_range,
    min_papers = 5,
    limit = 10,
  } = params;

  const crossovers: CrossoverResult[] = [];
  let pairsToAnalyze: [string, string][];
  let crossListAnalysis: FindCrossoverResult['cross_list_analysis'];

  // NEW: Analyze cross-list patterns from a primary category
  if (analyze_from_category) {
    const patterns = await analyzeCrossListPatterns(
      analyze_from_category,
      time_range
    );

    crossListAnalysis = {
      primary_category: analyze_from_category,
      papers_analyzed: patterns.papers_analyzed,
      cross_list_distribution: patterns.cross_list_distribution,
    };

    // Use discovered pairs for detailed analysis
    pairsToAnalyze = patterns.discovered_pairs;
  } else if (categories) {
    // Analyze specific pair
    pairsToAnalyze = [categories];
  } else if (scan_popular) {
    // Scan popular pairs
    pairsToAnalyze = POPULAR_CROSSOVER_PAIRS;
  } else {
    return { crossovers: [], scan_mode: 'specific', total_pairs_analyzed: 0 };
  }

  // Analyze pairs in parallel batches
  for (let i = 0; i < pairsToAnalyze.length; i += BATCH_SIZE) {
    const batch = pairsToAnalyze.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (pair) => {
        try {
          return await analyzeCrossoverPair(pair, time_range);
        } catch {
          return null;
        }
      })
    );

    for (const result of batchResults) {
      if (result && result.metrics.total_papers >= min_papers) {
        crossovers.push(result);
      }
    }
  }

  // Sort by trend ratio (emerging first)
  crossovers.sort((a, b) => b.metrics.trend_ratio - a.metrics.trend_ratio);

  // Determine scan mode
  const scan_mode = analyze_from_category
    ? 'from_category'
    : categories
      ? 'specific'
      : 'popular_pairs';

  return {
    crossovers: crossovers.slice(0, limit),
    scan_mode,
    total_pairs_analyzed: pairsToAnalyze.length,
    cross_list_analysis: crossListAnalysis,
  };
}
