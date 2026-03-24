import { describe, expect, it, vi } from 'vitest';
import { gradeClaimAgainstEvidenceBundle } from '../../src/core/semantics/evidenceClaimGrading.js';
import type { ClaimEvidenceItem, ExtractedClaimV1 } from '../../src/core/semantics/claimTypes.js';

const CLAIM: ExtractedClaimV1 = {
  claim_id: 'c1',
  claim_text: 'The branching ratio is consistent with the Standard Model prediction.',
  source_context: { before: '', after: '' },
  evidence_level: 'evidence',
  provenance: {
    backend: 'heuristic',
    used_fallback: false,
    prompt_version: 'test',
    input_hash: 'claim-hash',
  },
  used_fallback: false,
};

const EVIDENCE: ClaimEvidenceItem[] = [{
  evidence_ref: 'paper:100:abstract',
  evidence_text: 'Our updated determination is consistent with the Standard Model prediction.',
  recid: '100',
  title: 'Consistency paper',
  source: 'confirmation_search',
}];

describe('gradeClaimAgainstEvidenceBundle', () => {
  it('uses MCP sampling when available', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      model: 'mock-sem02',
      role: 'assistant',
      content: [{
        type: 'text',
        text: JSON.stringify({
          stance: 'supported',
          confidence: 0.92,
          reason_code: 'direct_support',
        }),
      }],
    });

    const grade = await gradeClaimAgainstEvidenceBundle(CLAIM, EVIDENCE, { createMessage });

    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage.mock.calls[0]?.[0]).toMatchObject({
      metadata: {
        module: 'sem02_claim_evidence_grading',
        tool: 'inspire_grade_evidence',
        prompt_version: 'sem02_claim_evidence_v1',
        risk_level: 'read',
        cost_class: 'high',
      },
    });
    expect(grade.aggregate_stance).toBe('supported');
    expect(grade.used_fallback).toBe(false);
    expect(grade.evidence_assessments[0]?.provenance.backend).toBe('mcp_sampling');
  });

  it('fails closed on invalid sampling response', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      model: 'mock-sem02',
      role: 'assistant',
      content: [{ type: 'text', text: 'not-json' }],
    });

    await expect(gradeClaimAgainstEvidenceBundle(CLAIM, [{
      ...EVIDENCE[0],
      evidence_text: 'This study discusses the same observable but does not compare with the prediction.',
    }], { createMessage })).rejects.toThrow(/invalid response/i);
  });

  it('aggregates support and conflict into mixed stance', async () => {
    const createMessage = vi.fn()
      .mockResolvedValueOnce({
        model: 'mock-sem02',
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({ stance: 'supported', confidence: 0.9, reason_code: 'direct_support' }) }],
      })
      .mockResolvedValueOnce({
        model: 'mock-sem02',
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify({ stance: 'conflicting', confidence: 0.88, reason_code: 'conflicting_evidence' }) }],
      })
      .mockResolvedValueOnce({
        model: 'mock-sem03',
        role: 'assistant',
        content: [{
          type: 'text',
          text: JSON.stringify({
            aggregate_stance: 'mixed',
            aggregate_confidence: 0.86,
            reason_code: 'conflicting_evidence',
            abstain: false,
          }),
        }],
      });

    const grade = await gradeClaimAgainstEvidenceBundle(CLAIM, [
      EVIDENCE[0],
      {
        evidence_ref: 'paper:101:abstract',
        evidence_text: 'Our lattice determination is in strong tension with the claimed branching ratio.',
        recid: '101',
        title: 'Tension paper',
        source: 'comment_search',
      },
    ], { createMessage });

    expect(grade.aggregate_stance).toBe('mixed');
    expect(grade.reason_code).toBe('conflicting_evidence');
    expect(createMessage).toHaveBeenCalledTimes(3);
  });
});
