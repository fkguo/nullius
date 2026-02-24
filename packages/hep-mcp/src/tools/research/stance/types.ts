/**
 * Stance Detection Types
 *
 * Core type definitions for the citation stance detection system.
 * Based on the design document: docs/STANCE_DETECTION_IMPROVEMENT_PLAN.md
 */

// ─────────────────────────────────────────────────────────────────────────────
// Basic Types
// ─────────────────────────────────────────────────────────────────────────────

/** Stance type - four categories */
export type StanceType = 'confirming' | 'contradicting' | 'mixed' | 'neutral';

/** Target binding position type */
export type TargetBinding = 'same_sentence' | 'neighbor_sentence' | 'paragraph';

/** Confidence level */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/** Ownership type - distinguishes "our" vs "their" results */
export type OwnershipType = 'ours' | 'theirs' | 'unknown';

/** Input type for stance analysis */
export type InputType = 'citation_context' | 'abstract' | 'title';

/** Mixed type subdivision */
export type MixedType = 'strong' | 'weak';

// ─────────────────────────────────────────────────────────────────────────────
// Pattern Rule Types
// ─────────────────────────────────────────────────────────────────────────────

/** Pattern rule definition */
export interface PatternRule {
  /** Unique rule identifier */
  id: string;
  /** Matching pattern (regular expression) */
  pattern: RegExp;
  /** Stance direction */
  stance: 'confirming' | 'contradicting' | 'neutral';
  /** Weight (1-3), used for scoring */
  weight: number;
  /** Whether can be flipped by negation words */
  negatable: boolean;
  /** Special handling after negation flip */
  negationBehavior?: 'flip' | 'neutral' | 'weak_confirm';
  /** Whether the pattern itself has hedge tone */
  isHedge?: boolean;
  /** Rule description (for debugging) */
  description?: string;
}

/** Hedge pattern definition */
export interface HedgePattern {
  /** Matching pattern */
  pattern: RegExp;
  /** Confidence downgrade amount (0-1) */
  downgrade: number;
}

/** Matched rule record */
export interface MatchedRule {
  /** Rule ID */
  ruleId: string;
  /** Matched text snippet */
  snippet: string;
  /** Containing sentence */
  sentence: string;
  /** Whether negated */
  negated: boolean;
  /** Whether hedged */
  hedged?: boolean;
  /** Rule weight */
  weight: number;
  /** Final stance (after considering negation) */
  finalStance: StanceType;
}

// ─────────────────────────────────────────────────────────────────────────────
// Statistical Significance
// ─────────────────────────────────────────────────────────────────────────────

/** Statistical significance information */
export interface SignificanceInfo {
  /** σ value */
  sigma?: number;
  /** Confidence level (e.g., 95%) */
  confidenceLevel?: number;
  /** p-value */
  pValue?: number;
  /** Raw text */
  raw: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentence-Level Analysis
// ─────────────────────────────────────────────────────────────────────────────

/** Sentence-level analysis result */
export interface SentenceStanceResult {
  /** Original sentence */
  sentence: string;
  /** Sentence index */
  index: number;
  /** Ownership */
  ownership: OwnershipType;
  /** Whether after contrast word */
  afterContrast: boolean;
  /** Matched rules */
  matchedRules: Array<{
    ruleId: string;
    snippet: string;
    negated: boolean;
    hedged: boolean;
  }>;
  /** Confirming score */
  scoreConfirm: number;
  /** Contradicting score */
  scoreContra: number;
  /** Hedge score (reduces confidence) */
  scoreHedge: number;
  /** Statistical significance */
  significance?: SignificanceInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Metadata
// ─────────────────────────────────────────────────────────────────────────────

/** Context metadata for aggregation */
export interface ContextMeta {
  /** Section weight (0.5-2.0) */
  sectionWeight: number;
  /** Ownership weight: ours=0.5, theirs=1.0, unknown=0.8 */
  ownershipWeight: number;
  /** Binding weight: same_sentence=1.0, neighbor=0.7, paragraph=0.4 */
  bindingWeight: number;
  /** Self-citation weight: self=0.5, non-self=1.0 */
  selfCitationWeight: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Final Stance Result
// ─────────────────────────────────────────────────────────────────────────────

/** Final stance analysis result */
export interface StanceResult {
  /** Final stance judgment */
  stance: StanceType;
  /** Confidence level */
  confidence: ConfidenceLevel;
  /** Whether needs LLM review */
  needsLLMReview: boolean;
  /** LLM review trigger reason */
  llmReviewReason?: string;

  // ─── Explainability fields ───
  /** Total confirming score */
  scoreConfirm: number;
  /** Total contradicting score */
  scoreContra: number;
  /** Detected hedge words */
  hedges: string[];
  /** Match details */
  matched: MatchedRule[];
  /** Evidence sentences used */
  evidenceSentences: string[];
  /** Total sentences analyzed */
  analyzedSentenceCount: number;

  // ─── Meta information ───
  /** Input type */
  inputType: InputType;
  /** Whether weak signal (abstract proxy only) */
  isWeakSignal: boolean;
  /** Data layer used */
  layerUsed: 1 | 2 | 3;
  /** Citation binding position */
  targetBinding: TargetBinding;

  // ─── Debug information ───
  /** LLM review score */
  reviewScore: number;
  /** Mixed type subdivision */
  mixedType?: MixedType;
  /** Whether has complex negation */
  hasComplexNegation?: boolean;
  /** Ownership score */
  ownershipScore?: { ours: number; theirs: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Citation Context Types
// ─────────────────────────────────────────────────────────────────────────────

/** Citation context */
export interface CitationContext {
  /** Sentence containing the citation (LaTeX commands cleaned) */
  sentence: string;
  /** Extended context (1 sentence before and after) */
  extendedContext: string;
  /** Citekey used */
  citekey: string;
  /** Raw LaTeX snippet (for debugging) */
  rawLatex: string;

  // Section information
  /** Section name */
  section?: string;
  /** Section weight */
  sectionWeight?: number;

  // R4 completion fields
  /** Cite position in cleanText */
  citeSpan?: { start: number; end: number };
  /** Other citekeys in same sentence */
  otherCitekeysInSentence?: string[];
  /** Whether multi-cite */
  isMultiCite?: boolean;
  /** Extraction mode */
  extractionMode?: 'ast' | 'regex';
  /** Position information */
  position?: { charStart: number; charEnd: number; file?: string };
  /** Whether self-citation */
  isSelfCitation?: boolean;
}

/** Bibliography entry identifiers */
export interface BibEntryIdentifiers {
  citekey: string;
  doi?: string;
  arxiv?: string;
  eprint?: string;
  inspire?: string;
  reportNumber?: string;
  // Journal information (for old papers without DOI/arXiv)
  journal?: string;
  volume?: string;
  page?: string;
  year?: string;
  title?: string;
  author?: string;
}

/** Citation context extraction result */
export interface CitationContextExtractionResult {
  success: boolean;
  error?: string;
  /** Target paper's citekey(s) */
  targetCitekeys: string[];
  /** Extracted contexts */
  contexts: CitationContext[];
  /** Whether has LaTeX source */
  hasLatexSource: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text Stance Options
// ─────────────────────────────────────────────────────────────────────────────

/** Options for text stance analysis */
export interface TextStanceOptions {
  /** Topic keywords for relevance filtering */
  topicKeywords?: string[];
  /** Input type hint */
  inputType?: InputType;
  /** Whether to force weak signal mode */
  forceWeakSignal?: boolean;
  /** Section name for context */
  section?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Types (Phase 2)
// ─────────────────────────────────────────────────────────────────────────────

/** Resolution method for citekey → recid mapping */
export type ResolutionMethod = 'arxiv' | 'doi' | 'inspire' | 'texkey' | 'journal';

/** Pipeline error type */
export interface PipelineError {
  type: 'extraction' | 'resolution' | 'analysis' | 'fetch';
  citekey?: string;
  message: string;
  recoverable: boolean;
}

/** Pipeline input */
export interface StancePipelineInput {
  latexContent: string;
  targetRecid: string;
  bibContent?: string;
  options?: StancePipelineOptions;
}

/** Pipeline options */
export interface StancePipelineOptions {
  maxContexts?: number;           // Default 20
  includeNeighbors?: boolean;     // Default true
  resolverConcurrency?: number;   // Default 4
  skipUnresolved?: boolean;       // Default true
  onProgress?: (stage: string, progress: number) => void;
}

/** Citation context with stance analysis */
export interface CitationContextWithStance {
  context: CitationContext;
  stance: StanceResult;
  resolvedRecid: string | null;
  resolutionMethod?: ResolutionMethod;
  fromCache?: boolean;
}

/** Aggregated stance result */
export interface AggregatedStance {
  stance: StanceType;
  confidence: ConfidenceLevel;
  scores: {
    confirming: number;
    contradicting: number;
    neutral: number;
    mixed: number;
  };
  counts: {
    confirming: number;
    contradicting: number;
    neutral: number;
    mixed: number;
  };
  needsLLMReview: boolean;
  reviewReasons: string[];
}

/** Pipeline result */
export interface StancePipelineResult {
  targetRecid: string;
  targetTitle?: string;
  contexts: CitationContextWithStance[];
  aggregated: AggregatedStance;
  metadata: {
    totalCitations: number;
    resolvedCitekeysCount: number;
    resolvedUniqueRecidsCount: number;
    targetCitations: number;
    processingTimeMs: number;
    cacheHitRate?: number;
    bibFormatDetected?: string;
  };
  errors: PipelineError[];
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM Review Types (Phase 5)
// ─────────────────────────────────────────────────────────────────────────────

/** LLM review trigger reasons */
export type LLMReviewTrigger =
  | 'low_confidence'
  | 'close_margin'
  | 'contrast_flip'
  | 'mixed_strong'
  | 'complex_negation'
  | 'unknown_ownership';

/** LLM review request */
export interface LLMReviewRequest {
  /** Stable request ID (hash-based) */
  requestId: string;
  /** Citation context with stance */
  context: CitationContextWithStance;
  /** Trigger reasons */
  reasons: LLMReviewTrigger[];
  /** Suggested prompt for LLM */
  suggestedPrompt: string;
  /** Priority (1-5, higher = more urgent) */
  priority: number;
  /** Aggregate summary (for close_margin trigger) */
  aggregateSummary?: {
    confirming: number;
    contradicting: number;
    topStance: string;
    ratio: number;
  };
  /** Source layer */
  layer?: 1 | 2 | 3;
  /** Source metadata */
  sourceMeta?: {
    sourceRecid?: string;
    sourceTitle?: string;
  };
}

/** LLM review response (filled by external LLM) */
export interface LLMReviewResponse {
  requestId: string;
  stance: StanceType;
  confidence: ConfidenceLevel;
  reasoning: string;
}
