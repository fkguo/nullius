import { describe, expect, it, vi } from 'vitest';
import { extractClaimsFromAbstract } from '../../src/core/semantics/claimExtraction.js';

describe('extractClaimsFromAbstract', () => {
  it('does not reuse heuristic cache once MCP sampling becomes available', async () => {
    const abstract = 'We observe a 5 sigma excess in channel A with improved detector calibration and cross-checks.';
    const first = await extractClaimsFromAbstract(abstract, {}, {
      prompt_version: 'sem02_claim_extraction_cache_switch_v1',
      max_claims: 2,
    });

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

    expect(first[0]?.used_fallback).toBe(true);
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(second[0]?.used_fallback).toBe(false);
    expect(second[0]?.claim_text).toBe('LLM extracted claim for channel A.');
  });

  it('does not cache fallback results after a sampling failure', async () => {
    const abstract = 'We measure the branching ratio of process B using a high-purity control sample and detector corrections.';
    const failingCreateMessage = vi.fn().mockRejectedValue(new Error('sampling unavailable'));
    const fallback = await extractClaimsFromAbstract(abstract, { createMessage: failingCreateMessage }, {
      prompt_version: 'sem02_claim_extraction_retry_v1',
      max_claims: 2,
    });

    const succeedingCreateMessage = vi.fn().mockResolvedValue({
      model: 'mock-sem02',
      role: 'assistant',
      content: [{
        type: 'text',
        text: JSON.stringify({
          claims: [{
            claim_id: 'c1',
            claim_text: 'Retry path extracted claim for process B.',
            context_before: '',
            context_after: '',
            evidence_level: 'evidence',
            sigma_level: 3.2,
          }],
        }),
      }],
    });

    const retried = await extractClaimsFromAbstract(abstract, { createMessage: succeedingCreateMessage }, {
      prompt_version: 'sem02_claim_extraction_retry_v1',
      max_claims: 2,
    });

    expect(fallback[0]?.used_fallback).toBe(true);
    expect(succeedingCreateMessage).toHaveBeenCalledTimes(1);
    expect(retried[0]?.used_fallback).toBe(false);
    expect(retried[0]?.claim_text).toBe('Retry path extracted claim for process B.');
  });

  it('honors max_claims in heuristic fallback mode', async () => {
    const abstract = [
      'We observe a statistically significant excess in channel A with improved detector calibration',
      'We measure the branching ratio of process B using a high-purity control sample',
      'We detect a correlated structure in channel C after background subtraction',
    ].join('. ') + '.';

    const claims = await extractClaimsFromAbstract(abstract, {}, {
      prompt_version: 'sem02_claim_extraction_max_claims_v1',
      max_claims: 1,
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]?.claim_text).toContain('We observe');
  });
});
