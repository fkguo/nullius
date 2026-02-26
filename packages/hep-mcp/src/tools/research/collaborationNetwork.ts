/**
 * Collaboration Network Analysis
 * Analyzes co-authorship patterns to identify collaboration networks
 */

import * as api from '../../api/client.js';
import type { PaperSummary } from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CollaborationNetworkParams {
  /** Seed for network: topic keywords or author identifier */
  seed: string;
  /** Mode: 'topic' searches papers, 'author' starts from author's papers */
  mode?: 'topic' | 'author';
  /** Exploration depth (1-2, default: 1) */
  depth?: number;
  /** Minimum co-authored papers to count as collaboration (default: 2) */
  min_papers?: number;
  /** Maximum collaborators to return (default: 20) */
  limit?: number;
  /** Max authors per paper used to form edges (default: 10) */
  max_authors_per_paper?: number;
  /**
   * If `author_count` exceeds this threshold, fold the paper into collaboration node(s) instead of author nodes (default: 30)
   */
  fold_collaboration_author_count_threshold?: number;
  /** When `depth>1`, max seed authors per paper for expansion (default: 5) */
  max_seed_authors_for_expansion?: number;
}

export interface CollaboratorNode {
  /** Author name */
  name: string;
  /** Number of papers in the network */
  paper_count: number;
  /** Total citations from papers in network */
  total_citations: number;
  /** Number of unique collaborators */
  collaborator_count: number;
  /** Centrality score (0-1) */
  centrality: number;
}

export interface CollaborationEdge {
  /** First author */
  author1: string;
  /** Second author */
  author2: string;
  /** Number of co-authored papers */
  paper_count: number;
  /** Total citations from co-authored papers */
  total_citations: number;
  /** Collaboration strength score (0-1) */
  strength: number;
}

export interface CollaborationCluster {
  /** Cluster ID */
  id: number;
  /** Core members of the cluster */
  members: string[];
  /** Total papers in cluster */
  paper_count: number;
  /** Representative topic/keywords */
  keywords?: string[];
}

export interface CollaborationNetworkResult {
  /** Seed used for analysis */
  seed: string;
  /** Analysis mode */
  mode: 'topic' | 'author';
  /** Warnings about approximations/truncation */
  warnings?: string[];
  /** Network statistics */
  statistics: {
    total_authors: number;
    total_papers: number;
    total_papers_fetched?: number;
    total_collaborations: number;
    avg_collaborators_per_author: number;
    network_density: number;
    max_authors_per_paper: number;
    fold_collaboration_author_count_threshold: number;
    folded_collaboration_papers: number;
    skipped_large_collaboration_papers: number;
    truncated_author_papers: number;
  };
  /** Top collaborators by centrality */
  top_collaborators: CollaboratorNode[];
  /** Strongest collaboration edges */
  top_collaborations: CollaborationEdge[];
  /** Identified clusters */
  clusters: CollaborationCluster[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize author name for matching
 */
function normalizeAuthorName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Extract co-authorship pairs from a paper
 */
function extractCoAuthorPairs(
  participants: string[],
  citations: number
): { pair: [string, string]; citations: number }[] {
  const pairs: { pair: [string, string]; citations: number }[] = [];

  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      const a1 = participants[i];
      const a2 = participants[j];
      const pair: [string, string] = a1 < a2 ? [a1, a2] : [a2, a1];
      pairs.push({ pair, citations });
    }
  }
  return pairs;
}

/**
 * Build collaboration graph from papers
 */
function buildCollaborationGraph(contributions: Array<{ participants: string[]; citations: number }>): {
  authorStats: Map<string, { papers: number; citations: number; collaborators: Set<string> }>;
  edgeStats: Map<string, { papers: number; citations: number }>;
} {
  const authorStats = new Map<string, {
    papers: number;
    citations: number;
    collaborators: Set<string>;
  }>();
  const edgeStats = new Map<string, { papers: number; citations: number }>();

  for (const { participants, citations } of contributions) {
    if (participants.length === 0) continue;

    // Update author stats
    for (const author of participants) {
      if (!authorStats.has(author)) {
        authorStats.set(author, { papers: 0, citations: 0, collaborators: new Set() });
      }
      const stats = authorStats.get(author)!;
      stats.papers++;
      stats.citations += citations;

      // Add collaborators
      for (const other of participants) {
        if (other !== author) {
          stats.collaborators.add(other);
        }
      }
    }

    // Extract and count co-author pairs
    const pairs = extractCoAuthorPairs(participants, citations);
    for (const { pair, citations: cit } of pairs) {
      const key = `${pair[0]}|||${pair[1]}`;
      if (!edgeStats.has(key)) {
        edgeStats.set(key, { papers: 0, citations: 0 });
      }
      const edge = edgeStats.get(key)!;
      edge.papers++;
      edge.citations += cit;
    }
  }

  return { authorStats, edgeStats };
}

/**
 * Calculate centrality scores using degree centrality
 */
function calculateCentrality(
  authorStats: Map<string, { papers: number; citations: number; collaborators: Set<string> }>
): Map<string, number> {
  const centrality = new Map<string, number>();
  const maxCollaborators = Math.max(
    ...Array.from(authorStats.values()).map(s => s.collaborators.size),
    1
  );

  for (const [author, stats] of authorStats) {
    // Degree centrality normalized by max
    centrality.set(author, stats.collaborators.size / maxCollaborators);
  }

  return centrality;
}

/**
 * Simple cluster detection using connected components with high collaboration
 */
function detectClusters(
  edgeStats: Map<string, { papers: number; citations: number }>,
  minPapers: number
): CollaborationCluster[] {
  // Build adjacency list for strong collaborations
  const adjacency = new Map<string, Set<string>>();

  for (const [key, stats] of edgeStats) {
    if (stats.papers >= minPapers) {
      const [a1, a2] = key.split('|||');
      if (!adjacency.has(a1)) adjacency.set(a1, new Set());
      if (!adjacency.has(a2)) adjacency.set(a2, new Set());
      adjacency.get(a1)!.add(a2);
      adjacency.get(a2)!.add(a1);
    }
  }

  // Find connected components using BFS
  const visited = new Set<string>();
  const clusters: CollaborationCluster[] = [];
  let clusterId = 0;

  for (const author of adjacency.keys()) {
    if (visited.has(author)) continue;

    const component: string[] = [];
    const queue = [author];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;

      visited.add(current);
      component.push(current);

      const neighbors = adjacency.get(current) || new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          queue.push(neighbor);
        }
      }
    }

    if (component.length >= 2) {
      // Count papers in cluster
      let paperCount = 0;
      for (const [key, stats] of edgeStats) {
        const [a1, a2] = key.split('|||');
        if (component.includes(a1) && component.includes(a2)) {
          paperCount += stats.papers;
        }
      }

      clusters.push({
        id: clusterId++,
        members: component.slice(0, 10), // Limit members shown
        paper_count: paperCount,
      });
    }
  }

  // Sort by size
  return clusters.sort((a, b) => b.members.length - a.members.length).slice(0, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function buildCollaborationNetwork(
  params: CollaborationNetworkParams
): Promise<CollaborationNetworkResult> {
  const {
    seed,
    mode = 'topic',
    depth = 1,
    min_papers = 2,
    limit = 20,
    max_authors_per_paper = 10,
    fold_collaboration_author_count_threshold = 30,
    max_seed_authors_for_expansion = 5,
  } = params;

  const warnings: string[] = [];
  const MAX_WARNINGS = 50;
  const pushWarning = (msg: string) => {
    if (warnings.length >= MAX_WARNINGS) return;
    warnings.push(msg);
  };

  // Step 1: Get initial papers
  let papers: PaperSummary[] = [];

  if (mode === 'author') {
    // Search for author's papers
    const result = await api.searchAll(`a:${seed}`, { sort: 'mostcited' });
    if (result.warning) pushWarning(`[collaborationNetwork] ${result.warning}`);
    papers = result.papers;
  } else {
    // Topic search
    const result = await api.searchAll(seed, { sort: 'mostcited' });
    if (result.warning) pushWarning(`[collaborationNetwork] ${result.warning}`);
    papers = result.papers;
  }

  // Step 2: If depth > 1, expand by finding papers from top collaborators
  if (depth > 1 && papers.length > 0) {
    // Find top authors from initial papers
    const authorCounts = new Map<string, number>();
    for (const paper of papers) {
      const effectiveAuthorCount = paper.author_count ?? paper.authors.length;
      if (effectiveAuthorCount > fold_collaboration_author_count_threshold) continue;
      for (const author of paper.authors.slice(0, max_seed_authors_for_expansion)) {
        const normalized = normalizeAuthorName(author);
        authorCounts.set(normalized, (authorCounts.get(normalized) || 0) + 1);
      }
    }

    // Get top 5 authors
    const topAuthors = [...authorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, max_seed_authors_for_expansion)
      .map(([name]) => name);

    // Fetch additional papers from top authors in parallel
    const existingRecids = new Set(papers.map(p => p.recid));
    const authorResults = await Promise.all(
      topAuthors.map(async (author) => {
        try {
          return await api.searchAll(`a:${author}`, { sort: 'mostcited' });
        } catch (error) {
          // Log at debug level for troubleshooting
          console.debug(`[hep-mcp] collaborationNetwork author search (author="${author}"): Skipped - ${error instanceof Error ? error.message : String(error)}`);
          return { papers: [] }; // Ignore errors for individual author searches
        }
      })
    );

    for (const result of authorResults) {
      for (const paper of result.papers) {
        if (!existingRecids.has(paper.recid)) {
          papers.push(paper);
          existingRecids.add(paper.recid);
        }
      }
    }
  }

  // Step 3: Prepare paper contributions (fold large collaborations into collaboration nodes)
  let foldedCollaborationPapers = 0;
  let skippedLargeCollaborationPapers = 0;
  let truncatedAuthorPapers = 0;
  const usedCollaborationNodes = new Set<string>();

  const contributions: Array<{ participants: string[]; citations: number }> = [];
  for (const paper of papers) {
    const citations = paper.citation_count || 0;
    const effectiveAuthorCount = paper.author_count ?? paper.authors.length;

    if (effectiveAuthorCount > fold_collaboration_author_count_threshold) {
      foldedCollaborationPapers++;
      const collabs = (paper.collaborations || []).map(normalizeAuthorName).filter(v => v.length > 0);
      const uniqueCollabs = [...new Set(collabs)];
      if (uniqueCollabs.length === 0) {
        skippedLargeCollaborationPapers++;
        continue;
      }
      for (const c of uniqueCollabs) usedCollaborationNodes.add(c);
      contributions.push({ participants: uniqueCollabs, citations });
      continue;
    }

    const limitedAuthors = (paper.authors || [])
      .slice(0, max_authors_per_paper)
      .map(normalizeAuthorName)
      .filter(v => v.length > 0);
    const uniqueAuthors = [...new Set(limitedAuthors)];
    if (uniqueAuthors.length === 0) continue;

    if (effectiveAuthorCount > uniqueAuthors.length) truncatedAuthorPapers++;
    contributions.push({ participants: uniqueAuthors, citations });
  }

  if (foldedCollaborationPapers > 0) {
    const examples = [...usedCollaborationNodes].slice(0, 5);
    pushWarning(
      `[collaborationNetwork] Folded ${foldedCollaborationPapers} paper(s) with author_count>${fold_collaboration_author_count_threshold} into collaboration node(s)${examples.length ? ` (e.g., ${examples.join(', ')})` : ''}.`
    );
  }
  if (skippedLargeCollaborationPapers > 0) {
    pushWarning(
      `[collaborationNetwork] Skipped ${skippedLargeCollaborationPapers} large-collaboration paper(s): author_count>${fold_collaboration_author_count_threshold} but no collaborations field present in summary.`
    );
  }
  if (truncatedAuthorPapers > 0) {
    pushWarning(
      `[collaborationNetwork] ${truncatedAuthorPapers} paper(s) have author_count>authors_used; co-author edges use only the first max_authors_per_paper=${max_authors_per_paper} authors from each record.`
    );
  }

  // Step 3: Build collaboration graph
  const { authorStats, edgeStats } = buildCollaborationGraph(contributions);

  // Step 4: Calculate centrality
  const centrality = calculateCentrality(authorStats);

  // Step 5: Build result nodes
  const nodes: CollaboratorNode[] = [...authorStats.entries()]
    .map(([name, stats]) => ({
      name,
      paper_count: stats.papers,
      total_citations: stats.citations,
      collaborator_count: stats.collaborators.size,
      centrality: centrality.get(name) || 0,
    }))
    .sort((a, b) => b.centrality - a.centrality)
    .slice(0, limit);

  // Step 6: Build result edges (filter by min_papers)
  const maxEdgeCitations = Math.max(
    ...Array.from(edgeStats.values()).map(e => e.citations),
    1
  );

  const edges: CollaborationEdge[] = [...edgeStats.entries()]
    .filter(([, stats]) => stats.papers >= min_papers)
    .map(([key, stats]) => {
      const [author1, author2] = key.split('|||');
      return {
        author1,
        author2,
        paper_count: stats.papers,
        total_citations: stats.citations,
        strength: stats.citations / maxEdgeCitations,
      };
    })
    .sort((a, b) => b.paper_count - a.paper_count)
    .slice(0, limit);

  // Step 7: Detect clusters
  const clusters = detectClusters(edgeStats, min_papers);

  // Step 8: Calculate network statistics
  const totalAuthors = authorStats.size;
  const totalCollaborations = edgeStats.size;
  const avgCollaborators = totalAuthors > 0
    ? [...authorStats.values()].reduce((sum, s) => sum + s.collaborators.size, 0) / totalAuthors
    : 0;

  // Network density = actual edges / possible edges
  const possibleEdges = (totalAuthors * (totalAuthors - 1)) / 2;
  const networkDensity = possibleEdges > 0 ? totalCollaborations / possibleEdges : 0;

  return {
    seed,
    mode,
    warnings: warnings.length > 0 ? warnings : undefined,
    statistics: {
      total_authors: totalAuthors,
      total_papers: contributions.length,
      total_papers_fetched: papers.length,
      total_collaborations: totalCollaborations,
      avg_collaborators_per_author: Math.round(avgCollaborators * 10) / 10,
      network_density: Math.round(networkDensity * 1000) / 1000,
      max_authors_per_paper,
      fold_collaboration_author_count_threshold,
      folded_collaboration_papers: foldedCollaborationPapers,
      skipped_large_collaboration_papers: skippedLargeCollaborationPapers,
      truncated_author_papers: truncatedAuthorPapers,
    },
    top_collaborators: nodes,
    top_collaborations: edges,
    clusters,
  };
}
