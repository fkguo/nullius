/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "AnalysisType".
 */
export type AnalysisType =
  | "overview"
  | "timeline"
  | "authors"
  | "topics"
  | "all";
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "RelatedStrategy".
 */
export type RelatedStrategy =
  | "high_cited_refs"
  | "common_refs"
  | "citing_overlap"
  | "co_citation"
  | "all";
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "ExpansionDirection".
 */
export type ExpansionDirection = "forward" | "backward" | "lateral" | "all";
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "SurveyGoal".
 */
export type SurveyGoal =
  | "comprehensive_review"
  | "quick_overview"
  | "find_methods"
  | "historical_context";
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "SurveyPrioritize".
 */
export type SurveyPrioritize = "citations" | "recency" | "relevance";
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "SurveyPriority".
 */
export type SurveyPriority = "essential" | "recommended" | "optional";
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "TopicTrend".
 */
export type TopicTrend = "growing" | "stable" | "declining";
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "ImportStatus".
 */
export type ImportStatus = "imported" | "skipped" | "failed";

/**
 * Consolidated analysis parameter and result types for HEP research tools. Replaces 7 versioned analysis-params/results files.
 */
export interface AnalysisTypesV1 {}
/**
 * Paper metadata returned in analysis results, with the same fields as the shared PaperSummary schema.
 *
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "PaperSummaryRef".
 */
export interface PaperSummaryRef {
  recid?: string;
  arxiv_id?: string;
  doi?: string;
  openalex_id?: string;
  zotero_key?: string;
  texkey?: string;
  title: string;
  authors: string[];
  author_count?: number;
  collaborations?: string[];
  year?: number;
  earliest_date?: string;
  citation_count?: number;
  citation_count_without_self_citations?: number;
  publication_summary?: string;
  inspire_url?: string;
  arxiv_url?: string;
  doi_url?: string;
  pdf_url?: string;
  source_url?: string;
  publication_type?: string[];
  document_type?: string[];
  arxiv_primary_category?: string;
  arxiv_categories?: string[];
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "AnalyzePapersParams".
 */
export interface AnalyzePapersParams {
  /**
   * @minItems 1
   */
  recids: [string, ...string[]];
  analysis_type?: AnalysisType[];
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "AnalyzeCollectionParams".
 */
export interface AnalyzeCollectionParams {
  collectionKey: string;
  group_id?: number;
  analysis_type?: AnalysisType[];
  max_items?: number;
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "FindConnectionsParams".
 */
export interface FindConnectionsParams {
  /**
   * @minItems 1
   */
  recids: [string, ...string[]];
  include_external?: boolean;
  max_external_depth?: number;
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "FindRelatedParams".
 */
export interface FindRelatedParams {
  /**
   * @minItems 1
   */
  recids: [string, ...string[]];
  strategy: RelatedStrategy;
  limit?: number;
  min_relevance?: number;
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "ResearchExpansionParams".
 */
export interface ResearchExpansionParams {
  /**
   * @minItems 1
   */
  seed_recids: [string, ...string[]];
  direction: ExpansionDirection;
  depth?: number;
  max_results?: number;
  filters?: {
    min_citations?: number;
    year_range?: {
      start?: number;
      end?: number;
    };
    exclude_in_library?: boolean;
  };
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "GenerateSurveyParams".
 */
export interface GenerateSurveyParams {
  /**
   * @minItems 1
   */
  seed_recids: [string, ...string[]];
  goal: SurveyGoal;
  max_papers?: number;
  prioritize?: "citations" | "recency" | "relevance";
  include_reviews?: boolean;
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "TopicEvolutionParams".
 */
export interface TopicEvolutionParams {
  topic: string;
  start_year?: number;
  end_year?: number;
  granularity?: "year" | "5year" | "decade";
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "BatchImportParams".
 */
export interface BatchImportParams {
  /**
   * @minItems 1
   */
  recids: [string, ...string[]];
  target_collection?: string;
  group_id?: number;
  auto_create_collection?: string;
  download_pdf?: boolean;
  add_tag?: string;
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "CollectionAnalysis".
 */
export interface CollectionAnalysis {
  item_count: number;
  date_range: {
    earliest: string;
    latest: string;
  };
  overview?: {
    total_citations: number;
    avg_citations: number;
    top_cited: PaperSummaryRef[];
    collaborations: {
      name: string;
      count: number;
    }[];
    arxiv_categories: {
      category: string;
      count: number;
    }[];
  };
  timeline?: {
    year: number;
    count: number;
    key_papers: string[];
  }[];
  authors?: {
    name: string;
    paper_count: number;
    total_citations: number;
    bai?: string;
  }[];
  topics?: {
    keywords: string[];
    paper_count: number;
    representative_papers: string[];
  }[];
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "ConnectionsResult".
 */
export interface ConnectionsResult {
  internal_edges: {
    source: string;
    target: string;
  }[];
  bridge_papers: {
    recid: string;
    title: string;
    connections: number;
  }[];
  isolated_papers: string[];
  external_hubs?: PaperSummaryRef[];
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "RelatedPapers".
 */
export interface RelatedPapers {
  papers: {
    recid: string;
    title: string;
    authors: string[];
    year?: number;
    citation_count?: number;
    relevance_score: number;
    relevance_reason: string;
    connection_count: number;
  }[];
  total_candidates: number;
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "ExpansionResult".
 */
export interface ExpansionResult {
  direction: string;
  papers: {
    recid: string;
    title: string;
    authors: string[];
    year?: number;
    citation_count?: number;
    connection_strength: number;
    connection_path: string[];
    already_in_library: boolean;
  }[];
  emerging_topics?: PaperSummaryRef[];
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "SurveyResult".
 */
export interface SurveyResult {
  goal: string;
  sections: {
    name: string;
    description: string;
    papers: {
      recid: string;
      title: string;
      authors: string[];
      year?: number;
      citation_count?: number;
      why_include: string;
      priority: SurveyPriority;
      is_review: boolean;
    }[];
  }[];
  suggested_reading_order: string[];
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "TopicMetadataQuery".
 */
export interface TopicMetadataQuery {
  status: "available" | "unavailable";
  query: string;
  requested_page_size: number;
  sort?: string;
  returned_count: number | null;
  sample_complete: boolean | null;
  has_more: boolean | null;
  next_url?: string;
  warning?: string;
  error?: string;
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "TopicEvolution".
 */
export interface TopicEvolution {
  topic: string;
  time_range: {
    start: number;
    end: number;
  };
  time_range_basis: "requested_start" | "default_20_year_lookback";
  phases: {
    period: string;
    time_range: {
      start: number;
      end: number;
    };
    paper_count: number | null;
    publication_count_change: {
      previous_period: string;
      previous_paper_count: number;
      fraction: number;
    } | null;
    key_papers: PaperSummaryRef[];
    key_authors: string[];
    search: TopicMetadataQuery;
  }[];
  current_status: {
    recent_papers: number | null;
    time_range: {
      start: number;
      end: number;
    };
    search: TopicMetadataQuery;
  };
  sample_basis: {
    papers: "single_mostcited_page_per_period";
    key_papers_limit: 5;
    key_authors: "occurrences_among_first_three_authors_of_sampled_papers";
  };
  coverage: {
    period_queries: "complete" | "partial";
    paper_samples: "complete" | "partial";
  };
}
/**
 * This interface was referenced by `AnalysisTypesV1`'s JSON-Schema
 * via the `definition` "BatchImportResult".
 */
export interface BatchImportResult {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  details: {
    recid: string;
    status: ImportStatus;
    zotero_key?: string;
    error?: string;
  }[];
  collection_key?: string;
}
