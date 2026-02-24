import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DeepWriterAgent } from '../../src/tools/writing/llm/deepWriterAgent.js';
import { checkOriginality } from '../../src/tools/writing/originality/overlapDetector.js';
import { createLLMClient } from '../../src/tools/writing/llm/clients/index.js';
import type { WritingPacket } from '../../src/tools/writing/types.js';

vi.mock('../../src/tools/writing/llm/clients/index.js', () => {
  const mockClient = {
    provider: 'openai',
    model: 'mock-model',
    generate: vi.fn(async () => ''),
    generateWithMetadata: vi.fn(async () => ({ content: '', latency_ms: 0 })),
  };
  return { createLLMClient: vi.fn(() => mockClient) };
});

vi.mock('../../src/tools/writing/originality/overlapDetector.js', () => ({
  checkOriginality: vi.fn(),
}));

function makePacket(): WritingPacket {
  return {
    section: { number: '1', title: 'Intro', type: 'introduction' },
    assigned_claims: [
      {
        claim_id: 'c1',
        claim_no: '1',
        claim_text: 'Test claim',
        category: 'summary',
        status: 'consensus',
        paper_ids: ['123'],
        supporting_evidence: [
          {
            kind: 'text',
            evidence_id: 'ev1',
            paper_id: '123',
            fingerprint: 'fp1',
            locator: { latex_file: 'main.tex', section: '1', paragraph: 1 },
            stance: 'support',
            confidence: 'high',
            source: 'latex',
            quote: 'Evidence quote',
            extraction_method: 'heuristic',
          },
        ],
        assumptions: [],
        scope: 'global',
        evidence_grade: 'evidence',
        keywords: [],
        is_extractive: false,
      },
    ],
    assigned_assets: { figures: [], equations: [], tables: [] },
    allowed_citations: [],
    constraints: {
      min_paragraphs: 0,
      min_sentences_per_paragraph: 0,
      required_elements: [],
      min_figures: 0,
      min_equations: 0,
      citation_density: 99,
    },
    instructions: { core: [], prohibitions: [], requirements: [] },
    context: { language: 'en', glossary: [] },
  };
}

describe('DeepWriterAgent originality auto-fix retry', () => {
  beforeEach(() => {
    vi.mocked(createLLMClient).mockClear();
    vi.mocked(checkOriginality).mockReset();
  });

  it('retries when originality is warning and auto_fix_originality=true', async () => {
    const agent = new DeepWriterAgent({
      mode: 'internal',
      llmConfig: { provider: 'openai', model: 'mock', apiKey: 'test' },
      maxRetries: 3,
    });

    const mockClient = vi.mocked(createLLMClient).mock.results[0]?.value as any;
    expect(mockClient?.generateWithMetadata).toBeTypeOf('function');
    mockClient.generateWithMetadata
      .mockResolvedValueOnce({ content: 'Draft 1', latency_ms: 1 })
      .mockResolvedValueOnce({ content: 'Draft 2', latency_ms: 1 });

    vi.mocked(checkOriginality)
      .mockReturnValueOnce({
        level: 'warning',
        is_acceptable: true,
        needs_review: true,
        max_overlap: 0.3,
        flagged_count: 1,
      })
      .mockReturnValueOnce({
        level: 'acceptable',
        is_acceptable: true,
        needs_review: false,
        max_overlap: 0.05,
        flagged_count: 0,
      });

    const res = await agent.writeSection(makePacket(), {
      max_retries: 1,
      auto_fix_originality: true,
      auto_fix_citations: true,
    });

    expect(res.audit.attempts).toBe(2);
    expect(res.verify?.pass).toBe(true);
    expect(res.verify?.originalityLevel).toBe('acceptable');
    expect(mockClient.generateWithMetadata).toHaveBeenCalledTimes(2);
    expect(vi.mocked(checkOriginality)).toHaveBeenCalledTimes(2);
  });
});

