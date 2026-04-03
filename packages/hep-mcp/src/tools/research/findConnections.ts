/**
 * Find Connections Tool
 * Discovers citation relationships between a set of papers.
 * Reference: legacy plan - Phase 2 Deep Research Tools
 */

import * as api from '../../api/client.js';
import {
  type FindConnectionsParams,
  type ConnectionsResult,
  type PaperSummary,
  FindConnectionsParamsSchema,
} from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type { FindConnectionsParams, ConnectionsResult };

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function findConnections(
  params: FindConnectionsParams
): Promise<ConnectionsResult> {
  // Validate params
  const validated = FindConnectionsParamsSchema.parse(params);
  const { recids, include_external, max_external_depth } = validated;

  const recidSet = new Set(recids);
  const internalEdges: { source: string; target: string }[] = [];
  const connectionCount = new Map<string, number>();
  const paperTitles = new Map<string, string>();

  // Fetch references for each paper in parallel batches
  for (let i = 0; i < recids.length; i += BATCH_SIZE) {
    const batch: string[] = recids.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (recid: string) => {
        try {
          return { recid, refs: await api.getReferences(recid) };
        } catch {
          return { recid, refs: [] }; // Skip papers that fail to fetch
        }
      })
    );

    for (const { recid, refs } of batchResults) {
      for (const ref of refs) {
        if (!ref.recid) continue;

        // Track paper titles
        if (!paperTitles.has(ref.recid)) {
          paperTitles.set(ref.recid, ref.title);
        }

        // Check if this reference is within our collection
        if (recidSet.has(ref.recid)) {
          internalEdges.push({ source: recid, target: ref.recid });
          connectionCount.set(recid, (connectionCount.get(recid) || 0) + 1);
          connectionCount.set(ref.recid, (connectionCount.get(ref.recid) || 0) + 1);
        }
      }
    }
  }

  // Find bridge papers (papers with most connections)
  const bridgePapers = [...connectionCount.entries()]
    .filter(([recid]) => recidSet.has(recid))
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([recid, connections]) => ({
      recid,
      title: paperTitles.get(recid) || 'Unknown',
      connections,
    }));

  // Find isolated papers (no internal connections)
  const connectedRecids = new Set<string>();
  for (const edge of internalEdges) {
    connectedRecids.add(edge.source);
    connectedRecids.add(edge.target);
  }
  const isolatedPapers = recids.filter((r: string) => !connectedRecids.has(r));

  const result: ConnectionsResult = {
    internal_edges: internalEdges,
    bridge_papers: bridgePapers,
    isolated_papers: isolatedPapers,
  };

  // Find external hubs if requested
  if (include_external) {
    result.external_hubs = await findExternalHubs(recids, max_external_depth);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Find External Hubs
// ─────────────────────────────────────────────────────────────────────────────

async function findExternalHubs(
  recids: string[],
  maxDepth: number = 1
): Promise<PaperSummary[]> {
  const recidSet = new Set(recids);
  const targetRecids = [...new Set(recids)];
  const externalReach = new Map<string, { count: number; minDepth: number }>();

  // Count how many papers in the original collection can reach each external paper
  // within `maxDepth` reference hops.
  for (const seedRecid of targetRecids) {
    const reachedByThisSeed = new Set<string>();
    let frontier: string[] = [seedRecid];
    const visited = new Set<string>([seedRecid]);

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];

      for (let i = 0; i < frontier.length; i += BATCH_SIZE) {
        const batch = frontier.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (recid) => {
            try {
              return await api.getReferences(recid);
            } catch {
              return []; // Skip on error
            }
          })
        );

        for (const refs of batchResults) {
          for (const ref of refs) {
            if (!ref.recid || recidSet.has(ref.recid)) continue;

            if (!reachedByThisSeed.has(ref.recid)) {
              reachedByThisSeed.add(ref.recid);
              const stats = externalReach.get(ref.recid);
              if (stats) {
                stats.count++;
                stats.minDepth = Math.min(stats.minDepth, depth);
              } else {
                externalReach.set(ref.recid, { count: 1, minDepth: depth });
              }
            }

            if (!visited.has(ref.recid)) {
              visited.add(ref.recid);
              nextFrontier.push(ref.recid);
            }
          }
        }
      }

      frontier = nextFrontier;
    }
  }

  // Get top external papers cited by multiple papers in collection
  const topExternal = [...externalReach.entries()]
    .filter(([, stats]) => stats.count >= 2)
    .sort(([, a], [, b]) => (b.count - a.count) || (a.minDepth - b.minDepth))
    .slice(0, 10)
    .map(([recid]) => recid);

  if (topExternal.length === 0) return [];

  const papers = await api.batchGetPapers(topExternal);
  const byRecid = new Map(papers.map(p => [p.recid, p] as const));
  return topExternal.map(r => byRecid.get(r)).filter((p): p is PaperSummary => !!p);
}
