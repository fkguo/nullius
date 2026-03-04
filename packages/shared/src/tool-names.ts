/**
 * Centralized tool name constants for all MCP servers in the autoresearch ecosystem.
 *
 * H-16a: Tool names extracted from hardcoded strings to shared constants.
 *
 * Convention:
 * - Constants use SCREAMING_SNAKE_CASE matching the tool name
 * - Tool names use snake_case with prefix: hep_*, inspire_*, pdg_*, zotero_*
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
export const HEP_RUN_INGEST_SKILL_ARTIFACTS = 'hep_run_ingest_skill_artifacts' as const;
export const HEP_RUN_CREATE_FROM_IDEA = 'hep_run_create_from_idea' as const;

// ── HEP Run Evidence & Citation Mapping ─────────────────────────────────────

export const HEP_RUN_BUILD_WRITING_EVIDENCE = 'hep_run_build_writing_evidence' as const;
export const HEP_RUN_BUILD_MEASUREMENTS = 'hep_run_build_measurements' as const;
export const HEP_RUN_BUILD_CITATION_MAPPING = 'hep_run_build_citation_mapping' as const;

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

// ── HEPData Tools ────────────────────────────────────────────────────────────

export const HEPDATA_SEARCH = 'hepdata_search' as const;
export const HEPDATA_GET_RECORD = 'hepdata_get_record' as const;
export const HEPDATA_GET_TABLE = 'hepdata_get_table' as const;
export const HEPDATA_DOWNLOAD = 'hepdata_download' as const;

// ── Arxiv Tools ──────────────────────────────────────────────────────────────

export const ARXIV_SEARCH = 'arxiv_search' as const;
export const ARXIV_GET_METADATA = 'arxiv_get_metadata' as const;
export const ARXIV_PAPER_SOURCE = 'arxiv_paper_source' as const;

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

// ── Orchestrator Run Tools (NEW-R15-impl) ────────────────────────────────────

export const ORCH_RUN_PREFIX = 'orch_run_' as const;
export const ORCH_RUN_CREATE = 'orch_run_create' as const;
export const ORCH_RUN_STATUS = 'orch_run_status' as const;
export const ORCH_RUN_LIST = 'orch_run_list' as const;
export const ORCH_RUN_APPROVE = 'orch_run_approve' as const;
export const ORCH_RUN_REJECT = 'orch_run_reject' as const;
export const ORCH_RUN_EXPORT = 'orch_run_export' as const;
export const ORCH_RUN_PAUSE = 'orch_run_pause' as const;
export const ORCH_RUN_RESUME = 'orch_run_resume' as const;
export const ORCH_RUN_APPROVALS_LIST = 'orch_run_approvals_list' as const;
export const ORCH_POLICY_QUERY = 'orch_policy_query' as const;

// ── OpenAlex Tools ──────────────────────────────────────────────────────────

export const OPENALEX_SEARCH = 'openalex_search' as const;
export const OPENALEX_SEMANTIC_SEARCH = 'openalex_semantic_search' as const;
export const OPENALEX_GET = 'openalex_get' as const;
export const OPENALEX_FILTER = 'openalex_filter' as const;
export const OPENALEX_GROUP = 'openalex_group' as const;
export const OPENALEX_REFERENCES = 'openalex_references' as const;
export const OPENALEX_CITATIONS = 'openalex_citations' as const;
export const OPENALEX_BATCH = 'openalex_batch' as const;
export const OPENALEX_AUTOCOMPLETE = 'openalex_autocomplete' as const;
export const OPENALEX_CONTENT = 'openalex_content' as const;
export const OPENALEX_RATE_LIMIT = 'openalex_rate_limit' as const;

// ── Idea Tools (NEW-IDEA-01) ─────────────────────────────────────────────────

export const IDEA_PREFIX = 'idea_' as const;
export const IDEA_CAMPAIGN_INIT = 'idea_campaign_init' as const;
export const IDEA_CAMPAIGN_STATUS = 'idea_campaign_status' as const;
export const IDEA_CAMPAIGN_TOPUP = 'idea_campaign_topup' as const;
export const IDEA_CAMPAIGN_PAUSE = 'idea_campaign_pause' as const;
export const IDEA_CAMPAIGN_RESUME = 'idea_campaign_resume' as const;
export const IDEA_CAMPAIGN_COMPLETE = 'idea_campaign_complete' as const;
export const IDEA_SEARCH_STEP = 'idea_search_step' as const;
export const IDEA_EVAL_RUN = 'idea_eval_run' as const;

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
  | typeof HEP_RUN_INGEST_SKILL_ARTIFACTS
  | typeof HEP_RUN_CREATE_FROM_IDEA
  | typeof HEP_RUN_BUILD_WRITING_EVIDENCE
  | typeof HEP_RUN_BUILD_MEASUREMENTS
  | typeof HEP_RUN_BUILD_CITATION_MAPPING
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
  | typeof INSPIRE_VALIDATE_BIBLIOGRAPHY;

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

export type OrchToolName =
  | typeof ORCH_RUN_CREATE
  | typeof ORCH_RUN_STATUS
  | typeof ORCH_RUN_LIST
  | typeof ORCH_RUN_APPROVE
  | typeof ORCH_RUN_REJECT
  | typeof ORCH_RUN_EXPORT
  | typeof ORCH_RUN_PAUSE
  | typeof ORCH_RUN_RESUME
  | typeof ORCH_RUN_APPROVALS_LIST
  | typeof ORCH_POLICY_QUERY;

export type IdeaToolName =
  | typeof IDEA_CAMPAIGN_INIT
  | typeof IDEA_CAMPAIGN_STATUS
  | typeof IDEA_CAMPAIGN_TOPUP
  | typeof IDEA_CAMPAIGN_PAUSE
  | typeof IDEA_CAMPAIGN_RESUME
  | typeof IDEA_CAMPAIGN_COMPLETE
  | typeof IDEA_SEARCH_STEP
  | typeof IDEA_EVAL_RUN;

export type OpenAlexToolName =
  | typeof OPENALEX_SEARCH
  | typeof OPENALEX_SEMANTIC_SEARCH
  | typeof OPENALEX_GET
  | typeof OPENALEX_FILTER
  | typeof OPENALEX_GROUP
  | typeof OPENALEX_REFERENCES
  | typeof OPENALEX_CITATIONS
  | typeof OPENALEX_BATCH
  | typeof OPENALEX_AUTOCOMPLETE
  | typeof OPENALEX_CONTENT
  | typeof OPENALEX_RATE_LIMIT;

export type HepDataToolName =
  | typeof HEPDATA_SEARCH
  | typeof HEPDATA_GET_RECORD
  | typeof HEPDATA_GET_TABLE
  | typeof HEPDATA_DOWNLOAD;

export type ArxivToolName =
  | typeof ARXIV_SEARCH
  | typeof ARXIV_GET_METADATA
  | typeof ARXIV_PAPER_SOURCE;

/** Union of all tool names across the ecosystem */
export type ToolName = HepToolName | InspireToolName | PdgToolName | ZoteroToolName | OrchToolName | IdeaToolName | HepDataToolName | ArxivToolName | OpenAlexToolName;
