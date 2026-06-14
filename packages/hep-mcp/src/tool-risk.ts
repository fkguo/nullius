import {
  getToolRiskLevel,
  type ToolRiskLevel,
  type ToolRiskTable,
} from '@autoresearch/shared';
import * as T from './tool-names.js';

export type { ToolRiskLevel } from '@autoresearch/shared';

/**
 * hep-mcp owns the concrete risk authority for the tool catalog it exposes,
 * including consolidated sibling-provider tools surfaced through hep-mcp.
 */
export const HEP_TOOL_RISK_LEVELS: ToolRiskTable = {
  [T.HEP_PROJECT_CREATE]: 'write',
  [T.HEP_PROJECT_GET]: 'read',
  [T.HEP_PROJECT_LIST]: 'read',
  [T.HEP_HEALTH]: 'read',
  [T.HEP_PROJECT_BUILD_EVIDENCE]: 'write',
  [T.HEP_PROJECT_QUERY_EVIDENCE]: 'read',
  [T.HEP_PROJECT_QUERY_EVIDENCE_SEMANTIC]: 'read',
  [T.HEP_PROJECT_PLAYBACK_EVIDENCE]: 'read',
  [T.HEP_PROJECT_COMPARE_MEASUREMENTS]: 'read',
  [T.HEP_RUN_CREATE]: 'write',
  [T.HEP_RUN_READ_ARTIFACT_CHUNK]: 'read',
  [T.HEP_RUN_CLEAR_MANIFEST_LOCK]: 'write',
  [T.HEP_RUN_STAGE_CONTENT]: 'write',
  [T.HEP_RUN_INGEST_SKILL_ARTIFACTS]: 'write',
  [T.HEP_RUN_BUILD_WRITING_EVIDENCE]: 'write',
  [T.HEP_RUN_BUILD_MEASUREMENTS]: 'write',
  [T.HEP_RUN_BUILD_CITATION_MAPPING]: 'write',
  [T.HEP_RENDER_LATEX]: 'write',
  [T.HEP_EXPORT_PROJECT]: 'destructive',
  [T.HEP_EXPORT_PAPER_SCAFFOLD]: 'destructive',
  [T.HEP_IMPORT_PAPER_BUNDLE]: 'write',
  [T.HEP_IMPORT_FROM_ZOTERO]: 'write',
  [T.HEP_INSPIRE_SEARCH_EXPORT]: 'write',
  [T.HEP_INSPIRE_RESOLVE_IDENTIFIERS]: 'read',
  // Classified as 'write' rather than 'destructive' so dry-run (apply=false)
  // calls flow freely without the dispatcher-level _confirm gate. The handler
  // enforces the destructive gate itself: apply=true REQUIRES _confirm=true,
  // otherwise the call falls through to dry-run with a warning. This gives
  // dry-run a frictionless preview UX while still requiring two-key safety on
  // any real mutation. Same pattern applies to hep_admin_prune_paper_cache.
  [T.HEP_ADMIN_MIGRATE_PAPERS_CACHE]: 'write',
  [T.HEP_ADMIN_PRUNE_PAPER_CACHE]: 'write',
  // hep_admin_import_paper: handler enforces dual-key only on overwrite=true
  // (the destructive path). A first-time import is a pure additive write; we
  // still classify the tool as 'write' so the dispatcher does not gate non-
  // destructive imports, and we keep parity with the rest of the admin family.
  [T.HEP_ADMIN_IMPORT_PAPER]: 'write',
  // hep_admin_link_kb_notes is strictly read-only: it reports the linkage
  // state between Tier 2 paper.json and Tier 1 knowledge_base/*.md notes
  // without mutating either surface. Classified as 'read' so no _confirm or
  // apply gating applies.
  [T.HEP_ADMIN_LINK_KB_NOTES]: 'read',
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
  [T.INSPIRE_THEORETICAL_CONFLICTS]: 'read',
  [T.INSPIRE_FIND_CROSSOVER_TOPICS]: 'read',
  [T.INSPIRE_ANALYZE_CITATION_STANCE]: 'read',
  [T.INSPIRE_CLEANUP_DOWNLOADS]: 'destructive',
  [T.INSPIRE_VALIDATE_BIBLIOGRAPHY]: 'read',
  [T.ARXIV_SEARCH]: 'read',
  [T.ARXIV_GET_METADATA]: 'read',
  [T.ARXIV_PAPER_SOURCE]: 'write',
  [T.PDG_INFO]: 'read',
  [T.PDG_FIND_PARTICLE]: 'read',
  [T.PDG_FIND_REFERENCE]: 'read',
  [T.PDG_GET_REFERENCE]: 'read',
  [T.PDG_GET_PROPERTY]: 'read',
  [T.PDG_GET]: 'read',
  [T.PDG_GET_DECAYS]: 'read',
  [T.PDG_GET_MEASUREMENTS]: 'read',
  [T.PDG_BATCH]: 'read',
  [T.ZOTERO_LOCAL]: 'read',
  [T.ZOTERO_FIND_ITEMS]: 'read',
  [T.ZOTERO_SEARCH_ITEMS]: 'read',
  [T.ZOTERO_EXPORT_ITEMS]: 'read',
  [T.ZOTERO_GET_SELECTED_COLLECTION]: 'read',
  [T.ZOTERO_ADD]: 'write',
  [T.ZOTERO_CONFIRM]: 'write',
  [T.ZOTERO_DELETE]: 'write',
  [T.HEPDATA_SEARCH]: 'read',
  [T.HEPDATA_GET_RECORD]: 'read',
  [T.HEPDATA_GET_TABLE]: 'read',
  [T.HEPDATA_DOWNLOAD]: 'destructive',
  [T.OPENALEX_SEARCH]: 'read',
  [T.OPENALEX_SEMANTIC_SEARCH]: 'read',
  [T.OPENALEX_GET]: 'read',
  [T.OPENALEX_FILTER]: 'read',
  [T.OPENALEX_GROUP]: 'read',
  [T.OPENALEX_REFERENCES]: 'read',
  [T.OPENALEX_CITATIONS]: 'read',
  [T.OPENALEX_BATCH]: 'read',
  [T.OPENALEX_AUTOCOMPLETE]: 'read',
  [T.OPENALEX_CONTENT]: 'destructive',
  [T.OPENALEX_RATE_LIMIT]: 'read',
};

export function getHepToolRiskLevel(
  toolName: string,
  fallback: ToolRiskLevel = 'read',
): ToolRiskLevel {
  return getToolRiskLevel(toolName, HEP_TOOL_RISK_LEVELS, fallback);
}
