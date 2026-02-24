/**
 * Phase 10 Writing Module Types (V2.3)
 *
 * Core type definitions for deep research report generation.
 * Implements Evidence Union and SSOT (Single Source of Truth) patterns.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Evidence Union Types (Layer 2)
// ─────────────────────────────────────────────────────────────────────────────

/** Evidence ID generation rule: stableHash(paper_id + kind + label/number/locator) */
export type EvidenceId = string;

/** Snippet locator for precise source tracking */
export interface SnippetLocator {
  latex_file?: string;
  section?: string;
  paragraph?: number;
  sentence?: number;
  latex_line?: number;
  pdf_page?: number;
  context_before?: string;
  context_after?: string;
  environment?: string;
  label?: string;
}

/** Base evidence interface */
interface BaseEvidence {
  evidence_id: EvidenceId;
  paper_id: string;
  fingerprint: string;
  locator: SnippetLocator;
  stance: 'support' | 'refute' | 'neutral';
  confidence: 'high' | 'medium' | 'low';
}

/** Text evidence (quotes from paper body) */
export interface TextEvidence extends BaseEvidence {
  kind: 'text';
  source: 'latex' | 'pdf' | 'abstract';
  quote: string;
  normalized_text?: string;
  internal_citations?: string[];
  span?: { char_start: number; char_end: number };
  extraction_method: 'regex' | 'heuristic' | 'ast';
}

/** Formula evidence (equations) */
export interface FormulaEvidence extends BaseEvidence {
  kind: 'formula';
  latex: string;
  label?: string;
  number?: string;
  description?: string;
  importance: 'high' | 'medium' | 'low';
  /** Discussion contexts from paper body */
  discussion_contexts?: string[];
}

/** Figure evidence */
export interface FigureEvidence extends BaseEvidence {
  kind: 'figure';
  caption: string;
  graphics_paths: string[];
  label?: string;
  number?: string;
  discussion_contexts: string[];
  importance: 'high' | 'medium' | 'low';
}

/** Table evidence */
export interface TableEvidence extends BaseEvidence {
  kind: 'table';
  caption: string;
  content_summary?: string;
  label?: string;
  number?: string;
  /** Discussion contexts from paper body */
  discussion_contexts?: string[];
}

/** Evidence Union type */
export type Evidence =
  | TextEvidence
  | FormulaEvidence
  | FigureEvidence
  | TableEvidence;

// ─────────────────────────────────────────────────────────────────────────────
// Claim Types
// ─────────────────────────────────────────────────────────────────────────────

export type ClaimStatus = 'consensus' | 'disputed' | 'emerging';
export type ClaimCategory =
  | 'theoretical_prediction'
  | 'experimental_result'
  | 'methodology'
  | 'interpretation'
  | 'summary';  // Full abstract as fallback claim

export type EvidenceLevel =
  | 'discovery'
  | 'evidence'
  | 'hint'
  | 'indirect'
  | 'theoretical';

export interface Claim {
  claim_id: string;
  claim_no: string;
  claim_text: string;
  category: ClaimCategory;
  status: ClaimStatus;
  paper_ids: string[];
  supporting_evidence: Evidence[];
  refuting_evidence?: Evidence[];
  assumptions: string[];
  scope: string;
  evidence_grade: EvidenceLevel;
  keywords: string[];
  is_extractive: boolean;
  needs_review?: boolean;
  /** Source context for anti-hallucination */
  source_context?: {
    before: string;
    after: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Claims Table Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CorpusSnapshot {
  paper_count: number;
  recids: string[];
  date_range: { start: number; end: number };
  snapshot_date: string;
}

export interface NotationEntry {
  symbol: string;
  meaning: string;
  paper_ids: string[];
}

export interface GlossaryEntry {
  term: string;
  definition: string;
  paper_ids: string[];
}

export interface Comparison {
  aspect: string;
  approaches: Array<{
    name: string;
    paper_ids: string[];
    description: string;
  }>;
}

export interface SignificanceAnalysis {
  result: string;
  sigma_level?: number;
  paper_id: string;
  interpretation: string;
}

export interface OpenQuestion {
  question: string;
  related_claims: string[];
  proposed_approaches?: string[];
}

export interface DisagreementEdge {
  claim_id_a: string;
  claim_id_b: string;
  tension_type: 'hard' | 'soft' | 'apparent';
  tension_sigma?: number;
  description: string;
}

export interface DisagreementGraph {
  edges: DisagreementEdge[];
  clusters: Array<{
    cluster_id: string;
    claim_ids: string[];
    consensus_level: 'high' | 'medium' | 'low';
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Original Section Types (for adaptive outline generation)
// ─────────────────────────────────────────────────────────────────────────────

export interface OriginalSection {
  /** Section level (1=section, 2=subsection, 3=subsubsection) */
  level: number;
  /** Section title */
  title: string;
  /** Section number from paper (e.g., "2.1") */
  number?: string;
  /** Paper ID this section belongs to */
  paper_id: string;
  /** Visual asset IDs in this section */
  formula_ids: string[];
  figure_ids: string[];
  table_ids: string[];
  /** Child sections */
  children: OriginalSection[];
}

export interface EnhancedClaimsTable {
  id: string;
  corpus_snapshot: CorpusSnapshot;
  claims: Claim[];
  visual_assets: {
    formulas: FormulaEvidence[];
    figures: FigureEvidence[];
    tables: TableEvidence[];
  };
  /** Original paper section structure (for adaptive outline) */
  original_sections?: OriginalSection[];
  disagreement_graph: DisagreementGraph;
  notation_table: NotationEntry[];
  glossary: GlossaryEntry[];
  analysis_dimensions: {
    methodological_comparisons: Comparison[];
    result_significance: SignificanceAnalysis[];
    open_questions: OpenQuestion[];
  };
  metadata: {
    created_at: string;
    processing_time_ms: number;
    source_paper_count: number;
    version: '2.0';
  };
  statistics: {
    total_claims: number;
    claims_by_category: Record<ClaimCategory, number>;
    claims_by_status: Record<ClaimStatus, number>;
    total_formulas: number;
    total_figures: number;
    total_tables: number;
    coverage_ratio: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section Output Types (V2.3)
// ─────────────────────────────────────────────────────────────────────────────

export type SentenceType =
  | 'fact'
  | 'definition'
  | 'comparison'
  | 'interpretation'
  | 'transition'
  | 'limitation'
  | 'future_work';

export interface SentenceAttribution {
  sentence: string;
  sentence_index: number;
  claim_ids: string[];
  evidence_ids: string[];
  evidence_fingerprints?: string[];
  citations: string[];
  type: SentenceType;
  is_grounded: boolean;
  sentence_latex?: string;
}

export interface FigureUsage {
  figure_id: string;
  paper_id: string;
  reference_context: string;
  discussion: string;
  latex_ref: string;
}

export interface EquationUsage {
  equation_id: string;
  paper_id: string;
  explanation: string;
  significance: string;
  latex_ref: string;
}

export interface TableUsage {
  table_id: string;
  paper_id: string;
  reference_context: string;
  latex_ref: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Originality Report Types (V2.3)
// ─────────────────────────────────────────────────────────────────────────────

export type OriginalityLevel = 'critical' | 'warning' | 'acceptable';

export const ORIGINALITY_THRESHOLDS = {
  CRITICAL: 0.80,
  WARNING: 0.35,
  ACCEPTABLE: 0.35,
} as const;

export interface SourceChunk {
  paper_id: string;
  evidence_id?: string;
  kind: 'text' | 'caption' | 'discussion_context';
  text: string;
  normalized_text?: string;
}

export interface FlaggedSentence {
  sentence_index: number;
  sentence: string;
  overlap_ratio: number;
  matched_source: SourceChunk;
  level: OriginalityLevel;
  reason: 'too_similar' | 'verbatim_copy' | 'missing_citation';
  suggestion: string;
}

export interface OriginalityReport {
  max_overlap_ratio: number;
  avg_overlap_ratio: number;
  level: OriginalityLevel;
  is_acceptable: boolean;
  needs_review: boolean;
  has_verbatim_copy: boolean;
  flagged_sentences: FlaggedSentence[];
  statistics: {
    total_sentences: number;
    checked_sentences: number;
    grounded_sentences: number;
    synthesized_sentences: number;
    flagged_count: number;
    critical_count: number;
    warning_count: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Quality Check Types (V2.3)
// ─────────────────────────────────────────────────────────────────────────────

export interface RequiredElement {
  type: 'definition' | 'derivation' | 'comparison' | 'limitation' | 'mini_summary';
  required: boolean;
  found: boolean;
  location?: string;
}

export interface FigureDiscussionCheck {
  figure_id: string;
  is_referenced: boolean;
  discussion_sentences: number;
  min_required: number;
  pass: boolean;
}

export interface EquationDiscussionCheck {
  equation_id: string;
  is_referenced: boolean;
  has_explanation: boolean;
  has_significance: boolean;
  discussion_sentences: number;
  min_required: number;
  pass: boolean;
}

export interface AssetCoverageCheck {
  assigned_figures: string[];
  discussed_figures: string[];
  figures_coverage_pass: boolean;
  assigned_equations: string[];
  discussed_equations: string[];
  equations_coverage_pass: boolean;
  figure_discussions: FigureDiscussionCheck[];
  equation_discussions: EquationDiscussionCheck[];
  overall_pass: boolean;
}

export interface DepthConstraints {
  min_paragraphs: number;
  actual_paragraphs: number;
  paragraphs_pass: boolean;
  min_sentences_per_paragraph: number;
  actual_min_sentences: number;
  sentences_pass: boolean;
  required_elements: RequiredElement[];
  elements_coverage: number;
  elements_pass: boolean;
  min_figures: number;
  actual_figures: number;
  min_equations: number;
  actual_equations: number;
  visual_pass: boolean;
  asset_coverage: AssetCoverageCheck;
}

export interface FormatChecks {
  bullet_list_detected: boolean;
  numbered_list_detected: boolean;
  single_sentence_paragraphs: number;
  pass: boolean;
}

export interface MultiPaperStats {
  paragraphs_total: number;
  paragraphs_multi_paper: number;
  min_required_multi_paper: number;
  pass: boolean;
  fail_examples?: Array<{
    paragraph_index: number;
    distinct_recids: number;
    cited_recids: string[];
  }>;
}

export interface QualityCheck {
  all_claims_supported: boolean;
  unsupported_statements: string[];
  depth_constraints: DepthConstraints;
  format_checks: FormatChecks;
  multi_paper_stats: MultiPaperStats;
  tone_score: number;
  structure_score: number;
  overall_pass: boolean;
  blocking_issues: string[];
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Section Output Types
// ─────────────────────────────────────────────────────────────────────────────

export type SectionType = 'introduction' | 'body' | 'summary';

export interface SectionOutput {
  section_number: string;
  title: string;
  content: string;
  attributions: SentenceAttribution[];
  figures_used: FigureUsage[];
  equations_used: EquationUsage[];
  tables_used: TableUsage[];
  originality_report: OriginalityReport;
  quality_check: QualityCheck;
  metadata: {
    word_count: number;
    paragraph_count: number;
    sentence_count: number;
    citation_count: number;
    processing_time_ms: number;
    llm_mode_effective?: LLMCallMode;
    llm_provider_effective?: string;
    llm_model_effective?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM Mode Types (V2.3)
// ─────────────────────────────────────────────────────────────────────────────

export type LLMCallMode = 'passthrough' | 'client' | 'internal';

export type LLMProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'kimi'
  | 'glm'
  | 'qwen'
  | 'openai-compatible';

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface WritingModeConfig {
  mode: LLMCallMode;
  llmConfig?: LLMConfig;
  timeout?: number;
  maxRetries?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing Packet Types (V2.3)
// ─────────────────────────────────────────────────────────────────────────────

export interface DepthConfig {
  min_paragraphs: number;
  min_sentences_per_paragraph: number;
  required_elements: string[];
  min_figures: number;
  min_equations: number;
  min_tables?: number;
  citation_density: number;
  /** Min analytical sentences (suggests, indicates, demonstrates) */
  min_analysis_sentences?: number;
  /** Min comparison sentences (however, in contrast, compared to) */
  min_comparison_sentences?: number;
  /** Min words for figure discussion */
  min_figure_discussion_words?: number;
  /** Min words for equation explanation */
  min_equation_explanation_words?: number;
  /** Min words for table discussion */
  min_table_discussion_words?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Soft Depth Config Types (Phase 1 - Writing Quality Fix)
// ─────────────────────────────────────────────────────────────────────────────

/** Range for suggested values (soft constraints) */
export interface SuggestedRange {
  min: number;
  max: number;
}

/**
 * Soft depth configuration - uses suggestions instead of hard requirements.
 * LLM has more freedom to organize content naturally.
 */
export interface SoftDepthConfig {
  /** Suggested paragraph count range */
  suggested_paragraphs: SuggestedRange;
  /** Suggested sentences per paragraph range */
  suggested_sentences_per_paragraph: SuggestedRange;
  /** Optional elements (not required, but encouraged) */
  optional_elements: string[];
  /** Suggested figure count (0 = use as needed) */
  suggested_figures: number;
  /** Suggested equation count (0 = use as needed) */
  suggested_equations: number;
  /** Suggested table count (0 = use as needed) */
  suggested_tables: number;
  /** Target citation density (goal, not minimum) */
  target_citation_density: number;
}

/**
 * Type guard to check if constraints is a SoftDepthConfig.
 */
export function isSoftDepthConfig(config: DepthConfig | SoftDepthConfig): config is SoftDepthConfig {
  return 'suggested_paragraphs' in config;
}

/**
 * Type guard to check if constraints is a DepthConfig (hard constraints).
 */
export function isDepthConfig(config: DepthConfig | SoftDepthConfig): config is DepthConfig {
  return 'min_paragraphs' in config;
}

export interface WritingInstructions {
  core: string[];
  prohibitions: string[];
  requirements: string[];
}

export interface WritingPacket {
  section: {
    number: string;
    title: string;
    type: SectionType;
  };
  assigned_claims: Claim[];
  assigned_assets: {
    figures: FigureEvidence[];
    equations: FormulaEvidence[];
    tables: TableEvidence[];
  };
  /** Phase 0-derived word budget (per section) */
  word_budget?: {
    min_words: number;
    max_words: number;
  };
  /** Global context for cross-referencing (optional; best-effort in one-off write_section flows) */
  global_context?: {
    paper_title: string;
    paper_topic: string;
    toc: Array<{
      section_number: string;
      title: string;
      type: SectionType;
      key_claims: string[];
      key_assets: string[];
    }>;
    cross_ref_hints: {
      this_section_defines: string[];
      this_section_may_reference: string[];
      later_sections_will_use: string[];
    };
  };
  allowed_citations: string[];
  constraints: DepthConfig | SoftDepthConfig;
  instructions: WritingInstructions;
  context: {
    /** Topic for anti-hallucination (stay on topic) */
    topic?: string;
    /** Title for anti-hallucination */
    title?: string;
    /** Preferred output language (optional) */
    language?: 'en' | 'zh';
    previous_sections?: string[];
    notation_used?: string[];
    glossary: GlossaryEntry[];
  };
  budget?: {
    max_claims_per_section: number;
    max_evidence_per_claim: number;
    max_discussion_context_chars: number;
  };
}
