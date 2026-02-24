/**
 * Research Expansion Tool
 * Expands research directions from seed papers.
 * Reference: legacy plan - Phase 2 Deep Research Tools
 */

import * as api from '../../api/client.js';
import {
  type ResearchExpansionParams,
  type ExpansionResult,
  ResearchExpansionParamsSchema,
} from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type { ResearchExpansionParams, ExpansionResult };

interface ExpandedPaper {
  recid: string;
  title: string;
  authors: string[];
  year?: number;
  citation_count?: number;
  connection_strength: number;
  connection_path: string[];
  already_in_library: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Direction Implementations
// ─────────────────────────────────────────────────────────────────────────────

async function expandForward(
  seedRecids: string[],
  depth: number,
  filters: ResearchExpansionParams['filters'],
  maxResults: number
): Promise<ExpandedPaper[]> {
  const results = new Map<string, ExpandedPaper>();
  const seedSet = new Set(seedRecids);

  let currentLayer = seedRecids;
  for (let d = 1; d <= depth; d++) {
    const nextLayer: string[] = [];
    const layerRecids = currentLayer.slice(0, maxResults);
    const fetchSize = Math.min(1000, Math.max(1, maxResults * 10));

    // Process in parallel batches
    for (let i = 0; i < layerRecids.length; i += BATCH_SIZE) {
      const batch = layerRecids.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (recid) => {
          try {
            return { recid, citations: await api.getCitations(recid, { size: fetchSize, sort: 'mostcited' }) };
          } catch {
            return { recid, citations: { papers: [], total: 0, has_more: false } };
          }
        })
      );

      for (const { recid, citations } of batchResults) {
        for (const paper of citations.papers) {
          if (!paper.recid || seedSet.has(paper.recid)) continue;
          if (results.has(paper.recid)) continue;

          // Apply filters
          if (filters?.min_citations && (paper.citation_count || 0) < filters.min_citations) continue;
          if (filters?.year_range?.start && paper.year && paper.year < filters.year_range.start) continue;
          if (filters?.year_range?.end && paper.year && paper.year > filters.year_range.end) continue;

          results.set(paper.recid, {
            recid: paper.recid,
            title: paper.title,
            authors: paper.authors || [],
            year: paper.year,
            citation_count: paper.citation_count,
            connection_strength: 1 / d,
            connection_path: [recid, paper.recid],
            already_in_library: false,
          });
          nextLayer.push(paper.recid);
        }
      }
    }
    currentLayer = nextLayer.slice(0, maxResults);
  }

  return [...results.values()];
}

async function expandBackward(
  seedRecids: string[],
  depth: number,
  filters: ResearchExpansionParams['filters'],
  maxResults: number
): Promise<ExpandedPaper[]> {
  const results = new Map<string, ExpandedPaper>();
  const seedSet = new Set(seedRecids);

  let currentLayer = seedRecids;
  for (let d = 1; d <= depth; d++) {
    const nextLayer: string[] = [];
    const layerRecids = currentLayer.slice(0, maxResults);
    const fetchSize = Math.min(1000, Math.max(1, maxResults * 10));

    // Process in parallel batches
    for (let i = 0; i < layerRecids.length; i += BATCH_SIZE) {
      const batch = layerRecids.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (recid) => {
          try {
            return { recid, refs: await api.getReferences(recid, fetchSize) };
          } catch {
            return { recid, refs: [] };
          }
        })
      );

      for (const { recid, refs } of batchResults) {
        for (const ref of refs) {
          if (!ref.recid || seedSet.has(ref.recid)) continue;
          if (results.has(ref.recid)) continue;

          // Apply filters
          if (filters?.min_citations && (ref.citation_count || 0) < filters.min_citations) continue;
          if (filters?.year_range?.start && ref.year && ref.year < filters.year_range.start) continue;
          if (filters?.year_range?.end && ref.year && ref.year > filters.year_range.end) continue;

          results.set(ref.recid, {
            recid: ref.recid,
            title: ref.title,
            authors: ref.authors || [],
            year: ref.year,
            citation_count: ref.citation_count,
            connection_strength: 1 / d,
            connection_path: [recid, ref.recid],
            already_in_library: false,
          });
          nextLayer.push(ref.recid);
        }
      }
    }
    currentLayer = nextLayer.slice(0, maxResults);
  }

  return [...results.values()];
}

/**
 * Lateral expansion: find papers that share references with seed papers (bibliographic coupling)
 * or are co-cited with seed papers
 */
async function expandLateral(
  seedRecids: string[],
  _depth: number,
  filters: ResearchExpansionParams['filters'],
  maxResults: number
): Promise<ExpandedPaper[]> {
  const results = new Map<string, ExpandedPaper & { sharedRefs: number }>();
  const seedSet = new Set(seedRecids);

  // Step 1: Get references from seed papers
  const fetchSize = Math.min(1000, Math.max(1, maxResults * 10));
  const seedRefs = new Set<string>();
  for (let i = 0; i < seedRecids.length; i += BATCH_SIZE) {
    const batch = seedRecids.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (recid) => {
        try {
          return await api.getReferences(recid, fetchSize);
        } catch {
          return []; // Skip on error
        }
      })
    );
    for (const refs of batchResults) {
      for (const ref of refs) {
        if (ref.recid) seedRefs.add(ref.recid);
      }
    }
  }

  // Step 2: Find papers that cite the same references (bibliographic coupling)
  const refRecids = [...seedRefs].slice(0, Math.min(seedRefs.size, fetchSize));
  for (let i = 0; i < refRecids.length; i += BATCH_SIZE) {
    const batch = refRecids.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (refRecid) => {
        try {
          return { refRecid, citations: await api.getCitations(refRecid, { size: fetchSize, sort: 'mostcited' }) };
        } catch {
          return { refRecid, citations: { papers: [] } }; // Skip on error
        }
      })
    );

    for (const { refRecid, citations } of batchResults) {
      for (const paper of citations.papers) {
        if (!paper.recid || seedSet.has(paper.recid)) continue;

        // Apply filters
        if (filters?.min_citations && (paper.citation_count || 0) < filters.min_citations) continue;
        if (filters?.year_range?.start && paper.year && paper.year < filters.year_range.start) continue;
        if (filters?.year_range?.end && paper.year && paper.year > filters.year_range.end) continue;

        const existing = results.get(paper.recid);
        if (existing) {
          existing.sharedRefs++;
          existing.connection_strength = existing.sharedRefs / seedRefs.size;
        } else {
          results.set(paper.recid, {
            recid: paper.recid,
            title: paper.title,
            authors: paper.authors || [],
            year: paper.year,
            citation_count: paper.citation_count,
            connection_strength: 1 / seedRefs.size,
            connection_path: ['shared_ref', refRecid, paper.recid],
            already_in_library: false,
            sharedRefs: 1,
          });
        }
      }
    }
  }

  // Return papers sorted by shared references count
  return [...results.values()]
    .filter(p => p.sharedRefs >= 2) // At least 2 shared references
    .sort((a, b) => b.sharedRefs - a.sharedRefs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function researchExpansion(
  params: ResearchExpansionParams
): Promise<ExpansionResult> {
  const validated = ResearchExpansionParamsSchema.parse(params);
  const { seed_recids, direction, depth, max_results, filters } = validated;

  let papers: ExpandedPaper[] = [];

  switch (direction) {
    case 'forward':
      papers = await expandForward(seed_recids, depth, filters, max_results);
      break;
    case 'backward':
      papers = await expandBackward(seed_recids, depth, filters, max_results);
      break;
    case 'lateral':
      // Lateral: find papers that share references (bibliographic coupling)
      papers = await expandLateral(seed_recids, depth, filters, max_results);
      break;
    case 'all':
      const [fwd, bwd] = await Promise.all([
        expandForward(seed_recids, depth, filters, max_results),
        expandBackward(seed_recids, depth, filters, max_results),
      ]);
      papers = [...fwd, ...bwd];
      break;
  }

  // Sort by connection strength and limit
  papers.sort((a, b) => b.connection_strength - a.connection_strength);
  papers = papers.slice(0, max_results);

  // Find emerging topics (recent high-growth papers)
  const currentYear = new Date().getFullYear();
  const emerging = papers
    .filter(p => p.year && p.year >= currentYear - 2)
    .sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0))
    .slice(0, 5);

  const emergingRecids = emerging.map(p => p.recid);
  const emergingPapers = emergingRecids.length > 0
    ? await api.batchGetPapers(emergingRecids)
    : [];

  return {
    direction,
    papers,
    emerging_topics: emergingPapers,
  };
}
