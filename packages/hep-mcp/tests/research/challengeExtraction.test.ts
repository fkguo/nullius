import { MethodologyChallengeExtractionResultSchema } from '@autoresearch/shared';
import { describe, expect, it } from 'vitest';

import { extractMethodologyChallenges, renderMethodologyChallenges } from '../../src/tools/research/synthesis/challengeExtraction.js';
import { generateNarrativeSections } from '../../src/tools/research/synthesis/narrative.js';

describe('challenge extraction', () => {
  it('extracts structured methodological challenges from open-text evidence without narrative taxonomy authority', () => {
    const result = extractMethodologyChallenges(
      [{ recid: '1', title: 'Combined fit', success: true, methodology: 'The combined fit suffers from background subtraction issues.' }],
      [{
        paper_recid: '1',
        paper_title: 'Combined fit',
        success: true,
        integrated_assessment: { reliability_score: 0.4, risk_level: 'medium', key_concerns: ['fit instability across priors'], strengths: [], recommendations: [], verdict: 'mixed' },
      }],
    );

    expect(() => MethodologyChallengeExtractionResultSchema.parse(result)).not.toThrow();
    expect(result.status).toBe('detected');
    expect(result.challenge_types).toEqual(expect.arrayContaining(['background_control', 'fit_instability', 'cross_cutting_methodology']));
    expect(result.provenance.mode).toBe('open_text');
    const rendered = renderMethodologyChallenges(result);
    expect(rendered).toContain('"The combined fit suffers from background subtraction issues"');
    expect(rendered).toContain('"fit instability across priors"');
    expect(rendered).not.toContain('background control');
  });

  it('fails closed when only normalization hints remain and no open challenge sentence is available', () => {
    const result = extractMethodologyChallenges(
      [{ recid: '2', title: 'Coverage study', success: true, methodology: 'Control region modelling and detector acceptance set the dominant systematic budget.' }],
    );

    expect(result.status).toBe('uncertain');
    expect(result.challenge_types).toEqual([]);
    expect(result.provenance.mode).toBe('uncertain');
    const rendered = renderMethodologyChallenges(result);
    expect(rendered).toContain('too underspecified');
    expect(rendered).not.toContain('acceptance or coverage limits');
  });

  it('keeps no-challenge cases silent in narrative output', () => {
    const narrative = generateNarrativeSections(
      'convergent',
      'benchmark topic',
      [{ recid: '1', title: 'Stable workflow', success: true, methodology: 'A standard validated control strategy is used with no major methodological limitation identified.' }],
      [],
      { start: 2024, end: 2025 },
      new Map(),
      [],
      [],
    );

    expect(narrative.methodology_challenges).toBeUndefined();
  });
});
