import { describe, expect, it, vi } from 'vitest';

import { gradeClaimAgainstEvidenceBundle } from '../../src/core/semantics/evidenceClaimGrading.js';
import type { ClaimEvidenceItem, ExtractedClaimV1 } from '../../src/core/semantics/claimTypes.js';

function buildClaim(claimId: string, claimText: string): ExtractedClaimV1 {
  return {
    claim_id: claimId,
    claim_text: claimText,
    source_context: { before: '', after: '' },
    evidence_level: 'evidence',
    provenance: {
      backend: 'heuristic',
      used_fallback: false,
      prompt_version: 'test',
      input_hash: `test:${claimId}`,
    },
    used_fallback: false,
  };
}

describe('claim bundle grading', () => {
  it('uses bundle-level LLM adjudication for mixed evidence bundles', async () => {
    const evidenceItems: ClaimEvidenceItem[] = [
      { evidence_ref: 'paper:a', evidence_text: 'Our update agrees with the HQET expectation.', source: 'confirmation_search' },
      { evidence_ref: 'paper:b', evidence_text: 'A reanalysis finds strong tension with the quoted decay rate.', source: 'comment_search' },
    ];
    const responses = [
      { stance: 'supported', confidence: 0.85, reason_code: 'direct_support' },
      { stance: 'conflicting', confidence: 0.87, reason_code: 'conflicting_evidence' },
    ];

    const createMessage = vi.fn().mockImplementation(async params => {
      const moduleName = String((params.metadata as Record<string, unknown> | undefined)?.module ?? '');
      if (moduleName === 'sem03_stance_engine') {
        return {
          model: 'mock-sem03',
          role: 'assistant',
          content: [{ type: 'text', text: JSON.stringify({ aggregate_stance: 'mixed', aggregate_confidence: 0.89, reason_code: 'conflicting_evidence', abstain: false }) }],
        };
      }
      return { model: 'mock-sem02', role: 'assistant', content: [{ type: 'text', text: JSON.stringify(responses.shift()) }] };
    });

    const grade = await gradeClaimAgainstEvidenceBundle(
      buildClaim('c1', 'The decay rate is compatible with the HQET expectation.'),
      evidenceItems,
      { createMessage },
      { prompt_version: 'sem02_test_v1', bundle_prompt_version: 'sem03_test_v1' },
    );

    expect(grade.aggregate_stance).toBe('mixed');
    expect(grade.reason_code).toBe('conflicting_evidence');
    expect(grade.provenance.prompt_version).toBe('sem03_test_v1');
    expect(grade.used_fallback).toBe(false);
    expect(createMessage).toHaveBeenCalledTimes(3);
    const bundleRequest = createMessage.mock.calls
      .map(call => call[0] as { metadata?: Record<string, unknown> })
      .find(call => call.metadata?.module === 'sem03_stance_engine');
    expect(bundleRequest).toMatchObject({
      metadata: {
        module: 'sem03_stance_engine',
        tool: 'inspire_grade_evidence',
        prompt_version: 'sem03_test_v1',
        risk_level: 'read',
        cost_class: 'high',
      },
    });
  });

  it('fails closed when bundle adjudication is invalid', async () => {
    const createMessage = vi.fn().mockImplementation(async params => {
      const moduleName = String((params.metadata as Record<string, unknown> | undefined)?.module ?? '');
      if (moduleName === 'sem03_stance_engine') {
        return { model: 'mock-sem03', role: 'assistant', content: [{ type: 'text', text: 'not json' }] };
      }
      return {
        model: 'mock-sem02',
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({ stance: 'weak_support', confidence: 0.63, reason_code: 'hedged_support' }) }],
      };
    });

    await expect(gradeClaimAgainstEvidenceBundle(
      buildClaim('c2', 'The EFT coefficient may be positive.'),
      [{ evidence_ref: 'paper:c', evidence_text: 'The fit may prefer a positive coefficient, although zero remains allowed.', source: 'confirmation_search' }],
      { createMessage },
      { prompt_version: 'sem02_test_v1', bundle_prompt_version: 'sem03_test_v1' },
    )).rejects.toThrow(/invalid response/i);
  });

  it('keeps abstentions calibrated for same-topic but different-claim evidence', async () => {
    const createMessage = vi.fn().mockImplementation(async params => {
      const moduleName = String((params.metadata as Record<string, unknown> | undefined)?.module ?? '');
      if (moduleName === 'sem03_stance_engine') {
        return {
          model: 'mock-sem03',
          role: 'assistant',
          content: [{ type: 'text', text: JSON.stringify({ aggregate_stance: 'not_supported', aggregate_confidence: 0.81, reason_code: 'same_topic_different_claim', abstain: true }) }],
        };
      }
      return {
        model: 'mock-sem02',
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({ stance: 'not_supported', confidence: 0.18, reason_code: 'same_topic_different_claim' }) }],
      };
    });

    const grade = await gradeClaimAgainstEvidenceBundle(
      buildClaim('c3', 'The mass of X(3872) is below 3872 MeV.'),
      [{ evidence_ref: 'paper:d', evidence_text: 'We present a new width determination for X(3872) with improved systematics.', source: 'comment_search' }],
      { createMessage },
      { prompt_version: 'sem02_test_v1', bundle_prompt_version: 'sem03_test_v1' },
    );

    expect(grade.aggregate_stance).toBe('not_supported');
    expect(grade.aggregate_confidence).toBeLessThanOrEqual(0.3);
    expect(grade.reason_code).toBe('same_topic_different_claim');
  });
});
