/**
 * Disruption Index Calculator
 * Measures how much a paper disrupts vs consolidates existing literature
 *
 * Based on CD Index (Park et al. 2023):
 * D = (N_i - N_j) / (N_i + N_j + N_k)
 */

import * as api from '../../api/client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DisruptionParams {
  /** INSPIRE recid of target paper */
  recid: string;
  /** Sampling mode */
  sample_mode?: 'full' | 'fast';
  /**
   * Max reference recids to include from the target paper (default: 20).
   * This bounds query length and N_k estimation cost.
   */
  max_refs_to_check?: number;
  /** Max reference recids to include in the N_j query (default: 15) */
  max_refs_for_nj_query?: number;
  /** Max reference recids to use for N_k estimation (default: 5) */
  max_refs_for_nk_estimate?: number;
  /** Per-reference search size for N_k estimation in fast mode (default: 20) */
  nk_search_limit_fast?: number;
  /** Per-reference search size for N_k estimation in full mode (default: 50) */
  nk_search_limit_full?: number;
}

export interface DisruptionDiagnostics {
  citations_total: number;
  citations_total_warning?: string;
  refs_total: number;
  refs_used_for_set: number;
  nj_refs_available: number;
  nj_refs_used: number;
  nk_refs_available: number;
  nk_refs_used: number;
  nk_search_limit: number;
  nk_search_truncated_queries: number;
}

export interface DisruptionResult {
  /** Disruption index (-1 to 1) */
  disruption_index: number;
  /** Papers citing only target */
  n_i: number;
  /** Papers citing both target and its references */
  n_j: number;
  /** Papers citing only target's references (not target) - estimated */
  n_k: number;
  /** Total number of citing papers (from INSPIRE total) */
  sample_size: number;
  /** Interpretation */
  interpretation: 'disruptive' | 'consolidating' | 'neutral';
  /** Confidence based on sample size */
  confidence: 'high' | 'medium' | 'low';
  /** Note about approximations used */
  approximation_note?: string;
  /** Warnings about approximations / truncation */
  warnings?: string[];
  /** Diagnostics for reproducibility */
  diagnostics?: DisruptionDiagnostics;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_REFS_TO_CHECK = 20;
const DEFAULT_MAX_REFS_FOR_NJ_QUERY = 15;
const DEFAULT_MAX_REFS_FOR_NK_ESTIMATE = 5;
const DEFAULT_NK_SEARCH_LIMIT_FAST = 20;
const DEFAULT_NK_SEARCH_LIMIT_FULL = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get references of a paper as set of recids
 */
async function getAllRefRecids(recid: string): Promise<string[]> {
  try {
    const refs = await api.getReferences(recid);
    return refs
      .map(r => r.recid)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch (error) {
    console.debug(`[hep-research-mcp] getAllRefRecids (recid=${recid}): ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function hashStringToSeed(input: string): number {
  // FNV-1a 32-bit
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function deterministicSample<T>(items: T[], k: number, seedKey: string): T[] {
  if (k >= items.length) return items;
  const rng = mulberry32(hashStringToSeed(seedKey));
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, k);
}

/**
 * OPTIMIZED: Count papers citing both target AND any of its references
 * Uses INSPIRE search query instead of fetching references for each citing paper
 * Reduces API calls from O(N_citations) to O(1)
 *
 * NOTE: This is an approximation - samples references to keep query manageable.
 */
async function countPapersCitingBoth(
  targetRecid: string,
  refRecids: string[],
  maxRefsForQuery: number
): Promise<{ total: number; refs_available: number; refs_used: number }> {
  if (refRecids.length === 0) return { total: 0, refs_available: 0, refs_used: 0 };

  try {
    const refs_available = refRecids.length;
    const refs_used = Math.max(0, Math.min(maxRefsForQuery, refs_available));
    const sampledRefs = deterministicSample(refRecids, refs_used, `nj:${targetRecid}`);

    const refQuery = sampledRefs.map(r => `refersto:recid:${r}`).join(' or ');
    const query = `refersto:recid:${targetRecid} and (${refQuery})`;

    const result = await api.search(query, { size: 1 });
    return { total: result.total, refs_available, refs_used };
  } catch (error) {
    console.debug(`[hep-research-mcp] countPapersCitingBoth: ${error instanceof Error ? error.message : String(error)}`);
    return { total: 0, refs_available: refRecids.length, refs_used: Math.min(maxRefsForQuery, refRecids.length) };
  }
}

/**
 * Estimate N_k: papers citing target's references but not the target
 * Uses sampling of top references to reduce API calls
 */
async function estimateNk(
  targetRecid: string,
  refRecids: string[],
  options: { max_refs_for_estimate: number; search_limit: number }
): Promise<{ n_k: number; refs_available: number; refs_used: number; truncated_queries: number }> {
  const { max_refs_for_estimate, search_limit } = options;
  if (refRecids.length === 0) return { n_k: 0, refs_available: 0, refs_used: 0, truncated_queries: 0 };

  const refs_available = refRecids.length;
  const refs_used = Math.max(0, Math.min(max_refs_for_estimate, refs_available));
  // Deterministic sample to reduce bias vs "first N"
  const refsToCheck = deterministicSample(refRecids, refs_used, `nk:${targetRecid}`);

  let totalNk = 0;
  const seenCiters = new Set<string>();
  let truncated_queries = 0;

  for (const refRecid of refsToCheck) {
    try {
      // Search: papers citing this reference but NOT citing the target
      // INSPIRE query: refersto:recid:<ref> and not refersto:recid:<target>
      const query = `refersto:recid:${refRecid} and not refersto:recid:${targetRecid}`;
      const result = await api.search(query, {
        sort: 'mostcited',
        size: search_limit,
      });
      if (result.has_more || result.total > result.papers.length) truncated_queries++;

      // Count unique papers not already seen
      for (const paper of result.papers) {
        if (paper.recid && !seenCiters.has(paper.recid)) {
          seenCiters.add(paper.recid);
          totalNk++;
        }
      }
    } catch (error) {
      // Log at debug level for troubleshooting
      console.debug(`[hep-research-mcp] estimateNk (refRecid=${refRecid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
      // Skip this reference if search fails
      continue;
    }
  }

  // Scale up estimate based on sampling ratio
  if (refs_used > 0 && refs_used < refs_available) {
    const scaleFactor = refs_available / refs_used;
    totalNk = Math.round(totalNk * scaleFactor * 0.5); // Conservative scaling
  }

  return { n_k: totalNk, refs_available, refs_used, truncated_queries };
}

/**
 * Determine confidence level based on sample size
 */
function determineConfidence(sampleSize: number): 'high' | 'medium' | 'low' {
  if (sampleSize >= 50) return 'high';
  if (sampleSize >= 20) return 'medium';
  return 'low';
}

function downgradeConfidence(
  base: 'high' | 'medium' | 'low',
  steps: number
): 'high' | 'medium' | 'low' {
  const levels: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
  const idx = levels.indexOf(base);
  const nextIdx = Math.max(0, idx - Math.max(0, Math.trunc(steps)));
  return levels[nextIdx] ?? base;
}

/**
 * Interpret disruption index
 */
function interpretIndex(d: number): 'disruptive' | 'consolidating' | 'neutral' {
  if (d >= 0.2) return 'disruptive';
  if (d <= -0.2) return 'consolidating';
  return 'neutral';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate disruption index for a paper
 *
 * D = (N_i - N_j) / (N_i + N_j + N_k)
 *
 * where:
 * - N_i: Papers citing only the target
 * - N_j: Papers citing both target and its references
 * - N_k: Papers citing target's references but not target
 *
 * Note: N_k is expensive to compute and often approximated.
 * Here we focus on N_i and N_j for practical computation.
 */
export async function calculateDisruptionIndex(
  params: DisruptionParams
): Promise<DisruptionResult> {
  const {
    recid,
    sample_mode = 'fast',
    max_refs_to_check = DEFAULT_MAX_REFS_TO_CHECK,
    max_refs_for_nj_query = DEFAULT_MAX_REFS_FOR_NJ_QUERY,
    max_refs_for_nk_estimate = DEFAULT_MAX_REFS_FOR_NK_ESTIMATE,
    nk_search_limit_fast = DEFAULT_NK_SEARCH_LIMIT_FAST,
    nk_search_limit_full = DEFAULT_NK_SEARCH_LIMIT_FULL,
  } = params;

  const warnings: string[] = [];

  const citationsResult = await api.getCitations(recid, { size: 1 });
  const citations_total = citationsResult.total;
  if (citationsResult.warning) warnings.push(`[disruptionIndex] ${citationsResult.warning}`);

  if (citations_total === 0) {
    return {
      disruption_index: 0,
      n_i: 0,
      n_j: 0,
      n_k: 0,
      sample_size: 0,
      interpretation: 'neutral',
      confidence: 'low',
      warnings: warnings.length > 0 ? warnings : undefined,
      diagnostics: {
        citations_total: 0,
        citations_total_warning: citationsResult.warning,
        refs_total: 0,
        refs_used_for_set: 0,
        nj_refs_available: 0,
        nj_refs_used: 0,
        nk_refs_available: 0,
        nk_refs_used: 0,
        nk_search_limit: sample_mode === 'fast' ? nk_search_limit_fast : nk_search_limit_full,
        nk_search_truncated_queries: 0,
      },
    };
  }

  // Step 1: Get target paper's references (full list; we still apply local budgets for computation/query length)
  const allRefRecids = await getAllRefRecids(recid);
  const refs_total = allRefRecids.length;
  const refs_used_for_set = Math.max(0, Math.min(max_refs_to_check, refs_total));
  // Deterministic sample (avoid "first N" bias) while preserving reproducibility by recid.
  const refRecids = deterministicSample(allRefRecids, refs_used_for_set, `refs:${recid}`);

  if (refs_total > refs_used_for_set) {
    warnings.push(
      `[disruptionIndex] Sampling max_refs_to_check=${max_refs_to_check} of total_ref_recids=${refs_total} reference recids (deterministic by recid).`
    );
  }

  // Step 3: OPTIMIZED - Use search query to count papers citing both target AND its references
  // This reduces API calls from O(N_citations) to O(1)
  const nj = await countPapersCitingBoth(recid, refRecids, max_refs_for_nj_query);
  const n_j = Math.max(0, Math.min(nj.total, citations_total));
  const n_i = Math.max(0, citations_total - n_j);

  if (nj.refs_available > nj.refs_used) {
    warnings.push(
      `[disruptionIndex] N_j query samples max_refs_for_nj_query=${max_refs_for_nj_query} of ${nj.refs_available} reference recids (query-length budget).`
    );
  }

  // Note: N_k is papers citing target's references but not target
  // Estimate using sampling of references
  const nkSearchLimit = sample_mode === 'fast' ? nk_search_limit_fast : nk_search_limit_full;
  const nk = await estimateNk(recid, refRecids, {
    max_refs_for_estimate: max_refs_for_nk_estimate,
    search_limit: nkSearchLimit,
  });
  const n_k = nk.n_k;

  if (nk.refs_available > nk.refs_used) {
    warnings.push(
      `[disruptionIndex] N_k estimated from max_refs_for_nk_estimate=${max_refs_for_nk_estimate} sampled reference recids (available=${nk.refs_available}).`
    );
  }
  if (nk.truncated_queries > 0) {
    warnings.push(
      `[disruptionIndex] N_k searches truncated in ${nk.truncated_queries}/${nk.refs_used} reference queries (nk_search_limit=${nkSearchLimit}).`
    );
  }

  const denominator = n_i + n_j + n_k;
  const disruption_index = denominator > 0
    ? (n_i - n_j) / denominator
    : 0;

  const approximationHits =
    (refs_total > refs_used_for_set ? 1 : 0) +
    (nj.refs_available > nj.refs_used ? 1 : 0) +
    (nk.refs_available > nk.refs_used ? 1 : 0) +
    (nk.truncated_queries > 0 ? 1 : 0);
  const confidence = downgradeConfidence(determineConfidence(citations_total), Math.min(2, approximationHits));

  const hasNkEstimate = n_k > 0;
  return {
    disruption_index: Math.round(disruption_index * 1000) / 1000,
    n_i,
    n_j,
    n_k,
    sample_size: citations_total,
    interpretation: interpretIndex(disruption_index),
    confidence,
    approximation_note: hasNkEstimate
      ? 'N_k estimated from sampled reference recids'
      : 'N_k=0 (no references found or estimation failed)',
    warnings: warnings.length > 0 ? warnings : undefined,
    diagnostics: {
      citations_total,
      citations_total_warning: citationsResult.warning,
      refs_total,
      refs_used_for_set,
      nj_refs_available: nj.refs_available,
      nj_refs_used: nj.refs_used,
      nk_refs_available: nk.refs_available,
      nk_refs_used: nk.refs_used,
      nk_search_limit: nkSearchLimit,
      nk_search_truncated_queries: nk.truncated_queries,
    },
  };
}
