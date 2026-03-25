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
          };
          params?: {
            [k: string]: unknown;
          };
        }
    )[],
  ];
}
