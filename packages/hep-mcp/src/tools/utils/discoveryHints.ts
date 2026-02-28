/**
 * NEW-CONN-01: Discovery next_actions hints.
 *
 * Deterministic rules that attach `next_actions` hints to discovery tool results,
 * guiding users toward the next logical step in the research pipeline.
 * Hint-only — never auto-executes.
 */

import {
  INSPIRE_DEEP_RESEARCH,
  HEPDATA_SEARCH,
} from '@autoresearch/shared';

interface NextAction {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

/**
 * Extract identifiers (recids) from a result that contains papers with `recid` fields.
 * Caps at `limit` identifiers. Returns strings suitable for `inspire_deep_research.identifiers`.
 */
function extractIdentifiers(papers: unknown, limit = 10): string[] {
  if (!Array.isArray(papers)) return [];
  const ids: string[] = [];
  for (const p of papers) {
    if (ids.length >= limit) break;
    if (p && typeof p === 'object') {
      const recid = (p as Record<string, unknown>).recid ?? (p as Record<string, unknown>).id;
      if (typeof recid === 'string' && recid.trim()) {
        ids.push(recid.trim());
      } else if (typeof recid === 'number') {
        ids.push(String(recid));
      }
    }
  }
  return ids;
}

/**
 * Build next_actions for discovery results that contain papers.
 * Returns empty array if no papers found.
 */
export function discoveryNextActions(papers: unknown): NextAction[] {
  const identifiers = extractIdentifiers(papers);
  if (identifiers.length === 0) return [];

  const actions: NextAction[] = [
    {
      tool: INSPIRE_DEEP_RESEARCH,
      args: { mode: 'analyze', identifiers },
      reason: 'Analyze the discovered papers in depth.',
    },
  ];

  // NEW-CONN-02: suggest HEPData search for each paper's experimental data
  const recids = extractRecids(papers);
  for (const recid of recids.slice(0, 5)) {
    actions.push({
      tool: HEPDATA_SEARCH,
      args: { inspire_recid: recid },
      reason: 'Search HEPData for experimental measurement data associated with this paper.',
    });
  }

  return actions;
}

/**
 * Extract INSPIRE recids (numeric) from papers array for HEPData lookup.
 */
function extractRecids(papers: unknown): number[] {
  if (!Array.isArray(papers)) return [];
  const recids: number[] = [];
  for (const p of papers) {
    if (recids.length >= 5) break;
    if (p && typeof p === 'object') {
      const recid = (p as Record<string, unknown>).recid ?? (p as Record<string, unknown>).id;
      if (typeof recid === 'number') {
        recids.push(recid);
      } else if (typeof recid === 'string' && /^\d+$/.test(recid)) {
        recids.push(Number(recid));
      }
    }
  }
  return recids;
}

/**
 * Build next_actions for inspire_deep_research(mode=analyze) results.
 */
export function deepResearchAnalyzeNextActions(identifiers: string[]): NextAction[] {
  if (identifiers.length === 0) return [];
  const capped = identifiers.slice(0, 10);
  return [
    {
      tool: INSPIRE_DEEP_RESEARCH,
      args: { mode: 'synthesize', identifiers: capped },
      reason: 'Synthesize findings from the analyzed papers.',
    },
    {
      tool: INSPIRE_DEEP_RESEARCH,
      args: { mode: 'write', identifiers: capped, run_id: '<run_id>' },
      reason: 'Generate a full research write-up (requires a run_id from hep_run_create).',
    },
  ];
}

/**
 * Build next_actions for zotero import results.
 */
export function zoteroImportNextActions(identifiers: string[]): NextAction[] {
  if (identifiers.length === 0) return [];
  const capped = identifiers.slice(0, 10);
  return [
    {
      tool: INSPIRE_DEEP_RESEARCH,
      args: { mode: 'analyze', identifiers: capped },
      reason: 'Analyze the imported papers in depth.',
    },
  ];
}

/**
 * Attach next_actions to a result object. Returns a new object with
 * `next_actions` merged in. If the result is not an object, wraps it.
 */
export function withNextActions<T>(result: T, nextActions: NextAction[]): T & { next_actions?: NextAction[] } {
  if (nextActions.length === 0) return result as T & { next_actions?: NextAction[] };
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, next_actions: nextActions };
  }
  return result as T & { next_actions?: NextAction[] };
}
