/**
 * LaTeX-Native RAG Module
 *
 * Phase 12: Evidence-Based Writing System
 *
 * Components:
 * - Chunker: LaTeX document segmentation
 * - Retriever: BM25 + HEP tokenization
 * - Preprocessor: Macro expansion with offset mapping
 * - HEP Tokenizer: Domain-specific tokenization
 *
 * @module writing/rag
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type {
  // Chunk types
  ChunkType,
  ChunkLocator,
  ChunkMetadata,
  EvidenceChunk,

  // HEP number types
  HEPNumber,
  HEPNumberType,

  // Index types
  ChunkIndex,
  SerializedIndex,

  // Retrieval types
  SectionType,
  RetrieveRequest,
  RetrieveResult,

  // Evidence packet types
  Claim,
  CoverageRequirements,
  EvidencePacket,

  // Writer output types
  SentenceKind,
  WriterOutput,
  ArgumentChain,
  SentenceAttribution,
  SectionOutput,

  // Preprocessor types
  DualTextResult,
  MacroRegistry,
  OffsetMapping,
  MappingEntry,

  // Verification types
  VerifyIssueType,
  VerifyIssue,
  VerifyResult,
  QualityGateResult,

  // Configuration types
  ChunkerOptions,
  ContextConfig,
  RerankWeights,
  RerankerConfig,
} from './types.js';

/**
 * Default configuration constants and Word-Count Adaptive Retrieval
 *
 * ## DEFAULT_RERANKER_CONFIG
 *
 * Controls the RAG reranker behavior (default: LLM mode enabled).
 *
 * **Quality-first principle**: Academic writing quality > cost/latency.
 * LLM rerank is enabled by default to maximize retrieval quality.
 *
 * Key parameters:
 * - `mode`: 'llm' | 'rule' | 'cross_encoder' | 'hybrid' | 'off'
 * - `llm.enabled`: true (default) - Enable LLM semantic reranking
 * - `llm.llm_mode`: 'client' | 'internal' - Which LLM to use
 * - `llm.rerank_top_k`: 100 (default) - Number of BM25 candidates to send to LLM
 *   - Hard cap: 300 (configurable up to min(300, total_results))
 *   - Controls breadth of semantic reranking
 * - `llm.output_top_n`: 25 (default) - Max chunks LLM can select
 *   - Hard cap: 100 (configurable up to min(100, rerank_top_k))
 *   - Final output = min(requested_top_k, output_top_n)
 * - `llm.max_chunk_chars`: 500 - Truncate chunks to this length for LLM
 *
 * **Flow**:
 * ```
 * BM25 retrieval (all chunks)
 *   ↓
 * Type Prior weighting
 *   ↓
 * Take top rerank_top_k candidates (≤300)
 *   ↓
 * LLM semantic rerank → select up to output_top_n (≤100)
 *   ↓
 * Sticky Retrieval (+~5 related chunks)
 *   ↓
 * Final output: ~min(requested_top_k, output_top_n) + sticky
 * ```
 *
 * **Fail-fast**: No BM25 fallback is allowed when LLM rerank is enabled.
 *
 * ## Word-Count Adaptive Retrieval (v0.3.0+)
 *
 * **Quality-first principle**: Longer sections require more evidence chunks.
 *
 * When `PacketBuilderOptions.suggested_word_count` or `SectionSpec.suggested_word_count`
 * is provided, retrieval parameters scale automatically:
 *
 * | Word Count | max_chunks | top_k_per_claim | max_tokens | Use Case |
 * |------------|------------|-----------------|------------|----------|
 * | 200        | 15         | 3               | 2,000      | Short intro |
 * | 1000       | 25         | 5               | 10,000     | Baseline (medium) |
 * | 2500       | 62         | 12              | 25,000     | Long section |
 * | 4000+      | 100        | 15              | 40,000+    | Comprehensive review |
 *
 * **Scaling formula**: Linear from baseline (1000 words → 25 chunks, 5 per claim)
 *
 * **Example**:
 * ```typescript
 * const sections: SectionSpec[] = [
 *   { title: "Introduction", type: "introduction", claims: [...], suggested_word_count: 300 },
 *   { title: "Discussion", type: "body", claims: [...], suggested_word_count: 2500 },
 * ];
 * const packets = await buildPacketsForOutline(sections, index);
 * // Introduction: 15 chunks (scaled down)
 * // Discussion: 62 chunks (scaled up)
 * ```
 *
 * @see RerankerConfig in types.ts for full interface
 * @see retrieve() in retriever.ts for implementation
 * @see buildEvidencePacket() in packetBuilder.ts for adaptive scaling
 */
export {
  COVERAGE_PRESETS,
  DEFAULT_CHUNKER_OPTIONS,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_RERANK_WEIGHTS,
  DEFAULT_RERANKER_CONFIG,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Chunker
// ─────────────────────────────────────────────────────────────────────────────

export {
  chunkPaper,
  generateContextChunks,
  type ChunkResult,
} from './chunker.js';

// ─────────────────────────────────────────────────────────────────────────────
// Retriever
// ─────────────────────────────────────────────────────────────────────────────

export {
  buildIndex,
  serializeIndex,
  deserializeIndex,
  retrieve,
  retrieveMulti,
  applyReranking,
  checkCoverage,
  getChunksByIds,
  getChunksByPaperId,
  getChunkByLabel,
} from './retriever.js';

// ─────────────────────────────────────────────────────────────────────────────
// LLM Reranker (Phase 1)
// ─────────────────────────────────────────────────────────────────────────────

export {
  buildRerankPrompt,
  parseRankingResult,
  rerankWithLLM,
  type LLMRerankCandidate,
  type LLMRerankParams,
  type LLMRerankResult,
  type LLMRerankClientContinuation,
} from './llmReranker.js';

// ─────────────────────────────────────────────────────────────────────────────
// Preprocessor
// ─────────────────────────────────────────────────────────────────────────────

export {
  preprocessDualText,
  extractMacroRegistry,
  findMainTex,
  removeAppendix,
  removeComments,
  findContentStart,
} from './preprocessor.js';

// ─────────────────────────────────────────────────────────────────────────────
// HEP Tokenizer
// ─────────────────────────────────────────────────────────────────────────────

export {
  tokenizeHEP,
  stripLatexPreserveHEP,
  estimateTokens,
  splitSentences,
  extractKeyTokens,
  countWords,
  jaccardSimilarity,
  type TokenizerOutput,
} from './hepTokenizer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Packet Builder
// ─────────────────────────────────────────────────────────────────────────────

export {
  buildEvidencePacket,
  serializePacket,
  compactPacket,
  buildPacketsForOutline,
  type PacketBuilderOptions,
  type SectionSpec,
} from './packetBuilder.js';

// ─────────────────────────────────────────────────────────────────────────────
// Writer Prompt
// ─────────────────────────────────────────────────────────────────────────────

export {
  generateWriterPrompt,
  parseWriterOutput,
  writerOutputToText,
  extractEvidenceIds,
  validateWriterOutput,
  generateRewritePrompt,
  generateArgumentChainPrompt,
  type PromptOptions,
  type ValidationResult,
} from './writerPrompt.js';

// ─────────────────────────────────────────────────────────────────────────────
// HEP Numbers
// ─────────────────────────────────────────────────────────────────────────────

export {
  extractHEPNumbers,
  extractNumbersFromChunk,
  areNumbersCompatible,
  calculateTension,
  matchNumbers,
  isSymbolicVariable,
  markSymbolicVariables,
  formatHEPNumber,
} from './hepNumbers.js';

// ─────────────────────────────────────────────────────────────────────────────
// Quality Gates
// ─────────────────────────────────────────────────────────────────────────────

export {
  checkAttributionGate,
  calculateSupportScore,
  checkSupportStrength,
  checkNumberGate,
  checkNgramGate,
  checkContextLeakage,
  runAllGates,
  getThresholds,
  setThresholds,
} from './qualityGates.js';

// ─────────────────────────────────────────────────────────────────────────────
// Verifier
// ─────────────────────────────────────────────────────────────────────────────

export {
  verifyOutput,
  quickVerify,
  type VerificationContext,
  type VerificationResult,
  type VerifierOptions,
} from './verifier.js';

// ─────────────────────────────────────────────────────────────────────────────
// Convenience Functions
// ─────────────────────────────────────────────────────────────────────────────

import { chunkPaper, generateContextChunks } from './chunker.js';
import { buildIndex } from './retriever.js';
import type { EvidenceChunk, ChunkIndex, ChunkerOptions } from './types.js';

/**
 * Chunk and index a paper in one call
 *
 * @param rawTex - Raw LaTeX content
 * @param paperId - INSPIRE record ID
 * @param filePath - Source file path
 * @param options - Chunker options
 * @returns Chunk index ready for retrieval
 */
export function chunkAndIndex(
  rawTex: string,
  paperId: string,
  filePath: string,
  options?: Partial<ChunkerOptions>
): { chunks: EvidenceChunk[]; index: ChunkIndex } {
  const result = chunkPaper(rawTex, paperId, filePath, options);
  const chunksWithContext = generateContextChunks(result.chunks);
  const index = buildIndex(chunksWithContext);

  return { chunks: chunksWithContext, index };
}

/**
 * Chunk and index multiple papers
 */
export function chunkAndIndexMulti(
  papers: { rawTex: string; paperId: string; filePath: string }[],
  options?: Partial<ChunkerOptions>
): { chunks: EvidenceChunk[]; index: ChunkIndex } {
  const allChunks: EvidenceChunk[] = [];

  for (const paper of papers) {
    const { chunks } = chunkAndIndex(
      paper.rawTex,
      paper.paperId,
      paper.filePath,
      options
    );
    allChunks.push(...chunks);
  }

  const index = buildIndex(allChunks);
  return { chunks: allChunks, index };
}
