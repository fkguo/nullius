/**
 * Network Analysis Tool (Consolidated)
 * Combines: citation_network, collaboration_network
 *
 * Modes:
 * - 'citation': Analyze citation network around a paper (PageRank)
 * - 'collaboration': Analyze co-authorship patterns
 */

import { buildCitationNetwork, type CitationNetworkResult } from './citationNetwork.js';
import { buildCollaborationNetwork, type CollaborationNetworkResult } from './collaborationNetwork.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type NetworkMode = 'citation' | 'collaboration';

export interface NetworkAnalysisParams {
  /** Analysis mode */
  mode: NetworkMode;
  /** Seed: recid for citation, topic/author for collaboration */
  seed: string;
  /** Max results (default: 20) */
  limit?: number;
  /** Mode-specific options */
  options?: NetworkOptions;
}

export interface NetworkOptions {
  // Citation options
  depth?: number;
  direction?: 'refs' | 'citations' | 'both';
  limit_per_layer?: number;
  max_api_calls?: number;

  // Collaboration options
  network_mode?: 'topic' | 'author';
  min_papers?: number;
  max_authors_per_paper?: number;
  fold_collaboration_author_count_threshold?: number;
  max_seed_authors_for_expansion?: number;
}

export interface NetworkAnalysisResult {
  mode: NetworkMode;
  /** Citation network result (if mode='citation') */
  citation?: CitationNetworkResult;
  /** Collaboration network result (if mode='collaboration') */
  collaboration?: CollaborationNetworkResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unified network analysis tool
 */
export async function analyzeNetwork(
  params: NetworkAnalysisParams
): Promise<NetworkAnalysisResult> {
  const { mode, seed, limit = 20, options = {} } = params;

  const result: NetworkAnalysisResult = { mode };

  switch (mode) {
    case 'citation': {
      result.citation = await buildCitationNetwork({
        recid: seed,
        depth: options.depth,
        direction: options.direction,
        limit_per_layer: options.limit_per_layer ?? limit,
        max_api_calls: options.max_api_calls,
      });
      break;
    }

    case 'collaboration': {
      result.collaboration = await buildCollaborationNetwork({
        seed,
        mode: options.network_mode,
        depth: options.depth,
        min_papers: options.min_papers,
        limit,
        max_authors_per_paper: options.max_authors_per_paper,
        fold_collaboration_author_count_threshold: options.fold_collaboration_author_count_threshold,
        max_seed_authors_for_expansion: options.max_seed_authors_for_expansion,
      });
      break;
    }

    default:
      throw new Error(`Unknown mode: ${mode}`);
  }

  return result;
}
