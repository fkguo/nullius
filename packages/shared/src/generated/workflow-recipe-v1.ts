/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
export interface WorkflowRecipeV1 {
  recipe_id: string;
  name: string;
  description: string;
  entry_tool: string;
  /**
   * @minItems 1
   */
  steps: [
    (
      | {
          id: string;
          tool: string;
          action?:
            | "discover.seed_search"
            | "analyze.topic_evolution"
            | "analyze.citation_network"
            | "analyze.paper_connections"
            | "analyze.provenance_trace"
            | "analyze.paper_set_critical_review"
            | "materialize.evidence_build";
          purpose: string;
          depends_on?: string[];
          required_capabilities?: (
            | "supports_keyword_search"
            | "supports_semantic_search"
            | "supports_citation_graph"
            | "supports_fulltext"
            | "supports_source_download"
            | "supports_open_access_content"
            | "analysis.topic_evolution"
            | "analysis.citation_network"
            | "analysis.paper_set_connections"
            | "analysis.provenance_trace"
            | "analysis.paper_set_critical_review"
          )[];
          preferred_providers?: (
            | "inspire"
            | "openalex"
            | "arxiv"
            | "zotero"
            | "crossref"
            | "datacite"
            | "github"
            | "doi"
          )[];
          degrade_mode?: "fail_closed" | "skip_with_reason" | "partial_result";
          consumer_hints?: {
            phases?: string[];
            artifact?: string;
            project_required?: boolean;
            run_required?: boolean;
            search_depth_contract?: {
              mode: "deep";
              default_page_size: 50;
              default_page_size_semantics: "page_size_not_completion_threshold";
              pagination_required: true;
              cursor_or_page_tracking_required: true;
              continuation_required: true;
              returned_count_required: true;
              stop_reason_required: true;
              coverage_incomplete_status: "coverage_incomplete";
              candidate_pool_artifact: string;
              selection_rationale_required: true;
              query_expansion_expected: true;
              citation_expansion_expected: true;
            };
            literature_saturation_contract?: {
              artifact: string;
              /**
               * @minItems 2
               * @maxItems 2
               */
              final_status_values: [
                "saturated" | "coverage_incomplete",
                "saturated" | "coverage_incomplete",
              ];
              saturated_required_for_completion: true;
              coverage_incomplete_allowed_only_as_debt: true;
              provider_coverage_required: true;
              /**
               * @minItems 4
               */
              providers_expected: [
                "inspire" | "arxiv" | "openalex" | "web",
                "inspire" | "arxiv" | "openalex" | "web",
                "inspire" | "arxiv" | "openalex" | "web",
                "inspire" | "arxiv" | "openalex" | "web",
                ...("inspire" | "arxiv" | "openalex" | "web")[],
              ];
              candidate_pool_required: true;
              core_paper_references_required: true;
              core_paper_citations_required: true;
              metadata_only_not_evidence_ready: true;
              page_size_not_completion_threshold: true;
            };
            reading_handoff_contract?: {
              mode: "source_first";
              /**
               * @minItems 4
               */
              source_preference: [
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                ...(
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                )[],
              ];
              note_upgrade_required: true;
              expected_artifact: string;
              locators_required: true;
              key_equations_required: true;
              limitations_required: true;
            };
          };
          params?: {
            [k: string]: unknown;
          };
        }
      | {
          id: string;
          tool?: string;
          action:
            | "discover.seed_search"
            | "analyze.topic_evolution"
            | "analyze.citation_network"
            | "analyze.paper_connections"
            | "analyze.provenance_trace"
            | "analyze.paper_set_critical_review"
            | "materialize.evidence_build";
          purpose: string;
          depends_on?: string[];
          required_capabilities?: (
            | "supports_keyword_search"
            | "supports_semantic_search"
            | "supports_citation_graph"
            | "supports_fulltext"
            | "supports_source_download"
            | "supports_open_access_content"
            | "analysis.topic_evolution"
            | "analysis.citation_network"
            | "analysis.paper_set_connections"
            | "analysis.provenance_trace"
            | "analysis.paper_set_critical_review"
          )[];
          preferred_providers?: (
            | "inspire"
            | "openalex"
            | "arxiv"
            | "zotero"
            | "crossref"
            | "datacite"
            | "github"
            | "doi"
          )[];
          degrade_mode?: "fail_closed" | "skip_with_reason" | "partial_result";
          consumer_hints?: {
            phases?: string[];
            artifact?: string;
            project_required?: boolean;
            run_required?: boolean;
            search_depth_contract?: {
              mode: "deep";
              default_page_size: 50;
              default_page_size_semantics: "page_size_not_completion_threshold";
              pagination_required: true;
              cursor_or_page_tracking_required: true;
              continuation_required: true;
              returned_count_required: true;
              stop_reason_required: true;
              coverage_incomplete_status: "coverage_incomplete";
              candidate_pool_artifact: string;
              selection_rationale_required: true;
              query_expansion_expected: true;
              citation_expansion_expected: true;
            };
            literature_saturation_contract?: {
              artifact: string;
              /**
               * @minItems 2
               * @maxItems 2
               */
              final_status_values: [
                "saturated" | "coverage_incomplete",
                "saturated" | "coverage_incomplete",
              ];
              saturated_required_for_completion: true;
              coverage_incomplete_allowed_only_as_debt: true;
              provider_coverage_required: true;
              /**
               * @minItems 4
               */
              providers_expected: [
                "inspire" | "arxiv" | "openalex" | "web",
                "inspire" | "arxiv" | "openalex" | "web",
                "inspire" | "arxiv" | "openalex" | "web",
                "inspire" | "arxiv" | "openalex" | "web",
                ...("inspire" | "arxiv" | "openalex" | "web")[],
              ];
              candidate_pool_required: true;
              core_paper_references_required: true;
              core_paper_citations_required: true;
              metadata_only_not_evidence_ready: true;
              page_size_not_completion_threshold: true;
            };
            reading_handoff_contract?: {
              mode: "source_first";
              /**
               * @minItems 4
               */
              source_preference: [
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                ...(
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                )[],
              ];
              note_upgrade_required: true;
              expected_artifact: string;
              locators_required: true;
              key_equations_required: true;
              limitations_required: true;
            };
          };
          params?: {
            [k: string]: unknown;
          };
        }
    ),
    ...(
      | {
          id: string;
          tool: string;
          action?:
            | "discover.seed_search"
            | "analyze.topic_evolution"
            | "analyze.citation_network"
            | "analyze.paper_connections"
            | "analyze.provenance_trace"
            | "analyze.paper_set_critical_review"
            | "materialize.evidence_build";
          purpose: string;
          depends_on?: string[];
          required_capabilities?: (
            | "supports_keyword_search"
            | "supports_semantic_search"
            | "supports_citation_graph"
            | "supports_fulltext"
            | "supports_source_download"
            | "supports_open_access_content"
            | "analysis.topic_evolution"
            | "analysis.citation_network"
            | "analysis.paper_set_connections"
            | "analysis.provenance_trace"
            | "analysis.paper_set_critical_review"
          )[];
          preferred_providers?: (
            | "inspire"
            | "openalex"
            | "arxiv"
            | "zotero"
            | "crossref"
            | "datacite"
            | "github"
            | "doi"
          )[];
          degrade_mode?: "fail_closed" | "skip_with_reason" | "partial_result";
          consumer_hints?: {
            phases?: string[];
            artifact?: string;
            project_required?: boolean;
            run_required?: boolean;
            search_depth_contract?: {
              mode: "deep";
              default_page_size: 50;
              default_page_size_semantics: "page_size_not_completion_threshold";
              pagination_required: true;
              cursor_or_page_tracking_required: true;
              continuation_required: true;
              returned_count_required: true;
              stop_reason_required: true;
              coverage_incomplete_status: "coverage_incomplete";
              candidate_pool_artifact: string;
              selection_rationale_required: true;
              query_expansion_expected: true;
              citation_expansion_expected: true;
            };
            literature_saturation_contract?: {
              artifact: string;
              /**
               * @minItems 2
               * @maxItems 2
               */
              final_status_values: [
                "saturated" | "coverage_incomplete",
                "saturated" | "coverage_incomplete",
              ];
              saturated_required_for_completion: true;
              coverage_incomplete_allowed_only_as_debt: true;
              provider_coverage_required: true;
              /**
               * @minItems 4
               */
              providers_expected: [
                "inspire" | "arxiv" | "openalex" | "web",
                "inspire" | "arxiv" | "openalex" | "web",
                "inspire" | "arxiv" | "openalex" | "web",
                "inspire" | "arxiv" | "openalex" | "web",
                ...("inspire" | "arxiv" | "openalex" | "web")[],
              ];
              candidate_pool_required: true;
              core_paper_references_required: true;
              core_paper_citations_required: true;
              metadata_only_not_evidence_ready: true;
              page_size_not_completion_threshold: true;
            };
            reading_handoff_contract?: {
              mode: "source_first";
              /**
               * @minItems 4
               */
              source_preference: [
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                ...(
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                )[],
              ];
              note_upgrade_required: true;
              expected_artifact: string;
              locators_required: true;
              key_equations_required: true;
              limitations_required: true;
            };
          };
          params?: {
            [k: string]: unknown;
          };
        }
      | {
          id: string;
          tool?: string;
          action:
            | "discover.seed_search"
            | "analyze.topic_evolution"
            | "analyze.citation_network"
            | "analyze.paper_connections"
            | "analyze.provenance_trace"
            | "analyze.paper_set_critical_review"
            | "materialize.evidence_build";
          purpose: string;
          depends_on?: string[];
          required_capabilities?: (
            | "supports_keyword_search"
            | "supports_semantic_search"
            | "supports_citation_graph"
            | "supports_fulltext"
            | "supports_source_download"
            | "supports_open_access_content"
            | "analysis.topic_evolution"
            | "analysis.citation_network"
            | "analysis.paper_set_connections"
            | "analysis.provenance_trace"
            | "analysis.paper_set_critical_review"
          )[];
          preferred_providers?: (
            | "inspire"
            | "openalex"
            | "arxiv"
            | "zotero"
            | "crossref"
            | "datacite"
            | "github"
            | "doi"
          )[];
          degrade_mode?: "fail_closed" | "skip_with_reason" | "partial_result";
          consumer_hints?: {
            phases?: string[];
            artifact?: string;
            project_required?: boolean;
            run_required?: boolean;
            search_depth_contract?: {
              mode: "deep";
              default_page_size: 50;
              default_page_size_semantics: "page_size_not_completion_threshold";
              pagination_required: true;
              cursor_or_page_tracking_required: true;
              continuation_required: true;
              returned_count_required: true;
              stop_reason_required: true;
              coverage_incomplete_status: "coverage_incomplete";
              candidate_pool_artifact: string;
              selection_rationale_required: true;
              query_expansion_expected: true;
              citation_expansion_expected: true;
            };
            literature_saturation_contract?: {
              artifact: string;
              /**
               * @minItems 2
               * @maxItems 2
               */
              final_status_values: [
                "saturated" | "coverage_incomplete",
                "saturated" | "coverage_incomplete",
              ];
              saturated_required_for_completion: true;
              coverage_incomplete_allowed_only_as_debt: true;
              provider_coverage_required: true;
              /**
               * @minItems 4
               */
              providers_expected: [
                "inspire" | "arxiv" | "openalex" | "web",
                "inspire" | "arxiv" | "openalex" | "web",
                "inspire" | "arxiv" | "openalex" | "web",
                "inspire" | "arxiv" | "openalex" | "web",
                ...("inspire" | "arxiv" | "openalex" | "web")[],
              ];
              candidate_pool_required: true;
              core_paper_references_required: true;
              core_paper_citations_required: true;
              metadata_only_not_evidence_ready: true;
              page_size_not_completion_threshold: true;
            };
            reading_handoff_contract?: {
              mode: "source_first";
              /**
               * @minItems 4
               */
              source_preference: [
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                (
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                ),
                ...(
                  | "arxiv_latex_source"
                  | "full_text_pdf"
                  | "available_full_text"
                  | "metadata_only_not_evidence_ready"
                )[],
              ];
              note_upgrade_required: true;
              expected_artifact: string;
              locators_required: true;
              key_equations_required: true;
              limitations_required: true;
            };
          };
          params?: {
            [k: string]: unknown;
          };
        }
    )[],
  ];
}
