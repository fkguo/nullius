/**
 * Bounded citation tracing for source discovery.
 * Citation metadata identifies papers to read; it cannot establish priority for
 * a scientific claim, which is not an input to this tool.
 */

import * as api from '../../api/client.js';
import type { PaperSummary } from '@nullius/shared';

export interface TraceOriginalSourceParams {
  recid: string;
  max_depth?: number;
  max_refs_per_level?: number;
  /** Filter candidates to records cited by >=2 distinct traced papers, not scientific verification. */
  cross_validate?: boolean;
}

export type ReferenceLookup =
  | { status: 'not_requested'; reason: 'depth_limit' }
  | { status: 'unavailable'; error: string }
  | {
      status: 'returned';
      returned_count: number;
      unresolved_count: number;
      selected_count: number;
      truncated_by_limit: boolean;
    };

export interface TracedSource extends PaperSummary {
  /** Minimum observed citation depth, with the starting paper at zero. */
  depth: number;
  /** Distinct citing records observed in this bounded traversal. */
  citing_recids: string[];
  incoming_reference_count: number;
  reference_lookup: ReferenceLookup;
}

export interface TraceOriginalSourceResult {
  starting_paper: PaperSummary;
  /** Citation-trace candidates for source reading, excluding the starting paper. */
  source_candidates: TracedSource[];
  trace_chain: TracedSource[];
  analysis_scope: {
    source_basis: 'citation_metadata';
    scientific_priority: 'not_assessed';
    candidate_filter: 'multiple_citing_records' | 'all_traced_references';
    ordering: 'incoming_reference_count_then_known_year_then_record_id';
  };
  stats: {
    total_traced: number;
    max_depth_reached: number;
    references_queried: number;
    reference_queries_failed: number;
  };
}

type VisitedSource = {
  paper: PaperSummary;
  depth: number;
  citingRecids: Set<string>;
  lookup: ReferenceLookup;
};

function knownYear(paper: PaperSummary): number {
  return typeof paper.year === 'number' && Number.isFinite(paper.year)
    ? paper.year
    : Number.POSITIVE_INFINITY;
}

/** Keep unknown-year references; their missing metadata is not absence of a source. */
function selectReferences(references: PaperSummary[], limit: number): PaperSummary[] {
  const byRecid = new Map<string, PaperSummary>();
  for (const reference of references) {
    if (reference.recid && !byRecid.has(reference.recid)) byRecid.set(reference.recid, reference);
  }
  return [...byRecid.values()]
    .sort((left, right) => {
      const leftYear = knownYear(left);
      const rightYear = knownYear(right);
      return (leftYear === rightYear ? 0 : leftYear < rightYear ? -1 : 1)
        || left.recid!.localeCompare(right.recid!, 'en', { numeric: true });
    })
    .slice(0, limit);
}

export async function traceOriginalSource(params: TraceOriginalSourceParams): Promise<TraceOriginalSourceResult> {
  const { recid, max_depth = 3, max_refs_per_level = 3, cross_validate = true } = params;
  const startingPaper = await api.getPaper(recid);
  const startingRecid = startingPaper.recid || recid;
  const visited = new Map<string, VisitedSource>([[startingRecid, {
    paper: startingPaper,
    depth: 0,
    citingRecids: new Set(),
    lookup: { status: 'not_requested', reason: 'depth_limit' },
  }]]);
  let currentLevel = [startingRecid];
  let queries = 0;
  let failures = 0;

  for (let depth = 0; depth < max_depth - 1 && currentLevel.length > 0; depth++) {
    const nextLevel = new Set<string>();
    for (const currentRecid of currentLevel) {
      const current = visited.get(currentRecid)!;
      queries++;
      let references: PaperSummary[];
      try {
        references = await api.getReferences(currentRecid);
      } catch (error) {
        failures++;
        current.lookup = {
          status: 'unavailable',
          error: error instanceof Error ? error.message : String(error),
        };
        continue;
      }
      const selected = selectReferences(references, max_refs_per_level);
      const resolvableCount = new Set(references.filter(ref => ref.recid).map(ref => ref.recid)).size;
      current.lookup = {
        status: 'returned',
        returned_count: references.length,
        unresolved_count: references.filter(ref => !ref.recid).length,
        selected_count: selected.length,
        truncated_by_limit: selected.length < resolvableCount,
      };
      for (const reference of selected) {
        const referenceRecid = reference.recid!;
        const existing = visited.get(referenceRecid);
        if (existing) {
          existing.citingRecids.add(currentRecid);
        } else {
          visited.set(referenceRecid, {
            paper: reference,
            depth: depth + 1,
            citingRecids: new Set([currentRecid]),
            lookup: { status: 'not_requested', reason: 'depth_limit' },
          });
          nextLevel.add(referenceRecid);
        }
      }
    }
    currentLevel = [...nextLevel];
  }

  const traceChain: TracedSource[] = [...visited.values()].map(item => ({
    ...item.paper,
    depth: item.depth,
    citing_recids: [...item.citingRecids].sort(),
    incoming_reference_count: item.citingRecids.size,
    reference_lookup: item.lookup,
  }));
  const sourceCandidates = traceChain
    .filter(item => item.recid !== startingRecid && item.depth > 0
      && (!cross_validate || item.incoming_reference_count >= 2))
    .sort((left, right) => {
      const leftYear = knownYear(left);
      const rightYear = knownYear(right);
      return right.incoming_reference_count - left.incoming_reference_count
        || (leftYear === rightYear ? 0 : leftYear < rightYear ? -1 : 1)
        || left.recid!.localeCompare(right.recid!, 'en', { numeric: true });
    });

  return {
    starting_paper: startingPaper,
    source_candidates: sourceCandidates,
    trace_chain: traceChain,
    analysis_scope: {
      source_basis: 'citation_metadata',
      scientific_priority: 'not_assessed',
      candidate_filter: cross_validate ? 'multiple_citing_records' : 'all_traced_references',
      ordering: 'incoming_reference_count_then_known_year_then_record_id',
    },
    stats: {
      total_traced: visited.size,
      max_depth_reached: traceChain.reduce((maximum, item) => Math.max(maximum, item.depth), 0),
      references_queried: queries,
      reference_queries_failed: failures,
    },
  };
}
