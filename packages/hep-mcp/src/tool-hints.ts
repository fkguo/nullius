import type { ToolBehaviourHintTable } from '@nullius/shared';
import { ARXIV_TOOL_HINTS } from '@nullius/arxiv-mcp/tooling';
import { HEPDATA_TOOL_HINTS } from '@nullius/hepdata-mcp/tooling';
import { OPENALEX_TOOL_HINTS } from '@nullius/openalex-mcp/tooling';
import { PDG_TOOL_HINTS } from '@nullius/pdg-mcp/tooling';
import { ZOTERO_TOOL_HINTS } from '@nullius/zotero-mcp/tooling';
import * as T from './tool-names.js';

const INSPIRE_READ = 'Queries the INSPIRE API; writes nothing.';
const INSPIRE_READ_WITH_SAMPLING = 'Queries the INSPIRE API and may ask the client model via sampling; writes nothing.';
const OUTPUT_DIR_WRITE =
  'writes new files into the caller\'s output_dir and refuses names that already exist, so an identical repeat is refused before any work.';

/**
 * Behaviour hints behind the MCP annotations hep-mcp lists (rules in
 * @nullius/shared tool-annotations.ts), alongside HEP_TOOL_RISK_LEVELS.
 * Re-exported sibling-provider tools keep their provider's hints.
 *
 * Downloads of arXiv sources into the arXiv source cache, made by the
 * analysis tools below, are cache bookkeeping: the cache paths are not
 * returned.
 */
export const HEP_TOOL_HINTS: ToolBehaviourHintTable = {
  [T.HEP_HEALTH]: {
    openWorld: true,
    reason: 'Reports local configuration; check_inspire=true sends one probe query to INSPIRE.',
  },
  [T.HEP_IMPORT_FROM_ZOTERO]: {
    idempotent: true,
    openWorld: true,
    reason: `Reads the Zotero local API, resolves recids on INSPIRE and ${OUTPUT_DIR_WRITE} No Zotero write.`,
  },
  [T.HEP_INSPIRE_SEARCH_EXPORT]: {
    idempotent: true,
    openWorld: true,
    reason: `Pages through INSPIRE and ${OUTPUT_DIR_WRITE}`,
  },
  [T.HEP_INSPIRE_RESOLVE_IDENTIFIERS]: {
    idempotent: true,
    openWorld: true,
    reason: `Resolves identifiers on INSPIRE and ${OUTPUT_DIR_WRITE}`,
  },
  [T.INSPIRE_SEARCH]: {
    idempotent: true,
    openWorld: true,
    reason: `Queries INSPIRE; with output_dir it ${OUTPUT_DIR_WRITE}`,
  },
  [T.INSPIRE_SEARCH_NEXT]: { openWorld: true, reason: INSPIRE_READ },
  [T.INSPIRE_TOPIC_ANALYSIS]: { openWorld: true, reason: INSPIRE_READ },
  [T.INSPIRE_NETWORK_ANALYSIS]: { openWorld: true, reason: INSPIRE_READ },
  [T.INSPIRE_FIND_CONNECTIONS]: { openWorld: true, reason: INSPIRE_READ },
  [T.INSPIRE_TRACE_ORIGINAL_SOURCE]: { openWorld: true, reason: INSPIRE_READ },
  [T.INSPIRE_LITERATURE]: { openWorld: true, reason: INSPIRE_READ },
  [T.INSPIRE_PAPER_SOURCE]: {
    idempotent: true,
    openWorld: true,
    reason: 'Resolves the paper on INSPIRE and fetches from arxiv.org; mode=content writes the paper into a fixed per-paper dir of the downloads area, a repeat returns the cached copy or rewrites the same paths.',
  },
  [T.INSPIRE_PARSE_LATEX]: {
    idempotent: true,
    openWorld: true,
    reason: `Fetches the LaTeX source from arxiv.org (via INSPIRE ids), may use sampling, and ${OUTPUT_DIR_WRITE}`,
  },
  [T.INSPIRE_RESOLVE_CITEKEY]: { openWorld: true, reason: INSPIRE_READ },
  [T.INSPIRE_GRADE_EVIDENCE]: { openWorld: true, reason: INSPIRE_READ_WITH_SAMPLING },
  [T.INSPIRE_DETECT_MEASUREMENT_CONFLICTS]: {
    openWorld: true,
    reason: 'Queries INSPIRE and arxiv.org (sources go to the arXiv source cache), reads the local PDG database, may use sampling; returns its result inline.',
  },
  [T.INSPIRE_CRITICAL_ANALYSIS]: { openWorld: true, reason: INSPIRE_READ_WITH_SAMPLING },
  [T.INSPIRE_CLASSIFY_REVIEWS]: { openWorld: true, reason: INSPIRE_READ_WITH_SAMPLING },
  [T.INSPIRE_THEORETICAL_CONFLICTS]: {
    idempotent: true,
    openWorld: true,
    reason: `Queries INSPIRE, asks the client model via sampling, and ${OUTPUT_DIR_WRITE}`,
  },
  [T.INSPIRE_FIND_CROSSOVER_TOPICS]: { openWorld: true, reason: INSPIRE_READ },
  [T.INSPIRE_ANALYZE_CITATION_STANCE]: { openWorld: true, reason: INSPIRE_READ },
  [T.INSPIRE_CLEANUP_DOWNLOADS]: {
    openWorld: false,
    reason: 'Deletes marked arxiv-* download dirs in the local downloads area; with older_than_hours a later repeat can delete dirs that have aged since.',
  },
  [T.INSPIRE_VALIDATE_BIBLIOGRAPHY]: {
    openWorld: true,
    reason: 'Queries INSPIRE and arxiv.org (sources go to the arXiv source cache); returns its result inline.',
  },
  ...ARXIV_TOOL_HINTS,
  ...PDG_TOOL_HINTS,
  ...ZOTERO_TOOL_HINTS,
  ...HEPDATA_TOOL_HINTS,
  ...OPENALEX_TOOL_HINTS,
};
