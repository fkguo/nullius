/**
 * Evidence Packet Builder
 *
 * Constructs EvidencePacket for LLM writing:
 * - Gathers claims and evidence chunks
 * - Enforces token budgets
 * - Applies coverage requirements
 *
 * @module rag/packetBuilder
 */

import type {
  EvidencePacket,
  EvidenceChunk,
  ChunkIndex,
  Claim,
  SectionType,
  CoverageRequirements,
} from './types.js';
import { retrieveMulti, checkCoverage } from './retriever.js';
import { estimateTokens } from './hepTokenizer.js';
import { invalidParams } from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Constants (baseline values for 1000-word sections)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CHUNKS = 20;
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_MAX_CITATIONS_PER_SENTENCE = 3;
const DEFAULT_TOP_K_PER_CLAIM = 5;

// Baseline for word-count adaptive scaling
const BASE_WORD_COUNT = 1000;
const BASE_MAX_CHUNKS = 25;

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Scale retrieval parameters based on target word count
 *
 * **Quality-first principle**: Longer sections require more evidence chunks
 * to maintain depth and citation quality.
 *
 * Scaling strategy:
 * - Linear scaling from baseline (1000 words → 25 chunks, 5 per claim)
 * - Conservative token estimate (~10 tokens/word for CJK compatibility)
 * - Scales top_k_per_claim for deeper multi-query retrieval
 *
 * Examples:
 * - 200 words  → {max_chunks: 15, top_k_per_claim: 3, max_tokens: 2000}
 * - 1000 words → {max_chunks: 25, top_k_per_claim: 5, max_tokens: 10000}
 * - 2500 words → {max_chunks: 62, top_k_per_claim: 12, max_tokens: 25000}
 * - 4000 words → {max_chunks: 100, top_k_per_claim: 15, max_tokens: 40000}
 *
 * @param suggestedWordCount - Target word count for the section
 * @returns Scaled retrieval parameters
 */
function scaleRetrievalParams(suggestedWordCount: number): {
  max_chunks: number;
  top_k_per_claim: number;
  max_tokens: number;
} {
  if (!Number.isFinite(suggestedWordCount) || suggestedWordCount <= 0) {
    // Fallback to baseline if invalid
    return {
      max_chunks: BASE_MAX_CHUNKS,
      top_k_per_claim: 5,
      max_tokens: 10000,
    };
  }

  // Linear scaling from baseline
  const scaleFactor = suggestedWordCount / BASE_WORD_COUNT;
  const scaledChunks = Math.round(BASE_MAX_CHUNKS * scaleFactor);

  return {
    max_chunks: clamp(scaledChunks, 15, 150),
    top_k_per_claim: clamp(Math.round(5 * scaleFactor), 3, 15),
    max_tokens: Math.round(suggestedWordCount * 10), // ~10 tokens/word
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PacketBuilderOptions {
  /** Maximum chunks to include */
  max_chunks?: number;
  /** Maximum total tokens */
  max_tokens?: number;
  /** Maximum citations per sentence */
  max_citations_per_sentence?: number;
  /** Top k chunks per claim */
  top_k_per_claim?: number;
  /**
   * Suggested word count for the section (enables adaptive retrieval)
   *
   * When provided, overrides max_chunks/max_tokens/rerank_top_k with scaled values.
   * Quality-first: longer sections get more evidence chunks automatically.
   */
  suggested_word_count?: number;
  /** Custom coverage requirements */
  custom_coverage?: Partial<CoverageRequirements>;
  /** Section scope override */
  section_scope?: {
    prefer: string[];
    exclude: string[];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Packet Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build evidence packet for a section
 *
 * @param sectionTitle - Title of section to write
 * @param sectionType - Type of section (introduction, methodology, etc.)
 * @param claims - Claims assigned to this section
 * @param index - Chunk index for retrieval
 * @param options - Builder options
 * @returns Evidence packet ready for LLM
 */
export async function buildEvidencePacket(
  sectionTitle: string,
  sectionType: SectionType,
  claims: Claim[],
  index: ChunkIndex,
  options: PacketBuilderOptions = {}
): Promise<EvidencePacket> {
  // Apply word-count adaptive scaling if suggested_word_count is provided
  const scaledParams = options.suggested_word_count
    ? scaleRetrievalParams(options.suggested_word_count)
    : null;

  const {
    max_chunks = scaledParams?.max_chunks ?? DEFAULT_MAX_CHUNKS,
    max_tokens = scaledParams?.max_tokens ?? DEFAULT_MAX_TOKENS,
    max_citations_per_sentence = DEFAULT_MAX_CITATIONS_PER_SENTENCE,
    top_k_per_claim = scaledParams?.top_k_per_claim ?? DEFAULT_TOP_K_PER_CLAIM,
    custom_coverage,
    section_scope,
  } = options;

  // 1. Get coverage requirements
  const baseCoverage = COVERAGE_PRESETS_IMPL[sectionType] || {
    min_chunks_by_type: { paragraph: 2 },
    require_at_least_one_of: [['paragraph']],
  };

  const coverage: CoverageRequirements = {
    ...baseCoverage,
    ...custom_coverage,
    prefer_sections: section_scope?.prefer ?? baseCoverage.prefer_sections,
    exclude_sections: section_scope?.exclude ?? baseCoverage.exclude_sections,
  };

  // 2. Extract keywords from claims
  const keywords = extractKeywords(claims);

  // 3. Retrieve evidence for claims
  const queries = claims.map((c) => c.claim_text);
  const retrieveResult = await retrieveMulti(
    queries,
    keywords,
    index,
    top_k_per_claim,
    sectionType
  );

  // 4. Apply token budget
  const { budgeted, overflow } = applyTokenBudget(
    [...retrieveResult.chunks, ...retrieveResult.context_chunks],
    max_tokens,
    max_chunks
  );

  if (overflow.length > 0) {
    throw invalidParams('Token budget exceeded (fail-fast; no silent truncation allowed)', {
      max_tokens,
      max_chunks,
      selected_chunks: budgeted.length,
      overflow_chunks: overflow.length,
      suggestions: [
        'Increase max_tokens/max_chunks to include all retrieved evidence without truncation.',
        'Reduce top_k_per_claim to retrieve fewer chunks per claim.',
      ],
    });
  }

  // 5. Separate main and context chunks
  const mainChunkIds = new Set(retrieveResult.chunks.map((c) => c.id));
  const mainChunks = budgeted.filter((c) => mainChunkIds.has(c.id));
  const contextChunks = budgeted.filter((c) => !mainChunkIds.has(c.id));

  // 6. Check coverage
  const coverageCheck = checkCoverage(mainChunks, {
    min_by_type: coverage.min_chunks_by_type,
    require_at_least_one_of: coverage.require_at_least_one_of,
  });

  if (!coverageCheck.met) {
    throw invalidParams('Coverage requirements not met (fail-fast; no heuristic gap filling allowed)', {
      section_type: sectionType,
      missing: coverageCheck.missing,
      suggestions: [
        'Increase top_k_per_claim to retrieve more candidates (then re-run with sufficient token budget).',
        'Increase max_tokens/max_chunks to allow including additional evidence types required by coverage presets.',
      ],
    });
  }

  // 8. Link claims to supporting chunks
  const linkedClaims = linkClaimsToChunks(claims, mainChunks);

  // 9. Build allowed IDs
  const allowed = {
    claim_ids: linkedClaims.map((c) => c.claim_id),
    chunk_ids: [...mainChunks, ...contextChunks].map((c) => c.id),
  };

  return {
    task: {
      section_title: sectionTitle,
      section_type: sectionType,
      assigned_claims: claims.map((c) => c.claim_id),
    },
    claims: linkedClaims,
    chunks: mainChunks,
    context_chunks: contextChunks,
    allowed,
    coverage,
    budgets: {
      max_chunks,
      max_total_tokens: max_tokens,
      max_citations_per_sentence,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract keywords from claims
 */
function extractKeywords(claims: Claim[]): string[] {
  const keywords: string[] = [];

  for (const claim of claims) {
    // Extract significant words from claim text
    const words = claim.claim_text
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .map((w) => w.toLowerCase().replace(/[.,;:'"()]/g, ''));

    keywords.push(...words);
  }

  // Deduplicate
  return [...new Set(keywords)];
}

/**
 * Apply token budget to chunks
 */
function applyTokenBudget(
  chunks: EvidenceChunk[],
  maxTokens: number,
  maxChunks: number
): { budgeted: EvidenceChunk[]; overflow: EvidenceChunk[] } {
  const budgeted: EvidenceChunk[] = [];
  const overflow: EvidenceChunk[] = [];
  let totalTokens = 0;

  for (const chunk of chunks) {
    const tokens = chunk.metadata.token_estimate || estimateTokens(chunk.text);

    if (budgeted.length < maxChunks && totalTokens + tokens <= maxTokens) {
      budgeted.push(chunk);
      totalTokens += tokens;
    } else {
      overflow.push(chunk);
    }
  }

  return { budgeted, overflow };
}

/**
 * Link claims to supporting chunks
 */
function linkClaimsToChunks(
  claims: Claim[],
  chunks: EvidenceChunk[]
): Claim[] {
  return claims.map((claim) => {
    // Find chunks that mention keywords from this claim
    const claimWords = new Set(
      claim.claim_text
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );

    const supporting: { chunk_id: string; relevance: number }[] = [];

    for (const chunk of chunks) {
      const chunkWords = new Set(
        chunk.text.toLowerCase().split(/\s+/)
      );

      // Calculate Jaccard-like overlap
      const intersection = [...claimWords].filter((w) => chunkWords.has(w));
      const relevance = intersection.length / claimWords.size;

      if (relevance > 0.1) {
        supporting.push({
          chunk_id: chunk.id,
          relevance: Math.round(relevance * 100) / 100,
        });
      }
    }

    // Sort by relevance
    supporting.sort((a, b) => b.relevance - a.relevance);

    return {
      ...claim,
      supporting_evidence: supporting.slice(0, 5),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage Presets (implementation)
// ─────────────────────────────────────────────────────────────────────────────

const COVERAGE_PRESETS_IMPL: Record<SectionType, CoverageRequirements> = {
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

// ─────────────────────────────────────────────────────────────────────────────
// Packet Serialization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialize packet to JSON for LLM input
 */
export function serializePacket(packet: EvidencePacket): string {
  return JSON.stringify(packet, null, 2);
}

/**
 * Create a compact version of the packet for smaller token usage
 */
export function compactPacket(packet: EvidencePacket): object {
  return {
    task: packet.task,
    claims: packet.claims.map((c) => ({
      id: c.claim_id,
      text: c.claim_text,
      evidence: c.supporting_evidence.map((e) => e.chunk_id),
    })),
    chunks: packet.chunks.map((c) => ({
      id: c.id,
      type: c.type,
      text: c.text.slice(0, 500), // Truncate for preview
      label: c.locator.label,
      section: c.locator.section_path.join('/'),
    })),
    context: packet.context_chunks.map((c) => ({
      id: c.id,
      type: c.type,
      text: c.text.slice(0, 300),
    })),
    allowed: packet.allowed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Section Packet Building
// ─────────────────────────────────────────────────────────────────────────────

export interface SectionSpec {
  title: string;
  type: SectionType;
  claims: Claim[];
  /** Suggested word count (enables adaptive retrieval if provided) */
  suggested_word_count?: number;
}

/**
 * Build packets for multiple sections
 *
 * Supports word-count adaptive retrieval: if SectionSpec includes
 * suggested_word_count, each section gets scaled retrieval parameters.
 */
export async function buildPacketsForOutline(
  sections: SectionSpec[],
  index: ChunkIndex,
  options: PacketBuilderOptions = {}
): Promise<Map<string, EvidencePacket>> {
  const packets = new Map<string, EvidencePacket>();

  for (const section of sections) {
    // Merge section-specific word count with global options
    const sectionOptions: PacketBuilderOptions = {
      ...options,
      suggested_word_count: section.suggested_word_count ?? options.suggested_word_count,
    };

    const packet = await buildEvidencePacket(
      section.title,
      section.type,
      section.claims,
      index,
      sectionOptions
    );
    packets.set(section.title, packet);
  }

  return packets;
}
