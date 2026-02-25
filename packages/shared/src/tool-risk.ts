/**
 * Tool risk classification for MCP tools (H-11a).
 *
 * Three-level classification:
 * - read:        Returns data without modifying any state
 * - write:       Creates or modifies run state, artifacts, or external resources
 * - destructive: Irreversible operations (export, delete). Requires _confirm: true.
 */
import * as T from './tool-names.js';

export type ToolRiskLevel = 'read' | 'write' | 'destructive';

/**
 * Static risk level map for all tools in the ecosystem.
 * Consumed by the orchestrator for policy decisions without needing the full registry.
 */
export const TOOL_RISK_LEVELS: Record<string, ToolRiskLevel> = {
  // ── HEP Project Tools ─────────────────────────────────────────────────
  [T.HEP_PROJECT_CREATE]: 'write',
  [T.HEP_PROJECT_GET]: 'read',
  [T.HEP_PROJECT_LIST]: 'read',
  [T.HEP_HEALTH]: 'read',
  [T.HEP_PROJECT_BUILD_EVIDENCE]: 'write',
  [T.HEP_PROJECT_QUERY_EVIDENCE]: 'read',
  [T.HEP_PROJECT_QUERY_EVIDENCE_SEMANTIC]: 'read',
  [T.HEP_PROJECT_PLAYBACK_EVIDENCE]: 'read',
  [T.HEP_PROJECT_COMPARE_MEASUREMENTS]: 'read',

  // ── HEP Run Management ────────────────────────────────────────────────
  [T.HEP_RUN_CREATE]: 'write',
  [T.HEP_RUN_READ_ARTIFACT_CHUNK]: 'read',
  [T.HEP_RUN_CLEAR_MANIFEST_LOCK]: 'write',
  [T.HEP_RUN_STAGE_CONTENT]: 'write',
  [T.HEP_RUN_BUILD_PDF_EVIDENCE]: 'write',
  [T.HEP_RUN_BUILD_EVIDENCE_INDEX_V1]: 'write',

  // ── HEP Run Writing: Token Budget ─────────────────────────────────────
  [T.HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1]: 'write',
  [T.HEP_RUN_WRITING_TOKEN_GATE_V1]: 'read',

  // ── HEP Run Writing: Paperset Curation ────────────────────────────────
  [T.HEP_RUN_WRITING_CREATE_PAPERSET_CURATION_PACKET]: 'write',
  [T.HEP_RUN_WRITING_SUBMIT_PAPERSET_CURATION]: 'write',

  // ── HEP Run Writing: Outline Pipeline ─────────────────────────────────
  [T.HEP_RUN_WRITING_CREATE_OUTLINE_CANDIDATES_PACKET_V1]: 'write',
  [T.HEP_RUN_WRITING_SUBMIT_OUTLINE_CANDIDATES_V1]: 'write',
  [T.HEP_RUN_WRITING_CREATE_OUTLINE_JUDGE_PACKET_V1]: 'write',
  [T.HEP_RUN_WRITING_SUBMIT_OUTLINE_JUDGE_DECISION_V1]: 'write',

  // ── HEP Run Writing: Section Pipeline ─────────────────────────────────
  [T.HEP_RUN_WRITING_CREATE_SECTION_WRITE_PACKET_V1]: 'write',
  [T.HEP_RUN_WRITING_CREATE_SECTION_CANDIDATES_PACKET_V1]: 'write',
  [T.HEP_RUN_WRITING_SUBMIT_SECTION_CANDIDATES_V1]: 'write',
  [T.HEP_RUN_WRITING_CREATE_SECTION_JUDGE_PACKET_V1]: 'write',
  [T.HEP_RUN_WRITING_SUBMIT_SECTION_JUDGE_DECISION_V1]: 'write',

  // ── HEP Run Writing: Evidence ─────────────────────────────────────────
  [T.HEP_RUN_BUILD_WRITING_EVIDENCE]: 'write',
  [T.HEP_RUN_BUILD_MEASUREMENTS]: 'write',
  [T.HEP_RUN_BUILD_WRITING_CRITICAL]: 'write',
  [T.HEP_RUN_BUILD_CITATION_MAPPING]: 'write',
  [T.HEP_RUN_WRITING_BUILD_EVIDENCE_PACKET_SECTION_V2]: 'write',
  [T.HEP_RUN_WRITING_SUBMIT_RERANK_RESULT_V1]: 'write',

  // ── HEP Run Writing: Review & Revision ────────────────────────────────
  [T.HEP_RUN_WRITING_SUBMIT_REVIEW]: 'write',
  [T.HEP_RUN_WRITING_CREATE_REVISION_PLAN_PACKET_V1]: 'write',
  [T.HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1]: 'write',

  // ── HEP Run Writing: Integration ──────────────────────────────────────
  [T.HEP_RUN_WRITING_REFINEMENT_ORCHESTRATOR_V1]: 'write',
  [T.HEP_RUN_WRITING_INTEGRATE_SECTIONS_V1]: 'write',

  // ── HEP Render & Export ───────────────────────────────────────────────
  [T.HEP_RENDER_LATEX]: 'write',
  [T.HEP_EXPORT_PROJECT]: 'destructive',
  [T.HEP_EXPORT_PAPER_SCAFFOLD]: 'destructive',
  [T.HEP_IMPORT_PAPER_BUNDLE]: 'write',
  [T.HEP_IMPORT_FROM_ZOTERO]: 'write',

  // ── HEP INSPIRE Integration ───────────────────────────────────────────
  [T.HEP_INSPIRE_SEARCH_EXPORT]: 'write',
  [T.HEP_INSPIRE_RESOLVE_IDENTIFIERS]: 'read',

  // ── INSPIRE Search & Navigation ───────────────────────────────────────
  [T.INSPIRE_SEARCH]: 'read',
  [T.INSPIRE_SEARCH_NEXT]: 'read',
  [T.INSPIRE_RESEARCH_NAVIGATOR]: 'read',
  [T.INSPIRE_DEEP_RESEARCH]: 'write',

  // ── INSPIRE Literature Access ─────────────────────────────────────────
  [T.INSPIRE_LITERATURE]: 'read',
  [T.INSPIRE_PAPER_SOURCE]: 'write',
  [T.INSPIRE_PARSE_LATEX]: 'write',
  [T.INSPIRE_RESOLVE_CITEKEY]: 'read',
  [T.INSPIRE_CRITICAL_RESEARCH]: 'read',

  // ── INSPIRE Analysis ──────────────────────────────────────────────────
  [T.INSPIRE_FIND_CROSSOVER_TOPICS]: 'read',
  [T.INSPIRE_ANALYZE_CITATION_STANCE]: 'read',
  [T.INSPIRE_CLEANUP_DOWNLOADS]: 'destructive',
  [T.INSPIRE_VALIDATE_BIBLIOGRAPHY]: 'read',

  // ── INSPIRE Style Corpus ──────────────────────────────────────────────
  [T.INSPIRE_STYLE_CORPUS_QUERY]: 'read',
  [T.INSPIRE_STYLE_CORPUS_INIT_PROFILE]: 'write',
  [T.INSPIRE_STYLE_CORPUS_BUILD_MANIFEST]: 'write',
  [T.INSPIRE_STYLE_CORPUS_DOWNLOAD]: 'write',
  [T.INSPIRE_STYLE_CORPUS_BUILD_EVIDENCE]: 'write',
  [T.INSPIRE_STYLE_CORPUS_BUILD_INDEX]: 'write',
  [T.INSPIRE_STYLE_CORPUS_EXPORT_PACK]: 'destructive',
  [T.INSPIRE_STYLE_CORPUS_IMPORT_PACK]: 'write',

  // ── PDG Tools ─────────────────────────────────────────────────────────
  [T.PDG_INFO]: 'read',
  [T.PDG_FIND_PARTICLE]: 'read',
  [T.PDG_FIND_REFERENCE]: 'read',
  [T.PDG_GET_REFERENCE]: 'read',
  [T.PDG_GET_PROPERTY]: 'read',
  [T.PDG_GET]: 'read',
  [T.PDG_GET_DECAYS]: 'read',
  [T.PDG_GET_MEASUREMENTS]: 'read',
  [T.PDG_BATCH]: 'read',

  // ── Zotero Tools ──────────────────────────────────────────────────────
  [T.ZOTERO_LOCAL]: 'read',
  [T.ZOTERO_FIND_ITEMS]: 'read',
  [T.ZOTERO_SEARCH_ITEMS]: 'read',
  [T.ZOTERO_EXPORT_ITEMS]: 'read',
  [T.ZOTERO_GET_SELECTED_COLLECTION]: 'read',
  [T.ZOTERO_ADD]: 'write',
  [T.ZOTERO_CONFIRM]: 'write',
};
