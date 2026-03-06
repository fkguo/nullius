import { describe, expect, it } from 'vitest';
import { extractSigmaLevel } from '../../src/core/semantics/citationStanceHeuristics.js';

describe('extractSigmaLevel', () => {
  it('keeps valid sigma mentions', () => {
    expect(extractSigmaLevel('We report a 5 sigma excess in channel A.')).toBe(5);
    expect(extractSigmaLevel('The local significance of 3.2 supports the excess.')).toBe(3.2);
  });

  it('drops malformed or absurd sigma values as parser guardrails', () => {
    expect(extractSigmaLevel('A malformed template mentions 999 sigma confidence.')).toBeUndefined();
    expect(extractSigmaLevel('The fit corresponds to -3 sigma after sign conventions.')).toBeUndefined();
  });
});
