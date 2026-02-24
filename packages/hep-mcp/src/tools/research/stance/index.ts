/**
 * Stance Detection Module
 *
 * Citation stance detection system for HEP research papers.
 */

// Types
export type {
  StanceType,
  TargetBinding,
  ConfidenceLevel,
  OwnershipType,
  InputType,
  MixedType,
  PatternRule,
  HedgePattern,
  MatchedRule,
  SignificanceInfo,
  SentenceStanceResult,
  ContextMeta,
  StanceResult,
  CitationContext,
  BibEntryIdentifiers,
  CitationContextExtractionResult,
  TextStanceOptions,
  // Phase 2 types
  ResolutionMethod,
  PipelineError,
  StancePipelineInput,
  StancePipelineOptions,
  CitationContextWithStance,
  AggregatedStance,
  StancePipelineResult,
} from './types.js';

// Configuration
export {
  DEFAULT_STANCE_CONFIG,
  getSectionWeight,
  getBindingWeight,
  getOwnershipWeight,
  getSelfCitationWeight,
} from './config.js';
export type { StanceConfig } from './config.js';

// Patterns
export {
  CONFIRMING_PATTERNS,
  CONTRADICTING_PATTERNS,
  EXCEPTION_PATTERNS,
  HEDGE_PATTERNS,
  METHODOLOGICAL_PATTERNS,
  CONSTRAINT_PATTERNS,
  DISCLAIMER_PATTERNS,
  NEGATION_WORDS,
  OWNERSHIP_MARKERS,
  EXPERIMENT_NAMES,
  CONTRAST_MARKERS,
  SIGMA_PATTERNS,
} from './patterns.js';

// Tokenizer
export {
  tokenize,
  isInNegationScope,
  splitIntoSentences,
  splitByClauses,
  shouldIncludeNextSentence,
  CITE_PLACEHOLDER_PATTERN,
} from './tokenizer.js';
export type { NegationResult } from './tokenizer.js';

// Analyzer
export {
  analyzeTextStance,
  detectOwnership,
  detectHedges,
  extractSignificance,
  isMethodologicalCitation,
  isAfterContrast,
  matchPatterns,
  analyzeSentence,
  calculateReviewScore,
  // Phase 5 additions
  applyContrastWeights,
} from './analyzer.js';
export type { ContrastAnalysis } from './analyzer.js';

// Extractor
export {
  replaceCitesWithPlaceholders,
  cleanLatexPreservingPlaceholders,
  detectSectionAtPosition,
  extractCitationContextsFromRegex,
  CITE_PLACEHOLDER_PREFIX,
  CITE_PLACEHOLDER_SUFFIX,
  CITE_PATTERN,
} from './extractor.js';
export type { PlaceholderResult } from './extractor.js';

// Resolver
export {
  normalizeArxivId,
  normalizeJournal,
  inspireLookupByArxiv,
  inspireLookupByDOI,
  inspireLookupByJournal,
  resolveCitekeyToRecid,
  // Phase 2 additions
  batchResolveCitekeys,
} from './resolver.js';
export type { BatchResolveResult } from './resolver.js';

// Bibitem Parser
export {
  extractIdentifiersFromBibitem,
  isBblContent,
  extractBibitemsFromBbl,
  // Phase 2 additions
  detectBibFormat,
  parseBibliographyContent,
} from './bibitemParser.js';
export type { BibFormat, BibliographyParseResult } from './bibitemParser.js';

// Cache (Phase 2)
export {
  resolverCache,
  normalizeCacheKey,
} from './cache.js';
export type { ResolverCacheEntry } from './cache.js';

// Aggregator (Phase 2)
export { aggregateStances } from './aggregator.js';

// Pipeline (Phase 2)
export { analyzeStanceFromLatex } from './pipeline.js';

export {
  CONTRAST_CONFIG,
} from './config.js';

// LLM Review (Phase 5)
export {
  generateRequestId,
  calculatePriority,
  detectTriggers,
  generateReviewPrompt,
  createReviewRequest,
  filterContextsNeedingReview,
} from './review.js';

export type {
  LLMReviewTrigger,
  LLMReviewRequest,
  LLMReviewResponse,
} from './types.js';
