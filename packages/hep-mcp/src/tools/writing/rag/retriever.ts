/**
 * BM25 Retriever
 *
 * HEP-domain optimized retrieval with:
 * - BM25 scoring
 * - Sticky Retrieval (reference-based pull)
 * - Type Prior (section-based type weighting)
 * - Section Scoping
 *
 * @module rag/retriever
 */

import type {
  EvidenceChunk,
  ChunkIndex,
  ChunkType,
  RetrieveRequest,
  RetrieveResult,
  SectionType,
  SerializedIndex,
} from './types.js';
import { DEFAULT_RERANKER_CONFIG } from './types.js';
import { tokenizeHEP } from './hepTokenizer.js';
import { rerankWithLLM } from './llmReranker.js';

// ─────────────────────────────────────────────────────────────────────────────
// BM25 Constants
// ─────────────────────────────────────────────────────────────────────────────

const BM25_K1 = 1.5;
const BM25_B = 0.75;

// ─────────────────────────────────────────────────────────────────────────────
// Type Prior Weights
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type prior weights by section type
 * Higher weight = preferred for that section type
 */
const TYPE_PRIORS: Record<SectionType, Partial<Record<ChunkType, number>>> = {
  introduction: {
    paragraph: 1.0,
    citation_context: 1.2,
    definition: 1.1,
    equation: 0.6,
    table: 0.5,
  },
  methodology: {
    equation: 1.3,
    equation_context: 1.2,
    paragraph: 1.0,
    definition: 1.1,
    table: 0.8,
  },
  results: {
    table: 1.4,
    table_context: 1.3,
    figure: 1.3,
    figure_context: 1.2,
    paragraph: 1.0,
    equation: 0.8,
  },
  discussion: {
    paragraph: 1.2,
    citation_context: 1.1,
    figure_context: 1.0,
    table_context: 1.0,
  },
  conclusion: {
    paragraph: 1.3,
    citation_context: 1.0,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Index Building
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build chunk index from evidence chunks
 */
export function buildIndex(chunks: EvidenceChunk[]): ChunkIndex {
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;

  // Calculate document frequency and total length
  for (const chunk of chunks) {
    const { index_tokens: tokens } = tokenizeHEP(chunk.text);
    totalLength += tokens.length;

    // Count unique terms per document
    const uniqueTerms = new Set(tokens);
    for (const term of uniqueTerms) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  return {
    chunks,
    documentFrequency,
    totalDocuments: chunks.length,
    avgDocLength: chunks.length > 0 ? totalLength / chunks.length : 0,
  };
}

/**
 * Serialize index to JSON
 */
export function serializeIndex(
  index: ChunkIndex,
  paperIds: string[]
): SerializedIndex {
  const df: Record<string, number> = {};
  for (const [term, count] of index.documentFrequency) {
    df[term] = count;
  }

  return {
    version: '1.0.0',
    created_at: new Date().toISOString(),
    paper_ids: paperIds,
    chunks: index.chunks,
    df,
    totalDocuments: index.totalDocuments,
    avgDocLength: index.avgDocLength,
  };
}

/**
 * Deserialize index from JSON
 */
export function deserializeIndex(data: SerializedIndex): ChunkIndex {
  const documentFrequency = new Map<string, number>();
  for (const [term, count] of Object.entries(data.df)) {
    documentFrequency.set(term, count);
  }

  return {
    chunks: data.chunks,
    documentFrequency,
    totalDocuments: data.totalDocuments,
    avgDocLength: data.avgDocLength,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BM25 Scoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate IDF for a term
 */
function idf(term: string, index: ChunkIndex): number {
  const df = index.documentFrequency.get(term) || 0;
  const N = index.totalDocuments;
  return Math.log((N - df + 0.5) / (df + 0.5) + 1);
}

/**
 * Calculate BM25 score for a chunk given query tokens
 */
function bm25Score(
  chunk: EvidenceChunk,
  queryTokens: string[],
  index: ChunkIndex
): number {
  const { index_tokens: docTokens } = tokenizeHEP(chunk.text);
  const docLength = docTokens.length;

  // Term frequency in document
  const tf = new Map<string, number>();
  for (const term of docTokens) {
    tf.set(term, (tf.get(term) || 0) + 1);
  }

  let score = 0;
  for (const term of queryTokens) {
    const termFreq = tf.get(term) || 0;
    if (termFreq === 0) continue;

    const termIdf = idf(term, index);
    const numerator = termFreq * (BM25_K1 + 1);
    const denominator =
      termFreq +
      BM25_K1 * (1 - BM25_B + (BM25_B * docLength) / index.avgDocLength);

    score += termIdf * (numerator / denominator);
  }

  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sticky Retrieval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build label-to-chunk index for O(1) lookups
 */
function buildLabelIndex(chunks: EvidenceChunk[]): Map<string, EvidenceChunk> {
  const index = new Map<string, EvidenceChunk>();
  for (const chunk of chunks) {
    if (chunk.locator.label) {
      index.set(chunk.locator.label, chunk);
    }
  }
  return index;
}

/**
 * Find chunks referenced by a given chunk (forward refs)
 * Uses pre-built label index for O(1) lookups
 */
function findReferencedChunks(
  chunk: EvidenceChunk,
  labelIndex: Map<string, EvidenceChunk>
): EvidenceChunk[] {
  const result: EvidenceChunk[] = [];

  // Find chunks with labels that this chunk references
  for (const ref of chunk.refs.outgoing) {
    const target = labelIndex.get(ref);
    if (target) {
      result.push(target);
    }
  }

  return result;
}

// Reserved for future bidirectional reference tracking
/*
function findReferencingChunks(
  chunk: EvidenceChunk,
  allChunks: EvidenceChunk[]
): EvidenceChunk[] {
  if (!chunk.locator.label) return [];

  return allChunks.filter((c) =>
    c.refs.outgoing.includes(chunk.locator.label!)
  );
}
*/

/**
 * Apply Sticky Retrieval: pull in referenced chunks
 *
 * Strategy:
 * 1. For each retrieved chunk, also include chunks it references
 * 2. For equations/tables/figures, include their context chunks
 */
function applyStickyRetrieval(
  retrieved: EvidenceChunk[],
  allChunks: EvidenceChunk[],
  maxExtra: number = 5
): EvidenceChunk[] {
  const result = new Set<string>(retrieved.map((c) => c.id));
  const extraChunks: EvidenceChunk[] = [];

  // Build indexes once for O(1) lookups
  const labelIndex = buildLabelIndex(allChunks);
  const idIndex = new Map<string, EvidenceChunk>(allChunks.map((c) => [c.id, c]));

  for (const chunk of retrieved) {
    if (extraChunks.length >= maxExtra) break;

    // 1. Pull referenced chunks (using label index)
    const referenced = findReferencedChunks(chunk, labelIndex);
    for (const ref of referenced) {
      if (!result.has(ref.id) && extraChunks.length < maxExtra) {
        extraChunks.push(ref);
        result.add(ref.id);
      }
    }

    // 2. For non-text chunks, pull context (using id index)
    if (['equation', 'table', 'figure'].includes(chunk.type)) {
      const contextId = `${chunk.id}_ctx`;
      const context = idIndex.get(contextId);
      if (context && !result.has(context.id) && extraChunks.length < maxExtra) {
        extraChunks.push(context);
        result.add(context.id);
      }
    }
  }

  return [...retrieved, ...extraChunks];
}

// ─────────────────────────────────────────────────────────────────────────────
// Section Scoping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filter chunks by section scope
 */
function applySectionScope(
  chunks: EvidenceChunk[],
  prefer: string[],
  exclude: string[]
): EvidenceChunk[] {
  return chunks.filter((chunk) => {
    const sectionPath = chunk.locator.section_path.join('/').toLowerCase();

    // Exclude matching sections
    if (exclude.some((e) => sectionPath.includes(e.toLowerCase()))) {
      return false;
    }

    return true;
  }).sort((a, b) => {
    // Prefer matching sections
    const aPath = a.locator.section_path.join('/').toLowerCase();
    const bPath = b.locator.section_path.join('/').toLowerCase();

    const aPreferred = prefer.some((p) => aPath.includes(p.toLowerCase()));
    const bPreferred = prefer.some((p) => bPath.includes(p.toLowerCase()));

    if (aPreferred && !bPreferred) return -1;
    if (!aPreferred && bPreferred) return 1;
    return 0;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Retriever
// ─────────────────────────────────────────────────────────────────────────────

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.trunc(value)
      : typeof value === 'string'
        ? Math.trunc(Number.parseInt(value, 10))
        : NaN;

  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Retrieve evidence chunks for a query
 *
 * @param request - Retrieve request with query and options
 * @param index - Chunk index
 * @returns Retrieved chunks with context
 */
export async function retrieve(
  request: RetrieveRequest,
  index: ChunkIndex
): Promise<RetrieveResult> {
  // 1. Tokenize query
  const queryText = [request.query, ...request.keywords].join(' ');
  const { index_tokens: queryTokens } = tokenizeHEP(queryText);

  // 2. Filter by type
  let candidates = index.chunks;
  if (request.type_filter && request.type_filter.length > 0) {
    candidates = candidates.filter((c) =>
      request.type_filter!.includes(c.type)
    );
  }

  // 3. Apply section scope
  if (request.section_scope) {
    candidates = applySectionScope(
      candidates,
      request.section_scope.prefer,
      request.section_scope.exclude
    );
  }

  // 4. Calculate BM25 scores
  const scored = candidates.map((chunk) => ({
    chunk,
    score: bm25Score(chunk, queryTokens, index),
  }));

  // 5. Apply type prior
  if (request.target_section_type) {
    const priors = TYPE_PRIORS[request.target_section_type] || {};
    for (const item of scored) {
      const weight = priors[item.chunk.type] || 1.0;
      item.score *= weight;
    }
  }

  // 6. Sort by score
  scored.sort((a, b) => b.score - a.score);

  // 7. Optional LLM rerank (Phase 1)
  const rerankerConfig = request.reranker ?? DEFAULT_RERANKER_CONFIG;
  let rerankedScored = scored;
  const requestedTopK = clampInt(request.top_k, Math.min(10, scored.length), 0, scored.length);
  let effectiveTopK = requestedTopK;

  if (rerankerConfig.mode === 'llm' && rerankerConfig.llm?.enabled && requestedTopK > 0 && scored.length > 0) {
    const llmMode = rerankerConfig.llm.llm_mode;
    if (llmMode !== 'client' && llmMode !== 'internal') {
      throw new Error(`LLM rerank failed: invalid llm_mode=${String(llmMode)}`);
    }

    // Quality-first: Raised hard caps from 200/50 to 300/100 for better coverage
    const rerankTopK = clampInt(rerankerConfig.llm.rerank_top_k, 30, 1, Math.min(300, scored.length));
    const candidateCount = Math.min(scored.length, rerankTopK);
    const outputTopN = clampInt(rerankerConfig.llm.output_top_n, 10, 1, Math.min(100, candidateCount));
    const desiredTopK = Math.min(requestedTopK, candidateCount, outputTopN);

    if (candidateCount > 0 && desiredTopK > 0) {
      const candidatesForLLM = scored.slice(0, candidateCount).map((item, idx) => ({
        index: idx,
        content: item.chunk.text,
        source: `${item.chunk.locator.paper_id}:${item.chunk.locator.section_path.join('/')}`,
      }));

      try {
        const reranked = await rerankWithLLM({
          query: request.query,
          candidates: candidatesForLLM,
          config: {
            ...rerankerConfig.llm,
            output_top_n: desiredTopK,
          },
          llm_mode: llmMode,
        });

        if (reranked.mode_used === 'client') {
          throw new Error(
            'LLM rerank requested with llm_mode=client, but retrieve() cannot continue without a submitted ranked_indices result (no BM25 fallback allowed).'
          );
        }

        if (reranked.ranked_indices.length === 0) {
          throw new Error('LLM rerank returned empty ranked_indices (no BM25 fallback allowed).');
        }

        rerankedScored = applyReranking(scored, reranked.ranked_indices, candidateCount);
        effectiveTopK = desiredTopK;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`LLM rerank failed (no BM25 fallback allowed): ${msg}`);
      }
    }
  }

  // 8. Take top k (after optional rerank)
  const topK = rerankedScored.slice(0, effectiveTopK);
  const retrieved = topK.map((s) => s.chunk);

  // 9. Apply Sticky Retrieval
  const withSticky = applyStickyRetrieval(retrieved, index.chunks);

  // 10. Separate main and context chunks
  const mainChunks = withSticky.filter((c) =>
    retrieved.some((r) => r.id === c.id)
  );
  const contextChunks = withSticky.filter((c) =>
    !retrieved.some((r) => r.id === c.id)
  );

  return {
    chunks: mainChunks,
    context_chunks: contextChunks,
  };
}

export function applyReranking<T>(
  items: T[],
  rankedIndices: number[],
  candidateCount: number
): T[] {
  const headCount = Math.max(0, Math.min(items.length, Math.trunc(candidateCount)));
  const head = items.slice(0, headCount);
  const tail = items.slice(headCount);

  const reordered: T[] = [];
  const used = new Set<number>();

  for (const idx of rankedIndices) {
    const i = Math.trunc(idx);
    if (!Number.isFinite(i) || i < 0 || i >= head.length) continue;
    if (used.has(i)) continue;
    used.add(i);
    reordered.push(head[i]);
  }

  for (let i = 0; i < head.length; i += 1) {
    if (used.has(i)) continue;
    reordered.push(head[i]);
  }

  return [...reordered, ...tail];
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Query Retrieval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrieve for multiple queries (claims)
 *
 * Merges results and deduplicates
 */
export async function retrieveMulti(
  queries: string[],
  keywords: string[],
  index: ChunkIndex,
  topKPerQuery: number = 5,
  targetSection?: SectionType
): Promise<RetrieveResult> {
  const allChunks = new Map<string, EvidenceChunk>();
  const allContext = new Map<string, EvidenceChunk>();

  for (const query of queries) {
    const result = await retrieve(
      {
        query,
        keywords,
        top_k: topKPerQuery,
        target_section_type: targetSection,
      },
      index
    );

    for (const chunk of result.chunks) {
      if (!allChunks.has(chunk.id)) {
        allChunks.set(chunk.id, chunk);
      }
    }

    for (const chunk of result.context_chunks) {
      if (!allContext.has(chunk.id) && !allChunks.has(chunk.id)) {
        allContext.set(chunk.id, chunk);
      }
    }
  }

  return {
    chunks: [...allChunks.values()],
    context_chunks: [...allContext.values()],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage Check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if retrieved chunks meet coverage requirements
 */
export function checkCoverage(
  chunks: EvidenceChunk[],
  requirements: {
    min_by_type?: Partial<Record<ChunkType, number>>;
    require_at_least_one_of?: ChunkType[][];
  }
): { met: boolean; missing: string[] } {
  const missing: string[] = [];

  // Check min_by_type
  if (requirements.min_by_type) {
    for (const [type, minCount] of Object.entries(requirements.min_by_type)) {
      const count = chunks.filter((c) => c.type === type).length;
      if (count < minCount) {
        missing.push(`Need ${minCount - count} more ${type} chunks`);
      }
    }
  }

  // Check require_at_least_one_of
  if (requirements.require_at_least_one_of) {
    for (const typeGroup of requirements.require_at_least_one_of) {
      const hasAny = typeGroup.some((type) =>
        chunks.some((c) => c.type === type)
      );
      if (!hasAny) {
        missing.push(`Need at least one of: ${typeGroup.join(', ')}`);
      }
    }
  }

  return {
    met: missing.length === 0,
    missing,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunk Lookup Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Look up chunks by IDs
 */
export function getChunksByIds(
  ids: string[],
  index: ChunkIndex
): EvidenceChunk[] {
  return ids
    .map((id) => index.chunks.find((c) => c.id === id))
    .filter((c): c is EvidenceChunk => c !== undefined);
}

/**
 * Look up chunks by paper ID
 */
export function getChunksByPaperId(
  paperId: string,
  index: ChunkIndex
): EvidenceChunk[] {
  return index.chunks.filter((c) => c.locator.paper_id === paperId);
}

/**
 * Look up chunks by label
 */
export function getChunkByLabel(
  label: string,
  index: ChunkIndex
): EvidenceChunk | undefined {
  return index.chunks.find((c) => c.locator.label === label);
}
