/**
 * Centralized tool name constants for all MCP servers in the autoresearch ecosystem.
 *
 * H-16a: Tool names extracted from hardcoded strings to shared constants.
 *
 * Convention:
 * - Constants use SCREAMING_SNAKE_CASE matching the tool name
 * - Tool names use snake_case with prefix: hep_*, inspire_*, pdg_*, zotero_*
 * - Writing tools follow the pattern: hep_run_writing_{action}_{object}_v{N}
 *
 * Writing pipeline stages (for hep_run_writing_* tools):
 *   1. Evidence: build_writing_evidence, build_evidence_packet_section, submit_rerank_result
 *   2. Token Budget: create_token_budget_plan, token_gate
 *   3. Paperset Curation: create_paperset_curation_packet, submit_paperset_curation
 *   4. Outline: create_outline_candidates_packet, submit_outline_candidates,
 *              create_outline_judge_packet, submit_outline_judge_decision
 *   5. Section: create_section_write_packet, create_section_candidates_packet,
 *              submit_section_candidates, create_section_judge_packet,
 *              submit_section_judge_decision
 *   6. Integration: integrate_sections, refinement_orchestrator
 *   7. Review: submit_review, create_revision_plan_packet, submit_revision_plan
 */

// ── Namespace Prefixes ──────────────────────────────────────────────────────

export const HEP_RUN_PREFIX = 'hep_run_' as const;

// ── HEP Project Tools ───────────────────────────────────────────────────────

export const HEP_PROJECT_CREATE = 'hep_project_create' as const;
export const HEP_PROJECT_GET = 'hep_project_get' as const;
export const HEP_PROJECT_LIST = 'hep_project_list' as const;
export const HEP_HEALTH = 'hep_health' as const;
export const HEP_PROJECT_BUILD_EVIDENCE = 'hep_project_build_evidence' as const;
export const HEP_PROJECT_QUERY_EVIDENCE = 'hep_project_query_evidence' as const;
export const HEP_PROJECT_QUERY_EVIDENCE_SEMANTIC = 'hep_project_query_evidence_semantic' as const;
export const HEP_PROJECT_PLAYBACK_EVIDENCE = 'hep_project_playback_evidence' as const;
export const HEP_PROJECT_COMPARE_MEASUREMENTS = 'hep_project_compare_measurements' as const;

// ── HEP Run Management ─────────────────────────────────────────────────────

export const HEP_RUN_CREATE = 'hep_run_create' as const;
export const HEP_RUN_READ_ARTIFACT_CHUNK = 'hep_run_read_artifact_chunk' as const;
export const HEP_RUN_CLEAR_MANIFEST_LOCK = 'hep_run_clear_manifest_lock' as const;
export const HEP_RUN_STAGE_CONTENT = 'hep_run_stage_content' as const;
export const HEP_RUN_BUILD_PDF_EVIDENCE = 'hep_run_build_pdf_evidence' as const;
export const HEP_RUN_BUILD_EVIDENCE_INDEX_V1 = 'hep_run_build_evidence_index_v1' as const;

// ── HEP Run Writing: Token Budget (Stage 2) ────────────────────────────────

export const HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1 = 'hep_run_writing_create_token_budget_plan_v1' as const;
export const HEP_RUN_WRITING_TOKEN_GATE_V1 = 'hep_run_writing_token_gate_v1' as const;

// ── HEP Run Writing: Paperset Curation (Stage 3) ───────────────────────────

export const HEP_RUN_WRITING_CREATE_PAPERSET_CURATION_PACKET = 'hep_run_writing_create_paperset_curation_packet' as const;
export const HEP_RUN_WRITING_SUBMIT_PAPERSET_CURATION = 'hep_run_writing_submit_paperset_curation' as const;

// ── HEP Run Writing: Outline Pipeline (Stage 4) ────────────────────────────

export const HEP_RUN_WRITING_CREATE_OUTLINE_CANDIDATES_PACKET_V1 = 'hep_run_writing_create_outline_candidates_packet_v1' as const;
export const HEP_RUN_WRITING_SUBMIT_OUTLINE_CANDIDATES_V1 = 'hep_run_writing_submit_outline_candidates_v1' as const;
export const HEP_RUN_WRITING_CREATE_OUTLINE_JUDGE_PACKET_V1 = 'hep_run_writing_create_outline_judge_packet_v1' as const;
export const HEP_RUN_WRITING_SUBMIT_OUTLINE_JUDGE_DECISION_V1 = 'hep_run_writing_submit_outline_judge_decision_v1' as const;

// ── HEP Run Writing: Section Pipeline (Stage 5) ────────────────────────────

export const HEP_RUN_WRITING_CREATE_SECTION_WRITE_PACKET_V1 = 'hep_run_writing_create_section_write_packet_v1' as const;
export const HEP_RUN_WRITING_CREATE_SECTION_CANDIDATES_PACKET_V1 = 'hep_run_writing_create_section_candidates_packet_v1' as const;
export const HEP_RUN_WRITING_SUBMIT_SECTION_CANDIDATES_V1 = 'hep_run_writing_submit_section_candidates_v1' as const;
export const HEP_RUN_WRITING_CREATE_SECTION_JUDGE_PACKET_V1 = 'hep_run_writing_create_section_judge_packet_v1' as const;
export const HEP_RUN_WRITING_SUBMIT_SECTION_JUDGE_DECISION_V1 = 'hep_run_writing_submit_section_judge_decision_v1' as const;

// ── HEP Run Writing: Evidence (Stage 1) ─────────────────────────────────────

export const HEP_RUN_BUILD_WRITING_EVIDENCE = 'hep_run_build_writing_evidence' as const;
export const HEP_RUN_BUILD_MEASUREMENTS = 'hep_run_build_measurements' as const;
export const HEP_RUN_BUILD_WRITING_CRITICAL = 'hep_run_build_writing_critical' as const;
export const HEP_RUN_BUILD_CITATION_MAPPING = 'hep_run_build_citation_mapping' as const;
export const HEP_RUN_WRITING_BUILD_EVIDENCE_PACKET_SECTION_V2 = 'hep_run_writing_build_evidence_packet_section_v2' as const;
export const HEP_RUN_WRITING_SUBMIT_RERANK_RESULT_V1 = 'hep_run_writing_submit_rerank_result_v1' as const;

// ── HEP Run Writing: Review & Revision (Stage 7) ───────────────────────────

export const HEP_RUN_WRITING_SUBMIT_REVIEW = 'hep_run_writing_submit_review' as const;
export const HEP_RUN_WRITING_CREATE_REVISION_PLAN_PACKET_V1 = 'hep_run_writing_create_revision_plan_packet_v1' as const;
export const HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1 = 'hep_run_writing_submit_revision_plan_v1' as const;

// ── HEP Run Writing: Integration (Stage 6) ─────────────────────────────────

export const HEP_RUN_WRITING_REFINEMENT_ORCHESTRATOR_V1 = 'hep_run_writing_refinement_orchestrator_v1' as const;
export const HEP_RUN_WRITING_INTEGRATE_SECTIONS_V1 = 'hep_run_writing_integrate_sections_v1' as const;

// ── HEP Render & Export ─────────────────────────────────────────────────────

export const HEP_RENDER_LATEX = 'hep_render_latex' as const;
export const HEP_EXPORT_PROJECT = 'hep_export_project' as const;
export const HEP_EXPORT_PAPER_SCAFFOLD = 'hep_export_paper_scaffold' as const;
export const HEP_IMPORT_PAPER_BUNDLE = 'hep_import_paper_bundle' as const;
export const HEP_IMPORT_FROM_ZOTERO = 'hep_import_from_zotero' as const;

// ── HEP INSPIRE Integration ─────────────────────────────────────────────────

export const HEP_INSPIRE_SEARCH_EXPORT = 'hep_inspire_search_export' as const;
export const HEP_INSPIRE_RESOLVE_IDENTIFIERS = 'hep_inspire_resolve_identifiers' as const;

// ── INSPIRE Search & Navigation ─────────────────────────────────────────────

export const INSPIRE_SEARCH = 'inspire_search' as const;
export const INSPIRE_SEARCH_NEXT = 'inspire_search_next' as const;
export const INSPIRE_RESEARCH_NAVIGATOR = 'inspire_research_navigator' as const;
export const INSPIRE_DEEP_RESEARCH = 'inspire_deep_research' as const;

// ── INSPIRE Literature Access ───────────────────────────────────────────────

export const INSPIRE_LITERATURE = 'inspire_literature' as const;
export const INSPIRE_PAPER_SOURCE = 'inspire_paper_source' as const;
export const INSPIRE_PARSE_LATEX = 'inspire_parse_latex' as const;
export const INSPIRE_RESOLVE_CITEKEY = 'inspire_resolve_citekey' as const;
export const INSPIRE_CRITICAL_RESEARCH = 'inspire_critical_research' as const;

// ── INSPIRE Analysis ────────────────────────────────────────────────────────

export const INSPIRE_FIND_CROSSOVER_TOPICS = 'inspire_find_crossover_topics' as const;
export const INSPIRE_ANALYZE_CITATION_STANCE = 'inspire_analyze_citation_stance' as const;
export const INSPIRE_CLEANUP_DOWNLOADS = 'inspire_cleanup_downloads' as const;
export const INSPIRE_VALIDATE_BIBLIOGRAPHY = 'inspire_validate_bibliography' as const;

// ── INSPIRE Style Corpus ────────────────────────────────────────────────────

export const INSPIRE_STYLE_CORPUS_QUERY = 'inspire_style_corpus_query' as const;
export const INSPIRE_STYLE_CORPUS_INIT_PROFILE = 'inspire_style_corpus_init_profile' as const;
export const INSPIRE_STYLE_CORPUS_BUILD_MANIFEST = 'inspire_style_corpus_build_manifest' as const;
export const INSPIRE_STYLE_CORPUS_DOWNLOAD = 'inspire_style_corpus_download' as const;
export const INSPIRE_STYLE_CORPUS_BUILD_EVIDENCE = 'inspire_style_corpus_build_evidence' as const;
export const INSPIRE_STYLE_CORPUS_BUILD_INDEX = 'inspire_style_corpus_build_index' as const;
export const INSPIRE_STYLE_CORPUS_EXPORT_PACK = 'inspire_style_corpus_export_pack' as const;
export const INSPIRE_STYLE_CORPUS_IMPORT_PACK = 'inspire_style_corpus_import_pack' as const;

// ── PDG Tools ───────────────────────────────────────────────────────────────

export const PDG_INFO = 'pdg_info' as const;
export const PDG_FIND_PARTICLE = 'pdg_find_particle' as const;
export const PDG_FIND_REFERENCE = 'pdg_find_reference' as const;
export const PDG_GET_REFERENCE = 'pdg_get_reference' as const;
export const PDG_GET_PROPERTY = 'pdg_get_property' as const;
export const PDG_GET = 'pdg_get' as const;
export const PDG_GET_DECAYS = 'pdg_get_decays' as const;
export const PDG_GET_MEASUREMENTS = 'pdg_get_measurements' as const;
export const PDG_BATCH = 'pdg_batch' as const;

// ── Zotero Tools ────────────────────────────────────────────────────────────

export const ZOTERO_LOCAL = 'zotero_local' as const;
export const ZOTERO_FIND_ITEMS = 'zotero_find_items' as const;
export const ZOTERO_SEARCH_ITEMS = 'zotero_search_items' as const;
export const ZOTERO_EXPORT_ITEMS = 'zotero_export_items' as const;
export const ZOTERO_GET_SELECTED_COLLECTION = 'zotero_get_selected_collection' as const;
export const ZOTERO_ADD = 'zotero_add' as const;
export const ZOTERO_CONFIRM = 'zotero_confirm' as const;

// ── Aggregate Type ──────────────────────────────────────────────────────────

/** Union of all tool name constants for type-safe dispatch */
export type HepToolName =
  | typeof HEP_PROJECT_CREATE
  | typeof HEP_PROJECT_GET
  | typeof HEP_PROJECT_LIST
  | typeof HEP_HEALTH
  | typeof HEP_PROJECT_BUILD_EVIDENCE
  | typeof HEP_PROJECT_QUERY_EVIDENCE
  | typeof HEP_PROJECT_QUERY_EVIDENCE_SEMANTIC
  | typeof HEP_PROJECT_PLAYBACK_EVIDENCE
  | typeof HEP_PROJECT_COMPARE_MEASUREMENTS
  | typeof HEP_RUN_CREATE
  | typeof HEP_RUN_READ_ARTIFACT_CHUNK
  | typeof HEP_RUN_CLEAR_MANIFEST_LOCK
  | typeof HEP_RUN_STAGE_CONTENT
  | typeof HEP_RUN_BUILD_PDF_EVIDENCE
  | typeof HEP_RUN_BUILD_EVIDENCE_INDEX_V1
  | typeof HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1
  | typeof HEP_RUN_WRITING_TOKEN_GATE_V1
  | typeof HEP_RUN_WRITING_CREATE_PAPERSET_CURATION_PACKET
  | typeof HEP_RUN_WRITING_SUBMIT_PAPERSET_CURATION
  | typeof HEP_RUN_WRITING_CREATE_OUTLINE_CANDIDATES_PACKET_V1
  | typeof HEP_RUN_WRITING_SUBMIT_OUTLINE_CANDIDATES_V1
  | typeof HEP_RUN_WRITING_CREATE_OUTLINE_JUDGE_PACKET_V1
  | typeof HEP_RUN_WRITING_SUBMIT_OUTLINE_JUDGE_DECISION_V1
  | typeof HEP_RUN_WRITING_CREATE_SECTION_WRITE_PACKET_V1
  | typeof HEP_RUN_WRITING_CREATE_SECTION_CANDIDATES_PACKET_V1
  | typeof HEP_RUN_WRITING_SUBMIT_SECTION_CANDIDATES_V1
  | typeof HEP_RUN_WRITING_CREATE_SECTION_JUDGE_PACKET_V1
  | typeof HEP_RUN_WRITING_SUBMIT_SECTION_JUDGE_DECISION_V1
  | typeof HEP_RUN_BUILD_WRITING_EVIDENCE
  | typeof HEP_RUN_BUILD_MEASUREMENTS
  | typeof HEP_RUN_BUILD_WRITING_CRITICAL
  | typeof HEP_RUN_BUILD_CITATION_MAPPING
  | typeof HEP_RUN_WRITING_BUILD_EVIDENCE_PACKET_SECTION_V2
  | typeof HEP_RUN_WRITING_SUBMIT_RERANK_RESULT_V1
  | typeof HEP_RUN_WRITING_SUBMIT_REVIEW
  | typeof HEP_RUN_WRITING_CREATE_REVISION_PLAN_PACKET_V1
  | typeof HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1
  | typeof HEP_RUN_WRITING_REFINEMENT_ORCHESTRATOR_V1
  | typeof HEP_RUN_WRITING_INTEGRATE_SECTIONS_V1
  | typeof HEP_RENDER_LATEX
  | typeof HEP_EXPORT_PROJECT
  | typeof HEP_EXPORT_PAPER_SCAFFOLD
  | typeof HEP_IMPORT_PAPER_BUNDLE
  | typeof HEP_IMPORT_FROM_ZOTERO
  | typeof HEP_INSPIRE_SEARCH_EXPORT
  | typeof HEP_INSPIRE_RESOLVE_IDENTIFIERS;

export type InspireToolName =
  | typeof INSPIRE_SEARCH
  | typeof INSPIRE_SEARCH_NEXT
  | typeof INSPIRE_RESEARCH_NAVIGATOR
  | typeof INSPIRE_DEEP_RESEARCH
  | typeof INSPIRE_LITERATURE
  | typeof INSPIRE_PAPER_SOURCE
  | typeof INSPIRE_PARSE_LATEX
  | typeof INSPIRE_RESOLVE_CITEKEY
  | typeof INSPIRE_CRITICAL_RESEARCH
  | typeof INSPIRE_FIND_CROSSOVER_TOPICS
  | typeof INSPIRE_ANALYZE_CITATION_STANCE
  | typeof INSPIRE_CLEANUP_DOWNLOADS
  | typeof INSPIRE_VALIDATE_BIBLIOGRAPHY
  | typeof INSPIRE_STYLE_CORPUS_QUERY
  | typeof INSPIRE_STYLE_CORPUS_INIT_PROFILE
  | typeof INSPIRE_STYLE_CORPUS_BUILD_MANIFEST
  | typeof INSPIRE_STYLE_CORPUS_DOWNLOAD
  | typeof INSPIRE_STYLE_CORPUS_BUILD_EVIDENCE
  | typeof INSPIRE_STYLE_CORPUS_BUILD_INDEX
  | typeof INSPIRE_STYLE_CORPUS_EXPORT_PACK
  | typeof INSPIRE_STYLE_CORPUS_IMPORT_PACK;

export type PdgToolName =
  | typeof PDG_INFO
  | typeof PDG_FIND_PARTICLE
  | typeof PDG_FIND_REFERENCE
  | typeof PDG_GET_REFERENCE
  | typeof PDG_GET_PROPERTY
  | typeof PDG_GET
  | typeof PDG_GET_DECAYS
  | typeof PDG_GET_MEASUREMENTS
  | typeof PDG_BATCH;

export type ZoteroToolName =
  | typeof ZOTERO_LOCAL
  | typeof ZOTERO_FIND_ITEMS
  | typeof ZOTERO_SEARCH_ITEMS
  | typeof ZOTERO_EXPORT_ITEMS
  | typeof ZOTERO_GET_SELECTED_COLLECTION
  | typeof ZOTERO_ADD
  | typeof ZOTERO_CONFIRM;

/** Union of all tool names across the ecosystem */
export type ToolName = HepToolName | InspireToolName | PdgToolName | ZoteroToolName;
