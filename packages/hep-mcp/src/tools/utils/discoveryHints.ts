/**
 * NEW-CONN-01: Discovery next_actions hints.
 *
 * Deterministic rules that attach `next_actions` hints to discovery tool results,
 * guiding users toward the next logical step in the research pipeline.
 * Hint-only — never auto-executes.
 */

import {
  HEPDATA_SEARCH,
} from '@autoresearch/shared';

interface NextAction {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

/**
 * Build next_actions for discovery results that contain papers.
 * Returns empty array if no papers found.
 */
export function discoveryNextActions(papers: unknown): NextAction[] {
  const actions: NextAction[] = [];
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
  for (const paper of papers) {
    if (recids.length >= 5 || !paper || typeof paper !== 'object') break;
    const direct = (paper as Record<string, unknown>).recid ?? (paper as Record<string, unknown>).id;
    if (typeof direct === 'number') {
      recids.push(direct);
      continue;
    }
    if (typeof direct === 'string' && /^\d+$/.test(direct)) {
      recids.push(Number(direct));
      continue;
    }
    const nested = (paper as Record<string, unknown>).identifiers;
    const nestedRecid = nested && typeof nested === 'object' ? (nested as Record<string, unknown>).recid : undefined;
    if (typeof nestedRecid === 'string' && /^\d+$/.test(nestedRecid)) recids.push(Number(nestedRecid));
  }
  return recids;
}

/**
 * Build next_actions for zotero import results.
 */
export function zoteroImportNextActions(identifiers: string[]): NextAction[] {
  if (identifiers.length === 0) return [];
  return [];
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
