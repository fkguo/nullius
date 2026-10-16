import {
  getToolRiskLevel,
  type ToolRiskLevel,
  type ToolRiskTable,
} from '@nullius/shared';
import { ARXIV_TOOL_RISK_LEVELS } from '@nullius/arxiv-mcp/tooling';
import { HEPDATA_TOOL_RISK_LEVELS } from '@nullius/hepdata-mcp/tooling';
import { OPENALEX_TOOL_RISK_LEVELS } from '@nullius/openalex-mcp/tooling';
import { PDG_TOOL_RISK_LEVELS } from '@nullius/pdg-mcp/tooling';
import { ZOTERO_TOOL_RISK_LEVELS } from '@nullius/zotero-mcp/tooling';
import * as T from './tool-names.js';

export type { ToolRiskLevel } from '@nullius/shared';

/**
 * hep-mcp owns the concrete risk authority for its own tools; the
 * consolidated sibling-provider tools surfaced through hep-mcp keep the
 * levels their provider records.
 */
export const HEP_TOOL_RISK_LEVELS: ToolRiskTable = {
  [T.HEP_HEALTH]: 'read',
  [T.HEP_IMPORT_FROM_ZOTERO]: 'write',
  [T.HEP_INSPIRE_SEARCH_EXPORT]: 'write',
  // Writes its mapping and API records into the caller's output_dir.
  [T.HEP_INSPIRE_RESOLVE_IDENTIFIERS]: 'write',
  // With output_dir it writes the search export into output_dir.
  [T.INSPIRE_SEARCH]: 'write',
  [T.INSPIRE_SEARCH_NEXT]: 'read',
  [T.INSPIRE_TOPIC_ANALYSIS]: 'read',
  [T.INSPIRE_NETWORK_ANALYSIS]: 'read',
  [T.INSPIRE_FIND_CONNECTIONS]: 'read',
  [T.INSPIRE_TRACE_ORIGINAL_SOURCE]: 'read',
  [T.INSPIRE_LITERATURE]: 'read',
  [T.INSPIRE_PAPER_SOURCE]: 'write',
  [T.INSPIRE_PARSE_LATEX]: 'write',
  [T.INSPIRE_RESOLVE_CITEKEY]: 'read',
  [T.INSPIRE_GRADE_EVIDENCE]: 'read',
  [T.INSPIRE_DETECT_MEASUREMENT_CONFLICTS]: 'read',
  [T.INSPIRE_CRITICAL_ANALYSIS]: 'read',
  [T.INSPIRE_CLASSIFY_REVIEWS]: 'read',
  // Writes its records and map into the caller's output_dir.
  [T.INSPIRE_THEORETICAL_CONFLICTS]: 'write',
  [T.INSPIRE_FIND_CROSSOVER_TOPICS]: 'read',
  [T.INSPIRE_ANALYZE_CITATION_STANCE]: 'read',
  [T.INSPIRE_CLEANUP_DOWNLOADS]: 'destructive',
  // Downloads the paper source and returns its path (source_file).
  [T.INSPIRE_VALIDATE_BIBLIOGRAPHY]: 'write',
  // Sibling-provider tools re-exported here take their levels from the
  // provider's own table, so this server and the standalone one agree.
  ...ARXIV_TOOL_RISK_LEVELS,
  ...PDG_TOOL_RISK_LEVELS,
  ...ZOTERO_TOOL_RISK_LEVELS,
  ...HEPDATA_TOOL_RISK_LEVELS,
  ...OPENALEX_TOOL_RISK_LEVELS,
};

export function getHepToolRiskLevel(
  toolName: string,
  fallback: ToolRiskLevel = 'read',
): ToolRiskLevel {
  return getToolRiskLevel(toolName, HEP_TOOL_RISK_LEVELS, fallback);
}
