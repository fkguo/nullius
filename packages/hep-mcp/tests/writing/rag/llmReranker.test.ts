import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { EvidenceChunk } from '../../../src/tools/writing/rag/types.js';
import { buildIndex, retrieve } from '../../../src/tools/writing/rag/retriever.js';
import { buildRerankPrompt, parseRankingResult, rerankWithLLM } from '../../../src/tools/writing/rag/llmReranker.js';
import { createLLMClient, getWritingModeConfig } from '../../../src/tools/writing/llm/index.js';

vi.mock('../../../src/tools/writing/llm/index.js', () => ({
  createLLMClient: vi.fn(),
  getWritingModeConfig: vi.fn(),
}));

function makeChunk(id: string, text: string): EvidenceChunk {
  return {
    id,
    content_hash: `hash-${id}`,
    type: 'paragraph',
    content_latex: text,
    text,
    locator: {
      paper_id: 'p1',
      file_path: 'main.tex',
      section_path: ['introduction'],
      line_start: 1,
      line_end: 1,
    },
    refs: { outgoing: [], outgoing_cites: [], incoming: [] },
    navigation: {},
    metadata: {
      has_math: false,
      has_citation: false,
      word_count: text.split(/\s+/).filter(w => w.length > 0).length,
      token_estimate: 0,
    },
  };
}

describe('LLM Reranker (Phase 1)', () => {
  beforeEach(() => {
    vi.mocked(createLLMClient).mockReset();
    vi.mocked(getWritingModeConfig).mockReset();

    vi.mocked(getWritingModeConfig).mockReturnValue({
      mode: 'internal',
      llmConfig: { provider: 'openai', model: 'mock', apiKey: 'test' },
      timeout: 10_000,
      maxRetries: 1,
    });

    vi.mocked(createLLMClient).mockReturnValue({
      provider: 'openai',
      model: 'mock-model',
      generate: vi.fn(async () => ''),
      generateWithMetadata: vi.fn(async () => ({ content: '[0]', latency_ms: 0, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })),
    } as any);
  });

  it('buildRerankPrompt() includes query, candidates, and JSON output constraint', () => {
    const prompt = buildRerankPrompt(
      'Higgs mass measurement',
      [
        { index: 0, content: 'The Higgs boson mass is measured to be 125 GeV.', source: 'p1:introduction' },
        { index: 1, content: 'We discuss event selection and background.', source: 'p1:method' },
      ],
      1
    );

    expect(prompt).toContain('Query: Higgs mass measurement');
    expect(prompt).toContain('Candidates:');
    expect(prompt).toContain('- [0] (p1:introduction)');
    expect(prompt).toContain('- [1] (p1:method)');
    expect(prompt).toContain('Return ONLY a JSON array');
    expect(prompt).toContain('untrusted evidence');
    expect(prompt).toContain('top 1');
  });

  it("rerankWithLLM() in client mode returns client_continuation (no internal call)", async () => {
    const res = await rerankWithLLM({
      query: 'Higgs mass measurement',
      candidates: [
        { index: 0, content: 'The Higgs boson mass is measured to be 125 GeV.', source: 'p1:introduction' },
      ],
      config: {
        enabled: true,
        llm_mode: 'client',
        rerank_top_k: 30,
        output_top_n: 10,
        max_chunk_chars: 500,
      },
      llm_mode: 'client',
    });

    expect(res.mode_used).toBe('client');
    expect(res.ranked_indices).toEqual([]);
    expect('client_continuation' in res && res.client_continuation.steps[0]?.expected_format).toBe('json_array');
    expect(vi.mocked(createLLMClient)).not.toHaveBeenCalled();
  });

  it('rerankWithLLM() in internal mode calls internal LLM and parses indices', async () => {
    const mockClient = {
      provider: 'openai',
      model: 'mock-model',
      generate: vi.fn(async () => ''),
      generateWithMetadata: vi.fn(async () => ({ content: '[2, 0, 1]', latency_ms: 0, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })),
    };
    vi.mocked(createLLMClient).mockReturnValue(mockClient as any);

    const res = await rerankWithLLM({
      query: 'Higgs mass measurement',
      candidates: [
        { index: 0, content: 'Candidate 0', source: 'p1:introduction' },
        { index: 1, content: 'Candidate 1', source: 'p1:results' },
        { index: 2, content: 'Candidate 2', source: 'p2:results' },
      ],
      config: {
        enabled: true,
        llm_mode: 'internal',
        rerank_top_k: 30,
        output_top_n: 10,
        max_chunk_chars: 500,
      },
      llm_mode: 'internal',
    });

    expect(res.mode_used).toBe('internal');
    expect(res.ranked_indices).toEqual([2, 0, 1]);
    expect(vi.mocked(createLLMClient)).toHaveBeenCalledTimes(1);
    expect(mockClient.generateWithMetadata).toHaveBeenCalledTimes(1);
  });

  it('parseRankingResult() handles JSON array and JSON object forms', () => {
    expect(parseRankingResult('[3, 1, 7, 2, 5]')).toEqual([3, 1, 7, 2, 5]);
    expect(parseRankingResult('```json\n[2, 0, 1]\n```')).toEqual([2, 0, 1]);
    expect(parseRankingResult('{"ranked_indices":[1,"2",2,5,-1]}')).toEqual([1, 2, 5]);
  });

  it('integration: retrieve() applies LLM rerank to reorder BM25 results', async () => {
    const chunkA = makeChunk('a', 'The Higgs boson mass is measured to be 125 GeV.');
    const chunkB = makeChunk('b', 'We study detector calibration procedures.');
    const index = buildIndex([chunkA, chunkB]);

    const mockClient = {
      provider: 'openai',
      model: 'mock-model',
      generate: vi.fn(async () => ''),
      generateWithMetadata: vi.fn(async () => ({ content: '[1, 0]', latency_ms: 0 })),
    };
    vi.mocked(createLLMClient).mockReturnValue(mockClient as any);

    const res = await retrieve(
      {
        query: 'Higgs mass',
        keywords: [],
        top_k: 2,
        reranker: {
          mode: 'llm',
          llm: {
            enabled: true,
            llm_mode: 'internal',
            rerank_top_k: 2,
            output_top_n: 2,
            max_chunk_chars: 500,
          },
        },
      },
      index
    );

    expect(res.chunks[0].id).toBe('b');
    expect(res.chunks[1].id).toBe('a');
  });

  it('retrieve() in client rerank mode preserves requested top_k (no indices yet)', async () => {
    const chunkA = makeChunk('a', 'The Higgs boson mass is measured to be 125 GeV.');
    const chunkB = makeChunk('b', 'We study detector calibration procedures.');
    const index = buildIndex([chunkA, chunkB]);

    await expect(
      retrieve(
        {
          query: 'Higgs mass',
          keywords: [],
          top_k: 2,
          reranker: {
            mode: 'llm',
            llm: {
              enabled: true,
              llm_mode: 'client',
              rerank_top_k: 2,
              output_top_n: 1,
              max_chunk_chars: 500,
            },
          },
        },
        index
      )
    ).rejects.toThrow(/llm_mode=client/i);

    expect(vi.mocked(createLLMClient)).not.toHaveBeenCalled();
  });

  it('retrieve() fails fast when internal LLM rerank throws (no BM25 fallback)', async () => {
    const chunkA = makeChunk('a', 'The Higgs boson mass is measured to be 125 GeV.');
    const chunkB = makeChunk('b', 'We study detector calibration procedures.');
    const index = buildIndex([chunkA, chunkB]);

    vi.mocked(createLLMClient).mockReturnValue({
      provider: 'openai',
      model: 'mock-model',
      generate: vi.fn(async () => ''),
      generateWithMetadata: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as any);

    await expect(
      retrieve(
        {
          query: 'Higgs mass',
          keywords: [],
          top_k: 2,
          reranker: {
            mode: 'llm',
            llm: {
              enabled: true,
              llm_mode: 'internal',
              rerank_top_k: 2,
              output_top_n: 2,
              max_chunk_chars: 500,
            },
          },
        },
        index
      )
    ).rejects.toThrow(/no BM25 fallback/i);
  });

  it('retrieve() does not drop results when reranker numeric config is NaN', async () => {
    const chunkA = makeChunk('a', 'The Higgs boson mass is measured to be 125 GeV.');
    const chunkB = makeChunk('b', 'We study detector calibration procedures.');
    const index = buildIndex([chunkA, chunkB]);

    const mockClient = {
      provider: 'openai',
      model: 'mock-model',
      generate: vi.fn(async () => ''),
      generateWithMetadata: vi.fn(async () => ({ content: '[1, 0]', latency_ms: 0 })),
    };
    vi.mocked(createLLMClient).mockReturnValue(mockClient as any);

    const res = await retrieve(
      {
        query: 'Higgs mass',
        keywords: [],
        top_k: 2,
        reranker: {
          mode: 'llm',
          llm: {
            enabled: true,
            llm_mode: 'internal',
            rerank_top_k: Number.NaN,
            output_top_n: Number.NaN,
            max_chunk_chars: 500,
          },
        },
      },
      index
    );

    expect(res.chunks).toHaveLength(2);
  });
});
