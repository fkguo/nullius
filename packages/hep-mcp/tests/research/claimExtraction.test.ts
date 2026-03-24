import { describe, expect, it, vi } from 'vitest';
import { extractClaimsFromAbstract } from '../../src/core/semantics/claimExtraction.js';

describe('extractClaimsFromAbstract', () => {
  it('uses sampling metadata without adding provider routing hints', async () => {
    const abstract = 'We observe a 5 sigma excess in channel A with improved detector calibration and cross-checks.';
    const createMessage = vi.fn().mockResolvedValue({
      model: 'mock-sem02',
      role: 'assistant',
      content: [{
        type: 'text',
        text: JSON.stringify({
          claims: [{
            claim_id: 'c1',
            claim_text: 'LLM extracted claim for channel A.',
            context_before: '',
            context_after: '',
            evidence_level: 'discovery',
            sigma_level: 5,
          }],
        }),
      }],
    });

    const second = await extractClaimsFromAbstract(abstract, { createMessage }, {
      prompt_version: 'sem02_claim_extraction_cache_switch_v1',
      max_claims: 2,
    });

    expect(createMessage).toHaveBeenCalledTimes(1);
    const samplingRequest = createMessage.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> } | undefined;
    expect(samplingRequest).toMatchObject({
      metadata: {
        module: 'sem02_claim_extraction',
        tool: 'inspire_grade_evidence',
        prompt_version: 'sem02_claim_extraction_cache_switch_v1',
        risk_level: 'read',
        cost_class: 'high',
      },
    });
    expect(samplingRequest?.metadata).not.toHaveProperty('route');
    expect(samplingRequest?.metadata).not.toHaveProperty('model');
    expect(second[0]?.used_fallback).toBe(false);
    expect(second[0]?.claim_text).toBe('LLM extracted claim for channel A.');
  });

  it('fails closed when MCP sampling is unavailable', async () => {
    const abstract = 'We measure the branching ratio of process B using a high-purity control sample and detector corrections.';
    await expect(extractClaimsFromAbstract(abstract, {}, {
      prompt_version: 'sem02_claim_extraction_retry_v1',
      max_claims: 2,
    })).rejects.toThrow(/sampling support/i);
  });

  it('fails closed on invalid sampling responses', async () => {
    const abstract = [
      'We observe a statistically significant excess in channel A with improved detector calibration',
      'We measure the branching ratio of process B using a high-purity control sample',
      'We detect a correlated structure in channel C after background subtraction',
    ].join('. ') + '.';
    const createMessage = vi.fn().mockResolvedValue({
      model: 'mock-sem02',
      role: 'assistant',
      content: [{ type: 'text', text: 'not-json' }],
    });

    await expect(extractClaimsFromAbstract(abstract, { createMessage }, {
      prompt_version: 'sem02_claim_extraction_max_claims_v1',
      max_claims: 1,
    })).rejects.toThrow(/invalid response/i);
  });
});
