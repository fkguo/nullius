/**
 * Citation Network Analysis
 * Reference: legacy plan - inspire_citation_network
 */

import * as api from '../../api/client.js';
import type { PaperSummary } from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CitationNetworkParams {
  recid: string;
  depth?: number;              // 1-3, default 2
  direction?: 'refs' | 'citations' | 'both';
  limit_per_layer?: number;    // default 20
  max_api_calls?: number;      // default 10
}

export interface NetworkNode {
  recid: string;
  title: string;
  year?: number;
  citation_count?: number;
  depth: number;
  pagerank?: number;
}

export interface NetworkEdge {
  source: string;  // recid
  target: string;  // recid
  type: 'cites' | 'cited_by';
}

export interface CitationNetworkResult {
  center: PaperSummary;
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  key_papers: PaperSummary[];
  api_calls_used: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 5;

// ─────────────────────────────────────────────────────────────────────────────
// PageRank Algorithm
// ─────────────────────────────────────────────────────────────────────────────

function computePageRank(
  nodes: Map<string, NetworkNode>,
  edges: NetworkEdge[],
  iterations = 20,
  damping = 0.85
): Map<string, number> {
  const n = nodes.size;
  if (n === 0) return new Map();

  const ranks = new Map<string, number>();
  const outDegree = new Map<string, number>();
  // Pre-build adjacency list for incoming edges: target -> [source1, source2, ...]
  const inEdges = new Map<string, string[]>();

  // Initialize ranks and build adjacency structures
  for (const id of nodes.keys()) {
    ranks.set(id, 1 / n);
    outDegree.set(id, 0);
    inEdges.set(id, []);
  }
  for (const edge of edges) {
    outDegree.set(edge.source, (outDegree.get(edge.source) || 0) + 1);
    // Build incoming edge list
    const incoming = inEdges.get(edge.target);
    if (incoming) {
      incoming.push(edge.source);
    } else {
      inEdges.set(edge.target, [edge.source]);
    }
  }

  // Iterate using adjacency list (O(iterations * edges) instead of O(iterations * edges * nodes))
  for (let i = 0; i < iterations; i++) {
    const newRanks = new Map<string, number>();
    for (const id of nodes.keys()) {
      let sum = 0;
      // Use pre-built adjacency list for O(1) lookup per incoming edge
      const sources = inEdges.get(id) || [];
      for (const src of sources) {
        const srcRank = ranks.get(src) || 0;
        const srcOut = outDegree.get(src) || 1;
        sum += srcRank / srcOut;
      }
      newRanks.set(id, (1 - damping) / n + damping * sum);
    }
    ranks.clear();
    for (const [k, v] of newRanks) ranks.set(k, v);
  }

  return ranks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function buildCitationNetwork(
  params: CitationNetworkParams
): Promise<CitationNetworkResult> {
  const {
    recid,
    depth = 2,
    direction = 'both',
    limit_per_layer = 20,
    max_api_calls = 10,
  } = params;

  const effectiveDepth = Number.isFinite(depth) ? Math.max(0, Math.trunc(depth)) : 0;

  let apiCallsUsed = 0;
  const nodes = new Map<string, NetworkNode>();
  const edges: NetworkEdge[] = [];

  // Get center paper
  const centerPaper = await api.getPaper(recid);
  apiCallsUsed++;

  nodes.set(recid, {
    recid,
    title: centerPaper.title,
    year: centerPaper.year,
    citation_count: centerPaper.citation_count,
    depth: 0,
  });

  // BFS to explore network (parallel batches)
  let currentLayer = [recid];

  for (let d = 1; d <= effectiveDepth; d++) {
    if (apiCallsUsed >= max_api_calls) break;

    const nextLayer: string[] = [];

    // Process nodes in parallel batches
    for (let i = 0; i < currentLayer.length; i += BATCH_SIZE) {
      if (apiCallsUsed >= max_api_calls) break;

      const batch = currentLayer.slice(i, i + BATCH_SIZE);
      const remainingCalls = max_api_calls - apiCallsUsed;
      const callsPerNode = direction === 'both' ? 2 : 1;
      const maxNodesThisBatch = Math.min(batch.length, Math.floor(remainingCalls / callsPerNode));
      const nodesToProcess = batch.slice(0, maxNodesThisBatch);

      if (nodesToProcess.length === 0) break;

      // Parallel fetch for this batch
      const batchResults = await Promise.all(
        nodesToProcess.map(async (nodeRecid) => {
          const result: { nodeRecid: string; refs: PaperSummary[]; citations: PaperSummary[] } = {
            nodeRecid,
            refs: [],
            citations: [],
          };

          try {
            if (direction === 'refs' || direction === 'both') {
              result.refs = await api.getReferences(nodeRecid, limit_per_layer);
            }
            if (direction === 'citations' || direction === 'both') {
              const citResult = await api.getCitations(nodeRecid, { size: limit_per_layer });
              result.citations = citResult.papers;
            }
          } catch {
            // Skip on error
          }

          return result;
        })
      );

      // Update API call count
      apiCallsUsed += nodesToProcess.length * callsPerNode;

      // Process batch results
      for (const { nodeRecid, refs, citations } of batchResults) {
        // Process references
        for (const ref of refs) {
          if (!ref.recid) continue;
          edges.push({ source: nodeRecid, target: ref.recid, type: 'cites' });
          if (!nodes.has(ref.recid)) {
            nodes.set(ref.recid, {
              recid: ref.recid,
              title: ref.title || 'Unknown',
              year: ref.year,
              citation_count: ref.citation_count,
              depth: d,
            });
            nextLayer.push(ref.recid);
          }
        }

        // Process citations
        for (const citing of citations) {
          if (!citing.recid) continue;
          edges.push({ source: citing.recid, target: nodeRecid, type: 'cited_by' });
          if (!nodes.has(citing.recid)) {
            nodes.set(citing.recid, {
              recid: citing.recid,
              title: citing.title || 'Unknown',
              year: citing.year,
              citation_count: citing.citation_count,
              depth: d,
            });
            nextLayer.push(citing.recid);
          }
        }
      }
    }

    currentLayer = nextLayer.slice(0, limit_per_layer);
  }

  // Compute PageRank
  const pageRanks = computePageRank(nodes, edges);
  for (const [id, rank] of pageRanks) {
    const node = nodes.get(id);
    if (node) node.pagerank = rank;
  }

  // Get top papers by PageRank
  const sortedNodes = [...nodes.values()]
    .filter(n => n.recid !== recid)
    .sort((a, b) => (b.pagerank || 0) - (a.pagerank || 0))
    .slice(0, 10);

  const keyPaperRecids = sortedNodes.map(n => n.recid);
  const keyPapers = await api.batchGetPapers(keyPaperRecids);
  if (keyPaperRecids.length > 0) apiCallsUsed++;

  return {
    center: centerPaper,
    nodes: [...nodes.values()],
    edges,
    key_papers: keyPapers,
    api_calls_used: apiCallsUsed,
  };
}
