/**
 * NPMI Distance Matrix for measuring semantic distance between arXiv categories
 *
 * NPMI (Normalized Pointwise Mutual Information) measures how often two categories
 * co-occur compared to what would be expected by chance.
 *
 * Distance = (1 - NPMI) / 2, mapped to [0, 1]
 * - 0: Categories always co-occur (high affinity)
 * - 1: Categories never co-occur (maximum distance)
 */

import * as api from '../../../api/client.js';
import { getDiskCache } from '../../../cache/diskCache.js';
import { HEP_CATEGORIES, SPECIFIC_DISTANCES, GROUP_DISTANCES, getCategoryGroup } from './categories.js';
import { getConfig } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MatrixData {
  categories: string[];
  counts: Record<string, number>;      // Single category counts
  pairCounts: Record<string, number>;  // Pair co-occurrence counts
  distances: Record<string, number>;   // Pre-computed distances
  totalPapers: number;
  timestamp: number;
  version: string;
}

export interface BuildProgress {
  phase: 'single' | 'pairs' | 'computing' | 'done';
  current: number;
  total: number;
  message: string;
}

export interface MatrixStats {
  categories: number;
  pairs: number;
  avgDistance: number;
  minDistance: { pair: string; value: number };
  maxDistance: { pair: string; value: number };
  lastUpdated: Date | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_KEY = 'npmi_distance_matrix';
const MATRIX_VERSION = '1.0.0';
const DEFAULT_DISTANCE = 0.5; // For unknown category pairs
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Module State
// ─────────────────────────────────────────────────────────────────────────────

let matrixData: MatrixData | null = null;
let isLoading = false;

// ─────────────────────────────────────────────────────────────────────────────
// NPMI Calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate NPMI between two categories
 * NPMI = PMI / -log(P(x,y))
 * Range: [-1, 1]
 */
function calculateNPMI(
  countA: number,
  countB: number,
  countAB: number,
  total: number
): number {
  if (countAB === 0) return -1; // Never co-occur
  if (countA === 0 || countB === 0) return 0;

  const pA = countA / total;
  const pB = countB / total;
  const pAB = countAB / total;

  const pmi = Math.log(pAB / (pA * pB));
  const npmi = pmi / (-Math.log(pAB));

  // Clamp to [-1, 1] due to floating point errors
  return Math.max(-1, Math.min(1, npmi));
}

/**
 * Convert NPMI to distance [0, 1]
 * NPMI = 1 (perfect co-occurrence) → Distance = 0
 * NPMI = -1 (never co-occur) → Distance = 1
 */
function npmiToDistance(npmi: number): number {
  return (1 - npmi) / 2;
}

/**
 * Generate pair key for consistent lookup
 */
function pairKey(catA: string, catB: string): string {
  return catA < catB ? `${catA}|${catB}` : `${catB}|${catA}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// API Queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get paper count for a single category
 * Uses INSPIRE "primarch" operator for primary arXiv category search
 * See: https://help.inspirehep.net/knowledge-base/inspire-paper-search/#eprints
 */
async function getCategoryCount(category: string): Promise<number> {
  const result = await api.search(`primarch:${category}`, { size: 1 });
  return result.total;
}

/**
 * Get paper count for category pair (co-occurrence)
 * Uses INSPIRE "primarch" operator for primary arXiv category search
 */
async function getPairCount(catA: string, catB: string): Promise<number> {
  const query = `primarch:${catA} and primarch:${catB}`;
  const result = await api.search(query, { size: 1 });
  return result.total;
}

/**
 * Delay helper
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Matrix Building
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the NPMI distance matrix from scratch
 * This is a long-running operation (~15-20 minutes)
 */
export async function buildMatrix(
  onProgress?: (progress: BuildProgress) => void
): Promise<MatrixData> {
  const categories = [...HEP_CATEGORIES];
  const counts: Record<string, number> = {};
  const pairCounts: Record<string, number> = {};

  // Phase 1: Get single category counts
  onProgress?.({ phase: 'single', current: 0, total: categories.length, message: 'Fetching category counts...' });

  for (let i = 0; i < categories.length; i += BATCH_SIZE) {
    const batch = categories.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(getCategoryCount));

    batch.forEach((cat, idx) => {
      counts[cat] = results[idx];
    });

    onProgress?.({ phase: 'single', current: i + batch.length, total: categories.length, message: `Fetched ${i + batch.length}/${categories.length} categories` });
    await delay(BATCH_DELAY_MS);
  }

  // Phase 2: Get pair counts
  const pairs: [string, string][] = [];
  for (let i = 0; i < categories.length; i++) {
    for (let j = i + 1; j < categories.length; j++) {
      pairs.push([categories[i], categories[j]]);
    }
  }

  onProgress?.({ phase: 'pairs', current: 0, total: pairs.length, message: 'Fetching pair counts...' });

  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(([a, b]) => getPairCount(a, b)));

    batch.forEach(([a, b], idx) => {
      pairCounts[pairKey(a, b)] = results[idx];
    });

    onProgress?.({ phase: 'pairs', current: i + batch.length, total: pairs.length, message: `Fetched ${i + batch.length}/${pairs.length} pairs` });
    await delay(BATCH_DELAY_MS);
  }

  // Phase 3: Compute distances
  onProgress?.({ phase: 'computing', current: 0, total: pairs.length, message: 'Computing NPMI distances...' });

  const totalPapers = Object.values(counts).reduce((a, b) => a + b, 0) / categories.length; // Approximate
  const distances: Record<string, number> = {};

  pairs.forEach(([a, b], idx) => {
    const key = pairKey(a, b);
    const npmi = calculateNPMI(counts[a], counts[b], pairCounts[key], totalPapers);
    distances[key] = npmiToDistance(npmi);

    if (idx % 100 === 0) {
      onProgress?.({ phase: 'computing', current: idx, total: pairs.length, message: `Computed ${idx}/${pairs.length} distances` });
    }
  });

  const data: MatrixData = {
    categories,
    counts,
    pairCounts,
    distances,
    totalPapers,
    timestamp: Date.now(),
    version: MATRIX_VERSION,
  };

  // Save to disk cache
  const diskCache = getDiskCache();
  const config = getConfig();
  await diskCache.set(CACHE_KEY, data, config.npmi?.matrixTTL || 30 * 24 * 60 * 60 * 1000);

  matrixData = data;
  onProgress?.({ phase: 'done', current: pairs.length, total: pairs.length, message: 'Matrix built successfully' });

  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Matrix Loading & Access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load matrix from disk cache
 */
export async function loadMatrix(): Promise<MatrixData | null> {
  if (matrixData) return matrixData;
  if (isLoading) return null;

  isLoading = true;
  try {
    const diskCache = getDiskCache();
    const data = await diskCache.get<MatrixData>(CACHE_KEY);

    if (data && data.version === MATRIX_VERSION) {
      matrixData = data;
      return data;
    }
    return null;
  } finally {
    isLoading = false;
  }
}

/**
 * Get distance between two categories
 * Priority: 1. Cached matrix 2. Specific distances 3. Group distances 4. Default
 */
export function getDistance(catA: string, catB: string): number {
  if (catA === catB) return 0;

  const key = pairKey(catA, catB);

  // 1. Check cached matrix first
  if (matrixData?.distances[key] !== undefined) {
    return matrixData.distances[key];
  }

  // 2. Check specific pre-computed distances
  if (SPECIFIC_DISTANCES[key] !== undefined) {
    return SPECIFIC_DISTANCES[key];
  }

  // 3. Check group-based distances
  const groupA = getCategoryGroup(catA);
  const groupB = getCategoryGroup(catB);

  if (groupA && groupB) {
    const groupDist = GROUP_DISTANCES[groupA]?.[groupB]
      ?? GROUP_DISTANCES[groupB]?.[groupA];
    if (groupDist !== undefined) {
      return groupDist;
    }
  }

  // 4. Default distance for unknown categories
  return DEFAULT_DISTANCE;
}

/**
 * Check if matrix is loaded
 */
export function isMatrixLoaded(): boolean {
  return matrixData !== null;
}

/**
 * Get matrix statistics
 */
export function getMatrixStats(): MatrixStats | null {
  if (!matrixData) return null;

  const distances = Object.entries(matrixData.distances);
  const values = distances.map(([, v]) => v);

  let minPair = { pair: '', value: 1 };
  let maxPair = { pair: '', value: 0 };

  distances.forEach(([pair, value]) => {
    if (value < minPair.value) minPair = { pair, value };
    if (value > maxPair.value) maxPair = { pair, value };
  });

  return {
    categories: matrixData.categories.length,
    pairs: distances.length,
    avgDistance: values.reduce((a, b) => a + b, 0) / values.length,
    minDistance: minPair,
    maxDistance: maxPair,
    lastUpdated: new Date(matrixData.timestamp),
  };
}
