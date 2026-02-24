import { describe, it, expect } from 'vitest';

import { buildWritingPacket } from '../../src/tools/writing/deepWriter/writingPacket.js';
import { checkDepth } from '../../src/tools/writing/verifier/depthChecker.js';
import { isSoftDepthConfig, type Claim } from '../../src/tools/writing/types.js';

function makeClaim(id: string, claim_text: string): Claim {
  return {
    claim_id: id,
    claim_no: id,
    claim_text,
    category: 'theoretical_prediction',
    status: 'emerging',
    paper_ids: ['111'],
    supporting_evidence: [],
    assumptions: [],
    scope: '',
    evidence_grade: 'theoretical',
    keywords: [],
    is_extractive: false,
  };
}

describe('Soft Depth Constraints', () => {
  it('buildWritingPacket uses SoftDepthConfig (not hard min_* constraints)', () => {
    const packet = buildWritingPacket(
      { number: '2', title: 'Test Section', type: 'body' },
      [makeClaim('c1', 'Test claim')],
      [],
      [],
      []
    );

    expect(isSoftDepthConfig(packet.constraints)).toBe(true);
    expect(packet.constraints).toHaveProperty('suggested_paragraphs');
    expect(packet.constraints).toHaveProperty('suggested_sentences_per_paragraph');
    expect(packet.constraints).toHaveProperty('optional_elements');
    expect(packet.constraints).not.toHaveProperty('min_paragraphs');
    expect(packet.constraints).not.toHaveProperty('required_elements');
  });

  it('checkDepth returns advisory level (good/acceptable/needs_improvement)', () => {
    const content = 'This result suggests important implications. However, further study is needed.';
    const constraints = {
      min_paragraphs: 0,
      min_sentences_per_paragraph: 0,
      required_elements: [],
      min_figures: 0,
      min_equations: 0,
      citation_density: 0,
      min_analysis_sentences: 1,
      min_comparison_sentences: 1,
    };

    const result = checkDepth(content, constraints);
    expect(result).toHaveProperty('advisory');
    expect(['good', 'acceptable', 'needs_improvement']).toContain(result.advisory);
  });

  it('checkDepth can be needs_improvement without throwing (soft workflow)', () => {
    const shortContent = 'Single sentence.';
    const constraints = {
      min_paragraphs: 0,
      min_sentences_per_paragraph: 0,
      required_elements: [],
      min_figures: 0,
      min_equations: 0,
      citation_density: 0,
      min_analysis_sentences: 3,
      min_comparison_sentences: 2,
    };

    const result = checkDepth(shortContent, constraints);
    expect(result.advisory).toBe('needs_improvement');
    expect(result.suggestions.length).toBeGreaterThan(0);
  });
});

