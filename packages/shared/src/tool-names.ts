/**
 * Shared tool-name seams for cross-package contracts.
 *
 * Provider-owned concrete tool families stay with their owning package.
 * Shared only keeps cross-package tool constants that still act as shared
 * ecosystem contracts here.
 */

// ── INSPIRE Search & Navigation ─────────────────────────────────────────────

export const INSPIRE_SEARCH = 'inspire_search' as const;
export const INSPIRE_SEARCH_NEXT = 'inspire_search_next' as const;
export const INSPIRE_RESEARCH_NAVIGATOR = 'inspire_research_navigator' as const;
export const INSPIRE_DEEP_RESEARCH = 'inspire_deep_research' as const;

// ── INSPIRE Literature Access & Analysis ────────────────────────────────────

export const INSPIRE_LITERATURE = 'inspire_literature' as const;
export const INSPIRE_PAPER_SOURCE = 'inspire_paper_source' as const;
export const INSPIRE_PARSE_LATEX = 'inspire_parse_latex' as const;
export const INSPIRE_RESOLVE_CITEKEY = 'inspire_resolve_citekey' as const;
export const INSPIRE_CRITICAL_RESEARCH = 'inspire_critical_research' as const;
export const INSPIRE_FIND_CROSSOVER_TOPICS = 'inspire_find_crossover_topics' as const;
export const INSPIRE_ANALYZE_CITATION_STANCE = 'inspire_analyze_citation_stance' as const;
export const INSPIRE_CLEANUP_DOWNLOADS = 'inspire_cleanup_downloads' as const;
export const INSPIRE_VALIDATE_BIBLIOGRAPHY = 'inspire_validate_bibliography' as const;

// ── HEPData Tools ───────────────────────────────────────────────────────────

export const HEPDATA_SEARCH = 'hepdata_search' as const;
export const HEPDATA_GET_RECORD = 'hepdata_get_record' as const;
export const HEPDATA_GET_TABLE = 'hepdata_get_table' as const;
export const HEPDATA_DOWNLOAD = 'hepdata_download' as const;

// ── Arxiv Tools ─────────────────────────────────────────────────────────────

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

// ── Orchestrator Run Tools ──────────────────────────────────────────────────

export const ORCH_RUN_CREATE = 'orch_run_create' as const;
export const ORCH_RUN_STATUS = 'orch_run_status' as const;
export const ORCH_RUN_LIST = 'orch_run_list' as const;
export const ORCH_RUN_APPROVE = 'orch_run_approve' as const;
export const ORCH_RUN_REJECT = 'orch_run_reject' as const;
export const ORCH_RUN_EXPORT = 'orch_run_export' as const;
export const ORCH_RUN_PAUSE = 'orch_run_pause' as const;
export const ORCH_RUN_RESUME = 'orch_run_resume' as const;
export const ORCH_RUN_APPROVALS_LIST = 'orch_run_approvals_list' as const;
export const ORCH_RUN_EXECUTE_AGENT = 'orch_run_execute_agent' as const;
export const ORCH_POLICY_QUERY = 'orch_policy_query' as const;
export const ORCH_FLEET_STATUS = 'orch_fleet_status' as const;
export const ORCH_FLEET_ENQUEUE = 'orch_fleet_enqueue' as const;
export const ORCH_FLEET_CLAIM = 'orch_fleet_claim' as const;
export const ORCH_FLEET_RELEASE = 'orch_fleet_release' as const;
export const ORCH_FLEET_WORKER_POLL = 'orch_fleet_worker_poll' as const;
export const ORCH_FLEET_WORKER_HEARTBEAT = 'orch_fleet_worker_heartbeat' as const;

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

// ── Idea Tools ──────────────────────────────────────────────────────────────

export const IDEA_CAMPAIGN_INIT = 'idea_campaign_init' as const;
export const IDEA_CAMPAIGN_STATUS = 'idea_campaign_status' as const;
export const IDEA_CAMPAIGN_TOPUP = 'idea_campaign_topup' as const;
export const IDEA_CAMPAIGN_PAUSE = 'idea_campaign_pause' as const;
export const IDEA_CAMPAIGN_RESUME = 'idea_campaign_resume' as const;
export const IDEA_CAMPAIGN_COMPLETE = 'idea_campaign_complete' as const;
export const IDEA_SEARCH_STEP = 'idea_search_step' as const;
export const IDEA_EVAL_RUN = 'idea_eval_run' as const;

/**
 * Shared code should treat tool identifiers as provider-owned strings.
 * Concrete provider families can refine this locally if they need a narrower
 * union inside their own package boundary.
 */
export type ToolName = string;
