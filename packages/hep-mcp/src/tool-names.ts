/**
 * hep-mcp local tool-name authority.
 *
 * HEP-owned tool families live here. For convenience, hep-mcp also re-exports
 * the non-HEP tool constants it composes from sibling provider packages.
 */

export const HEP_RUN_PREFIX = 'hep_run_' as const;

export const HEP_PROJECT_CREATE = 'hep_project_create' as const;
export const HEP_PROJECT_GET = 'hep_project_get' as const;
export const HEP_PROJECT_LIST = 'hep_project_list' as const;
export const HEP_HEALTH = 'hep_health' as const;
export const HEP_PROJECT_BUILD_EVIDENCE = 'hep_project_build_evidence' as const;
export const HEP_PROJECT_QUERY_EVIDENCE = 'hep_project_query_evidence' as const;
export const HEP_PROJECT_QUERY_EVIDENCE_SEMANTIC = 'hep_project_query_evidence_semantic' as const;
export const HEP_PROJECT_PLAYBACK_EVIDENCE = 'hep_project_playback_evidence' as const;
export const HEP_PROJECT_COMPARE_MEASUREMENTS = 'hep_project_compare_measurements' as const;

export const HEP_RUN_CREATE = 'hep_run_create' as const;
export const HEP_RUN_READ_ARTIFACT_CHUNK = 'hep_run_read_artifact_chunk' as const;
export const HEP_RUN_CLEAR_MANIFEST_LOCK = 'hep_run_clear_manifest_lock' as const;
export const HEP_RUN_STAGE_CONTENT = 'hep_run_stage_content' as const;
export const HEP_RUN_BUILD_PDF_EVIDENCE = 'hep_run_build_pdf_evidence' as const;
export const HEP_RUN_INGEST_SKILL_ARTIFACTS = 'hep_run_ingest_skill_artifacts' as const;
export const HEP_RUN_EXECUTE_MANIFEST = 'hep_run_execute_manifest' as const;
export const HEP_RUN_CREATE_FROM_IDEA = 'hep_run_create_from_idea' as const;
export const HEP_RUN_PLAN_COMPUTATION = 'hep_run_plan_computation' as const;
export const HEP_RUN_BUILD_WRITING_EVIDENCE = 'hep_run_build_writing_evidence' as const;
export const HEP_RUN_BUILD_MEASUREMENTS = 'hep_run_build_measurements' as const;
export const HEP_RUN_BUILD_CITATION_MAPPING = 'hep_run_build_citation_mapping' as const;

export const HEP_RENDER_LATEX = 'hep_render_latex' as const;
export const HEP_EXPORT_PROJECT = 'hep_export_project' as const;
export const HEP_EXPORT_PAPER_SCAFFOLD = 'hep_export_paper_scaffold' as const;
export const HEP_IMPORT_PAPER_BUNDLE = 'hep_import_paper_bundle' as const;
export const HEP_IMPORT_FROM_ZOTERO = 'hep_import_from_zotero' as const;
export const HEP_INSPIRE_SEARCH_EXPORT = 'hep_inspire_search_export' as const;
export const HEP_INSPIRE_RESOLVE_IDENTIFIERS = 'hep_inspire_resolve_identifiers' as const;

export {
  ARXIV_GET_METADATA,
  ARXIV_PAPER_SOURCE,
  ARXIV_SEARCH,
  HEPDATA_DOWNLOAD,
  HEPDATA_GET_RECORD,
  HEPDATA_GET_TABLE,
  HEPDATA_SEARCH,
  INSPIRE_ANALYZE_CITATION_STANCE,
  INSPIRE_CLEANUP_DOWNLOADS,
  INSPIRE_CRITICAL_RESEARCH,
  INSPIRE_DEEP_RESEARCH,
  INSPIRE_FIND_CROSSOVER_TOPICS,
  INSPIRE_LITERATURE,
  INSPIRE_PAPER_SOURCE,
  INSPIRE_PARSE_LATEX,
  INSPIRE_RESEARCH_NAVIGATOR,
  INSPIRE_RESOLVE_CITEKEY,
  INSPIRE_SEARCH,
  INSPIRE_SEARCH_NEXT,
  INSPIRE_VALIDATE_BIBLIOGRAPHY,
  OPENALEX_AUTOCOMPLETE,
  OPENALEX_BATCH,
  OPENALEX_CITATIONS,
  OPENALEX_CONTENT,
  OPENALEX_FILTER,
  OPENALEX_GET,
  OPENALEX_GROUP,
  OPENALEX_RATE_LIMIT,
  OPENALEX_REFERENCES,
  OPENALEX_SEARCH,
  OPENALEX_SEMANTIC_SEARCH,
  ORCH_FLEET_CLAIM,
  ORCH_FLEET_ENQUEUE,
  ORCH_FLEET_RELEASE,
  ORCH_FLEET_STATUS,
  ORCH_FLEET_WORKER_HEARTBEAT,
  ORCH_FLEET_WORKER_POLL,
  ORCH_POLICY_QUERY,
  ORCH_RUN_APPROVALS_LIST,
  ORCH_RUN_APPROVE,
  ORCH_RUN_CREATE,
  ORCH_RUN_EXECUTE_AGENT,
  ORCH_RUN_EXPORT,
  ORCH_RUN_LIST,
  ORCH_RUN_PAUSE,
  ORCH_RUN_REJECT,
  ORCH_RUN_RESUME,
  ORCH_RUN_STATUS,
  PDG_BATCH,
  PDG_FIND_PARTICLE,
  PDG_FIND_REFERENCE,
  PDG_GET,
  PDG_GET_DECAYS,
  PDG_GET_MEASUREMENTS,
  PDG_GET_PROPERTY,
  PDG_GET_REFERENCE,
  PDG_INFO,
  ZOTERO_ADD,
  ZOTERO_CONFIRM,
  ZOTERO_EXPORT_ITEMS,
  ZOTERO_FIND_ITEMS,
  ZOTERO_GET_SELECTED_COLLECTION,
  ZOTERO_LOCAL,
  ZOTERO_SEARCH_ITEMS,
} from '@autoresearch/shared';
