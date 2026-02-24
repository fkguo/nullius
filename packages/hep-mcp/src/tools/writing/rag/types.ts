/**
 * Phase 12: LaTeX-Native RAG Core Types
 *
 * Defines the fundamental data structures for the RAG system:
 * - EvidenceChunk: Minimal citable unit
 * - ChunkIndex: BM25 index
 * - EvidencePacket: LLM input bundle
 * - Attribution: Sentence-level source tracking
 *
 * @module rag/types
 */

import type { Locator as _Locator } from '../../research/latex/locator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Chunk Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chunk types (including context types)
 */
export type ChunkType =
  | 'paragraph'
  | 'equation'
  | 'equation_context'
  | 'table'
  | 'table_context'
  | 'figure'
  | 'figure_context'
  | 'definition'
  | 'bibliography_entry'
  | 'citation_context';

/**
 * Chunk locator - precise source position
 */
export interface ChunkLocator {
  /** INSPIRE record ID */
  paper_id: string;
  /** Source tex file path */
  file_path: string;
  /** Section hierarchy path */
  section_path: string[];
  /** Label (if any) */
  label?: string;
  /** Byte offset start (more stable than line) */
  byte_start?: number;
  /** Byte offset end */
  byte_end?: number;
  /** Line number start */
  line_start: number;
  /** Line number end */
  line_end: number;
}

/**
 * Evidence Chunk - Minimal citable unit from a paper
 */
export interface EvidenceChunk {
  /** Stable ID = hash(paper_id + file_path + node_range + type) */
  id: string;

  /** Content hash (for deduplication) */
  content_hash: string;

  /** Chunk type */
  type: ChunkType;

  /** Original LaTeX content */
  content_latex: string;

  /** Plain text version (for retrieval, preserves math symbols) */
  text: string;

  /** Semantic description (for equations/tables) */
  semantic_description?: string;

  /** Source location */
  locator: ChunkLocator;

  /** Reference relationships (for Sticky Retrieval) */
  refs: {
    /** Labels this chunk references (\ref) */
    outgoing: string[];
    /** Citekeys this chunk references (\cite) */
    outgoing_cites: string[];
    /** Labels that reference this chunk */
    incoming: string[];
  };

  /** Navigation relationships (for context expansion) */
  navigation: {
    /** Previous chunk ID */
    prev_id?: string;
    /** Next chunk ID */
    next_id?: string;
  };

  /** Metadata */
  metadata: ChunkMetadata;
}

/**
 * Chunk metadata
 */
export interface ChunkMetadata {
  /** Contains math expressions */
  has_math: boolean;
  /** Contains citations */
  has_citation: boolean;
  /** Word count */
  word_count: number;
  /** Token count estimate */
  token_estimate: number;
  /** Was content pruned (large tables) */
  is_pruned?: boolean;
  /** Environment type (equation-specific: eqnarray/align/subequations) */
  env_type?: string;
  /** Pre-extracted numbers (table-specific) */
  numbers_index?: HEPNumber[];
}

// ─────────────────────────────────────────────────────────────────────────────
// HEP Number Types (for numeric gate)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HEP number types
 */
export type HEPNumberType =
  | 'point'           // Single value: 125.09 GeV
  | 'symmetric'       // Symmetric error: 125.09 ± 0.24 GeV
  | 'asymmetric'      // Asymmetric error: 125.09^{+0.24}_{-0.21}
  | 'multi_error'     // Multiple errors: 3871.9 ± 0.7_stat ± 0.2_sys MeV
  | 'range'           // Range: -20 < E < 20 MeV
  | 'upper_limit'     // Upper limit: < 2.4 MeV (90% CL)
  | 'lower_limit'     // Lower limit: > 1.0 GeV
  | 'approximate'     // Approximate: ~100 GeV, O(1) GeV
  | 'symbolic'        // Symbolic variable: m_X, Γ_tot (skip verification)
  | 'chi_squared'     // χ²/ndf = 0.49/3
  | 'significance'    // 6.3σ, 5 sigma
  | 'p_value'         // p < 0.01
  | 'confidence'      // 90% CL
  | 'ratio';          // (5.2±1.9)×10^{-3}

/**
 * HEP number information
 */
export interface HEPNumber {
  /** Raw string */
  raw: string;
  /** Number type */
  type: HEPNumberType;
  /** Central value */
  value: number;
  /** Uncertainties */
  uncertainties?: {
    type: 'stat' | 'syst' | 'total' | 'unknown';
    plus: number;
    minus: number;
    label?: string;  // e.g., "_{\rm stat.}"
  }[];
  /** Range (for range type) */
  range?: {
    lower: number;
    upper: number;
    lower_inclusive: boolean;
    upper_inclusive: boolean;
  };
  /** Confidence level */
  confidence_level?: string;
  /** Unit */
  unit?: string;
  /** Context sentence */
  context: string;
  /** Is symbolic variable (skip verification) */
  is_symbolic: boolean;
  /** Scientific notation exponent */
  exponent?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Index Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chunk index for BM25 retrieval
 */
export interface ChunkIndex {
  /** All chunks */
  chunks: EvidenceChunk[];
  /** Document frequency map: term -> df */
  documentFrequency: Map<string, number>;
  /** Total documents */
  totalDocuments: number;
  /** Average document length */
  avgDocLength: number;
}

/**
 * Serialized index (for persistence)
 */
export interface SerializedIndex {
  version: string;
  created_at: string;
  paper_ids: string[];
  chunks: EvidenceChunk[];
  df: Record<string, number>;
  totalDocuments: number;
  avgDocLength: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Retrieval Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Section type for coverage requirements
 */
export type SectionType =
  | 'introduction'
  | 'methodology'
  | 'results'
  | 'discussion'
  | 'conclusion';

/**
 * Retrieve request
 */
export interface RetrieveRequest {
  /** Query text */
  query: string;
  /** Keywords (from claims/section title) */
  keywords: string[];
  /** Return count */
  top_k: number;
  /** Optional reranker config (Phase 1+: LLM / rule / cross-encoder) */
  reranker?: RerankerConfig;
  /** Type filter */
  type_filter?: ChunkType[];
  /** Section scope */
  section_scope?: {
    prefer: string[];
    exclude: string[];
  };
  /** Target section type (for type prior) */
  target_section_type?: SectionType;
}

/**
 * Retrieve result
 */
export interface RetrieveResult {
  /** Retrieved chunks */
  chunks: EvidenceChunk[];
  /** Context chunks (not scored, for background) */
  context_chunks: EvidenceChunk[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence Packet Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Claim from Claims Table
 */
export interface Claim {
  /** Claim ID */
  claim_id: string;
  /** Claim text */
  claim_text: string;
  /** Source paper IDs */
  paper_ids: string[];
  /** Supporting evidence */
  supporting_evidence: {
    chunk_id: string;
    relevance: number;
  }[];
}

/**
 * Coverage requirements (by section type)
 */
export interface CoverageRequirements {
  /** Minimum chunks by type */
  min_chunks_by_type: Partial<Record<ChunkType, number>>;
  /** Require at least one of these type combinations */
  require_at_least_one_of: ChunkType[][];
  /** Prefer sections */
  prefer_sections?: string[];
  /** Exclude sections (Section Scoping) */
  exclude_sections?: string[];
}

/**
 * Coverage presets by section type
 */
export const COVERAGE_PRESETS: Record<SectionType, CoverageRequirements> = {
  introduction: {
    min_chunks_by_type: { paragraph: 2, citation_context: 1 },
    require_at_least_one_of: [['definition', 'paragraph']],
    prefer_sections: ['introduction', 'abstract'],
    exclude_sections: ['conclusion'],
  },
  methodology: {
    min_chunks_by_type: { paragraph: 2, equation_context: 1 },
    require_at_least_one_of: [['equation', 'equation_context']],
    prefer_sections: ['method', 'methodology', 'analysis'],
  },
  results: {
    min_chunks_by_type: { paragraph: 2 },
    require_at_least_one_of: [['figure_context', 'table_context']],
    prefer_sections: ['results', 'discussion'],
  },
  discussion: {
    min_chunks_by_type: { paragraph: 3 },
    require_at_least_one_of: [['paragraph']],
    prefer_sections: ['discussion', 'results'],
  },
  conclusion: {
    min_chunks_by_type: { paragraph: 2 },
    require_at_least_one_of: [['paragraph']],
    prefer_sections: ['conclusion', 'summary'],
  },
};

/**
 * Evidence packet - Input to LLM for writing
 */
export interface EvidencePacket {
  /** Current writing task */
  task: {
    section_title: string;
    section_type: SectionType;
    assigned_claims: string[];
  };

  /** Structured claims (hard constraint) */
  claims: Claim[];

  /** Retrieved evidence chunks (soft coverage) */
  chunks: EvidenceChunk[];

  /** Context chunks (for background, not scored) */
  context_chunks: EvidenceChunk[];

  /** Allowed IDs (separate claim and chunk) */
  allowed: {
    claim_ids: string[];
    chunk_ids: string[];
  };

  /** Coverage requirements */
  coverage: CoverageRequirements;

  /** Budget control */
  budgets: {
    max_chunks: number;
    max_total_tokens: number;
    max_citations_per_sentence: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Writer Output Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sentence kind (for verification rules)
 */
export type SentenceKind = 'fact' | 'method' | 'result' | 'comparison' | 'meta';

/**
 * Writer output structure (verifiable)
 */
export interface WriterOutput {
  /** Writing plan */
  plan: {
    point: string;
    evidence_ids: string[];
  }[];

  /** Paragraphs */
  paragraphs: {
    intent: string;
    sentences: {
      text: string;
      kind: SentenceKind;
      evidence_ids: string[];
      claim_ids?: string[];
    }[];
  }[];

  /** Information gaps */
  gaps: {
    description: string;
    suggested_query: string;
  }[];

  /** Argument chain (optional) */
  argument_chain?: ArgumentChain;
}

/**
 * Argument chain structure
 */
export interface ArgumentChain {
  /** Core thesis */
  thesis: string;
  /** Reasoning steps */
  steps: {
    step_id: string;
    claim: string;
    evidence_ids: string[];
    reasoning: string;
    depends_on?: string[];
  }[];
  /** Conclusion */
  conclusion: string;
}

/**
 * Sentence attribution
 */
export interface SentenceAttribution {
  /** Generated sentence */
  sentence: string;
  /** Evidence IDs */
  evidence_ids: string[];
  /** Claim IDs */
  claim_ids: string[];
  /** Confidence level */
  confidence: 'high' | 'medium' | 'low';
  /** Verification status */
  status: 'verified' | 'partial' | 'unverified';
}

/**
 * Section output structure
 */
export interface SectionOutput {
  /** Complete section text */
  content: string;
  /** Sentence-level attributions */
  attributions: SentenceAttribution[];
  /** Metadata */
  metadata: {
    word_count: number;
    paragraph_count: number;
    citation_count: number;
    gaps: WriterOutput['gaps'];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dual Text Preprocessor Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Offset mapping for macro expansion tracking
 */
export interface OffsetMapping {
  /** Convert normTex offset to rawTex offset */
  toRaw(normOffset: number): number;
  /** Convert rawTex offset to normTex offset */
  toNorm(rawOffset: number): number;
}

/**
 * Mapping entry for offset tracking
 */
export interface MappingEntry {
  rawStart: number;
  rawEnd: number;
  normStart: number;
  normEnd: number;
}

/**
 * Macro registry
 */
export interface MacroRegistry {
  /** Simple macros: \x -> X(3872) */
  simple: Map<string, string>;
  /** Entity expansions for retrieval enhancement */
  entityExpansions: string[];
}

/**
 * Dual text preprocessing result
 */
export interface DualTextResult {
  /** Original raw tex content */
  rawTex: string;
  /** Normalized tex (macros expanded) */
  normTex: string;
  /** Offset mapping */
  offsetMap: OffsetMapping;
  /** Macro registry */
  macroRegistry: MacroRegistry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verification issue types
 */
export type VerifyIssueType =
  | 'missing_attribution'
  | 'invalid_attribution'
  | 'unverified_number'
  | 'weak_support'
  | 'context_leakage'
  | 'ngram_overlap'
  | 'max_rounds'
  | 'timeout';

/**
 * Verification issue
 */
export interface VerifyIssue {
  type: VerifyIssueType;
  sentence: string;
  details: string;
}

/**
 * Verification result
 */
export interface VerifyResult {
  pass: boolean;
  issues: VerifyIssue[];
  action: 'accept' | 'rewrite' | 'retrieve_more' | 'reject';
}

/**
 * Quality gate result
 */
export interface QualityGateResult {
  gate: string;
  pass: boolean;
  score: number;
  issues: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunker Options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context configuration
 */
export interface ContextConfig {
  /** Context mode */
  mode: 'section' | 'chunk' | 'token';
  /** Chunk mode: number of chunks before/after */
  chunk_window: number;
  /** Token mode: max context tokens */
  max_context_tokens: number;
  /** Section mode: included section types */
  include_sections?: string[];
}

/**
 * Chunker options
 */
export interface ChunkerOptions {
  /** Max paragraph length (characters) */
  max_paragraph_length: number;
  /** Include equations */
  include_equations: boolean;
  /** Include tables */
  include_tables: boolean;
  /** Include figures */
  include_figures: boolean;
  /** Table prune threshold (rows) */
  table_prune_threshold: number;
  /** Context window size */
  context_window: number;
  /** Skip frontmatter (author/affiliation lists) */
  skip_frontmatter: boolean;
  /** Context configuration */
  context_config?: ContextConfig;
  /** Max paragraph tokens (for splitting) */
  max_paragraph_tokens?: number;
}

/**
 * Default chunker options
 */
export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = {
  max_paragraph_length: 2000,
  include_equations: true,
  include_tables: true,
  include_figures: true,
  table_prune_threshold: 20,
  context_window: 2,
  skip_frontmatter: true,
  max_paragraph_tokens: 500,
};

/**
 * Default context configuration
 */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  mode: 'chunk',
  chunk_window: 2,
  max_context_tokens: 2000,
};

// ─────────────────────────────────────────────────────────────────────────────
// Reranker Types (optional enhancement)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reranker weights for HEP features
 */
export interface RerankWeights {
  numeric: number;
  constraint: number;
  entity: number;
  table: number;
  section: number;
  citation: number;
  coverage: number;
}

/**
 * Default rerank weights
 */
export const DEFAULT_RERANK_WEIGHTS: RerankWeights = {
  numeric: 2.0,
  constraint: 2.5,
  entity: 1.5,
  table: 1.8,
  section: 1.0,
  citation: 0.5,
  coverage: 1.2,
};

/**
 * Reranker configuration
 */
export interface RerankerConfig {
  mode: 'off' | 'rule' | 'llm' | 'cross_encoder' | 'hybrid';
  rule?: {
    enabled: boolean;
    weights: RerankWeights;
  };
  llm?: {
    enabled: boolean;
    llm_mode: 'client' | 'internal';
    /** BM25 top-k candidates to send to LLM */
    rerank_top_k: number;
    /** LLM output top-n indices to apply */
    output_top_n: number;
    /** Truncate each candidate chunk to this many characters */
    max_chunk_chars: number;
  };
  cross_encoder?: {
    enabled: boolean;
    model_path: string;
    rerank_top_k: number;
    fusion_weight: number;
  };
}

/**
 * Default reranker configuration
 *
 * Quality-first principle: Increased from rerank_top_k=50/output_top_n=15 to 100/25
 * to ensure better retrieval coverage for complex sections (e.g., Discussion).
 */
export const DEFAULT_RERANKER_CONFIG: RerankerConfig = {
  mode: 'llm',
  rule: {
    enabled: false,
    weights: DEFAULT_RERANK_WEIGHTS,
  },
  llm: {
    enabled: true,
    llm_mode: 'client',
    rerank_top_k: 100,
    output_top_n: 25,
    max_chunk_chars: 500,
  },
};
