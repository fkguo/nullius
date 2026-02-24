/**
 * Stance Detection Tests
 *
 * Basic unit tests for the stance detection module.
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeTextStance,
  detectOwnership,
  detectHedges,
  extractSignificance,
  isAfterContrast,
  matchPatterns,
  tokenize,
  isInNegationScope,
  splitIntoSentences,
} from '../../src/tools/research/stance/index.js';

describe('Stance Detection', () => {
  describe('analyzeTextStance', () => {
    it('should detect confirming stance', () => {
      const text = 'Our result is consistent with the previous measurement.';
      const result = analyzeTextStance(text);
      expect(result.stance).toBe('confirming');
    });

    it('should detect contradicting stance', () => {
      const text = 'This result rules out the model proposed earlier.';
      const result = analyzeTextStance(text);
      expect(result.stance).toBe('contradicting');
    });

    it('should return neutral for empty input', () => {
      const result = analyzeTextStance('');
      expect(result.stance).toBe('neutral');
      expect(result.needsLLMReview).toBe(true);
    });
  });

  describe('Negation handling', () => {
    it('should handle "not inconsistent with" as confirming', () => {
      const text = 'Our result is not inconsistent with the previous measurement.';
      const result = analyzeTextStance(text);
      expect(result.stance).toBe('confirming');
    });

    it('should handle "no tension" as confirming', () => {
      const text = 'We find no significant tension with the SM prediction.';
      const result = analyzeTextStance(text);
      expect(result.stance).toBe('confirming');
    });
  });

  describe('Hedge detection', () => {
    it('should detect hedge words', () => {
      const { hedges, totalDowngrade } = detectHedges('This may be consistent with earlier work.');
      expect(hedges.length).toBeGreaterThan(0);
      expect(totalDowngrade).toBeGreaterThan(0);
    });
  });

  describe('Ownership detection', () => {
    it('should detect "ours" ownership', () => {
      const result = detectOwnership('We present a new measurement.');
      expect(result.label).toBe('ours');
    });

    it('should detect "theirs" ownership', () => {
      const result = detectOwnership('Ref. [1] reported a value of 5.0.');
      expect(result.label).toBe('theirs');
    });
  });

  describe('Statistical significance', () => {
    it('should extract sigma level', () => {
      const sig = extractSignificance('The result excludes the hypothesis at 5σ significance.');
      expect(sig).toBeDefined();
      expect(sig?.sigma).toBe(5);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1b Tests: Extractor and Resolver
// ─────────────────────────────────────────────────────────────────────────────

import {
  replaceCitesWithPlaceholders,
  cleanLatexPreservingPlaceholders,
  extractCitationContextsFromRegex,
  normalizeArxivId,
  normalizeJournal,
} from '../../src/tools/research/stance/index.js';

describe('Citation Context Extractor', () => {
  describe('replaceCitesWithPlaceholders', () => {
    it('should replace single cite', () => {
      const latex = 'This is consistent with \\cite{smith2020}.';
      const { result, keyToPlaceholders } = replaceCitesWithPlaceholders(latex);

      expect(result).toContain('__CITE_');
      expect(keyToPlaceholders.has('smith2020')).toBe(true);
    });

    it('should handle multi-cite', () => {
      const latex = 'See Refs.~\\cite{a,b,c} for details.';
      const { keyToPlaceholders } = replaceCitesWithPlaceholders(latex);

      expect(keyToPlaceholders.has('a')).toBe(true);
      expect(keyToPlaceholders.has('b')).toBe(true);
      expect(keyToPlaceholders.has('c')).toBe(true);
    });
  });
});

describe('Resolver', () => {
  describe('normalizeArxivId', () => {
    it('should normalize new format', () => {
      expect(normalizeArxivId('2301.12345')).toBe('2301.12345');
      expect(normalizeArxivId('2301.12345v2')).toBe('2301.12345');
    });

    it('should handle URL format', () => {
      expect(normalizeArxivId('https://arxiv.org/abs/2301.12345')).toBe('2301.12345');
    });

    it('should handle arxiv: prefix', () => {
      expect(normalizeArxivId('arxiv:2301.12345')).toBe('2301.12345');
    });

    it('should return null for invalid', () => {
      expect(normalizeArxivId('invalid')).toBeNull();
    });
  });

  describe('normalizeJournal', () => {
    it('should normalize PRL', () => {
      expect(normalizeJournal('Phys. Rev. Lett.')).toBe('Phys.Rev.Lett.');
      expect(normalizeJournal('PRL')).toBe('Phys.Rev.Lett.');
    });

    it('should normalize JHEP', () => {
      expect(normalizeJournal('JHEP')).toBe('JHEP');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bibitem Parser Tests
// ─────────────────────────────────────────────────────────────────────────────

import {
  extractIdentifiersFromBibitem,
  isBblContent,
  extractBibitemsFromBbl,
} from '../../src/tools/research/stance/index.js';

describe('Bibitem Parser', () => {
  describe('extractIdentifiersFromBibitem', () => {
    it('should extract arXiv ID', () => {
      const text = 'Author et al., arXiv:2301.12345';
      const ids = extractIdentifiersFromBibitem(text);
      expect(ids.eprint).toBe('2301.12345');
    });

    it('should extract old-style arXiv ID (hep-ph/XXXXXXX)', () => {
      const text = 'Author, arXiv:hep-ph/0305260';
      const ids = extractIdentifiersFromBibitem(text);
      expect(ids.eprint).toBe('hep-ph/0305260');
    });

    it('should extract DOI', () => {
      const text = 'Author, Title, doi:10.1007/JHEP11(2024)121';
      const ids = extractIdentifiersFromBibitem(text);
      expect(ids.doi).toBe('10.1007/JHEP11(2024)121');
    });

    it('should clean trailing brace from DOI', () => {
      // From RevTeX format: \href{\doibase 10.1103/PhysRevD.89.055009}
      const text = 'doi:10.1103/PhysRevD.89.055009}';
      const ids = extractIdentifiersFromBibitem(text);
      expect(ids.doi).toBe('10.1103/PhysRevD.89.055009');
    });

    it('should extract PRL journal info', () => {
      const text = 'Author, Phys. Rev. Lett. 123, 456 (2024)';
      const ids = extractIdentifiersFromBibitem(text);
      expect(ids.journal).toBe('Phys.Rev.Lett.');
      expect(ids.volume).toBe('123');
      expect(ids.page).toBe('456');
    });

    it('should extract JHEP journal info', () => {
      const text = 'Author, JHEP 11 (2024) 121';
      const ids = extractIdentifiersFromBibitem(text);
      expect(ids.journal).toBe('JHEP');
      expect(ids.volume).toBe('11');
      expect(ids.year).toBe('2024');
      expect(ids.page).toBe('121');
    });

    // Simple format: Journal Volume (Year) Page
    it('should extract simple format: Phys. Rev. D 22 (1980) 1652', () => {
      const text = 'T.-M. Yan, Phys. Rev. D 22 (1980) 1652';
      const ids = extractIdentifiersFromBibitem(text);
      expect(ids.journal).toBe('Phys.Rev.D');
      expect(ids.volume).toBe('22');
      expect(ids.page).toBe('1652');
    });

    it('should extract simple format: Z. Phys. C 8 (1981) 43', () => {
      const text = 'V. A. Novikov and M. A. Shifman, Z. Phys. C 8 (1981) 43';
      const ids = extractIdentifiersFromBibitem(text);
      expect(ids.journal).toBe('Z.Phys.C');
      expect(ids.volume).toBe('8');
      expect(ids.page).toBe('43');
    });

    it('should extract simple format: Nucl. Phys. A 620 (1997) 438', () => {
      const text = 'J. A. Oller and E. Oset, Nucl. Phys. A 620 (1997) 438';
      const ids = extractIdentifiersFromBibitem(text);
      expect(ids.journal).toBe('Nucl.Phys.A');
      expect(ids.volume).toBe('620');
      expect(ids.page).toBe('438');
    });

    // RevTeX format with \bibinfo macros (with spaces)
    it('should extract RevTeX format with \\bibinfo macros', () => {
      // Simplified RevTeX format - tests that \bibinfo {field} {value} with spaces works
      const text = `\\bibinfo {journal} {Phys. Rev. Lett.} \\textbf {\\bibinfo {volume} {110}}, \\bibinfo {pages} {222001}`;
      const ids = extractIdentifiersFromBibitem(text);
      expect(ids.journal).toBe('Phys.Rev.Lett.');
      expect(ids.volume).toBe('110');
      expect(ids.page).toBe('222001');
    });

    // \Eprint format
    it('should extract \\Eprint format arXiv ID', () => {
      const text = `\\Eprint {http://arxiv.org/abs/1302.6269} {arXiv:1302.6269 [hep-ex]}`;
      const ids = extractIdentifiersFromBibitem(text);
      expect(ids.eprint).toBe('1302.6269');
    });

    it('should extract \\eprint{} macro', () => {
      const text = `Author, \\eprint{hep-ph/0412300}`;
      const ids = extractIdentifiersFromBibitem(text);
      expect(ids.eprint).toBe('hep-ph/0412300');
    });
  });

  describe('isBblContent', () => {
    it('should detect bbl content', () => {
      expect(isBblContent('\\begin{thebibliography}{99}')).toBe(true);
      expect(isBblContent('regular latex')).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 Tests: LLM Review and Contrast Detection
// ─────────────────────────────────────────────────────────────────────────────

import {
  generateRequestId,
  calculatePriority,
  detectTriggers,
  createReviewRequest,
  applyContrastWeights,
} from '../../src/tools/research/stance/index.js';
import type { CitationContextWithStance, SentenceStanceResult } from '../../src/tools/research/stance/index.js';

describe('LLM Review Module (Phase 5)', () => {
  const mockContext: CitationContextWithStance = {
    context: {
      citekey: 'test2024',
      sentence: 'This is consistent with previous work.',
      extendedContext: 'This is consistent with previous work. The results agree.',
      section: 'results',
      position: 100,
    },
    stance: {
      stance: 'confirming',
      confidence: 'low',
      needsLLMReview: true,
      scoreConfirm: 2,
      scoreContra: 0,
      hedges: [],
      matched: [],
      evidenceSentences: ['This is consistent with previous work.'],
      analyzedSentenceCount: 1,
      inputType: 'citation_context',
      isWeakSignal: false,
      layerUsed: 1,
      targetBinding: 'same_sentence',
      reviewScore: 3,
      hasComplexNegation: false,
      ownershipScore: { ours: 0, theirs: 0 },
    },
    resolvedRecid: '12345',
    resolutionMethod: 'inspire',
  };

  describe('generateRequestId', () => {
    it('should generate stable hash-based ID', () => {
      const id1 = generateRequestId(mockContext, '12345', 1);
      const id2 = generateRequestId(mockContext, '12345', 1);
      expect(id1).toBe(id2);
      expect(id1.length).toBe(16);
    });

    it('should generate different IDs for different layers', () => {
      const id1 = generateRequestId(mockContext, '12345', 1);
      const id2 = generateRequestId(mockContext, '12345', 2);
      expect(id1).not.toBe(id2);
    });
  });

  describe('calculatePriority', () => {
    it('should return higher priority for low confidence', () => {
      const priority = calculatePriority(mockContext, ['low_confidence']);
      expect(priority).toBeGreaterThanOrEqual(2);
    });
  });

  describe('detectTriggers', () => {
    it('should detect low_confidence trigger', () => {
      const triggers = detectTriggers(mockContext);
      expect(triggers).toContain('low_confidence');
    });

    it('should detect close_margin trigger', () => {
      const triggers = detectTriggers(mockContext, { confirming: 5, contradicting: 4.5 });
      expect(triggers).toContain('close_margin');
    });
  });

  describe('createReviewRequest', () => {
    it('should create request for context needing review', () => {
      const request = createReviewRequest(mockContext, '12345');
      expect(request).not.toBeNull();
      expect(request?.requestId).toBeDefined();
      expect(request?.reasons).toContain('low_confidence');
    });
  });
});

describe('Contrast Weight Application (Phase 5)', () => {
  describe('applyContrastWeights', () => {
    it('should increase weight for sentences after contrast', () => {
      const sentences: SentenceStanceResult[] = [
        { sentence: 'Before', index: 0, ownership: 'unknown', afterContrast: false,
          matchedRules: [], scoreConfirm: 2, scoreContra: 0, scoreHedge: 0 },
        { sentence: 'However, after', index: 1, ownership: 'unknown', afterContrast: true,
          matchedRules: [], scoreConfirm: 0, scoreContra: 2, scoreHedge: 0 },
      ];
      const weighted = applyContrastWeights(sentences);
      expect(weighted[1].scoreContra).toBeGreaterThan(2);
    });

    it('should decrease weight for sentences before contrast', () => {
      const sentences: SentenceStanceResult[] = [
        { sentence: 'Before', index: 0, ownership: 'unknown', afterContrast: false,
          matchedRules: [], scoreConfirm: 2, scoreContra: 0, scoreHedge: 0 },
        { sentence: 'However, after', index: 1, ownership: 'unknown', afterContrast: true,
          matchedRules: [], scoreConfirm: 0, scoreContra: 2, scoreHedge: 0 },
      ];
      const weighted = applyContrastWeights(sentences);
      expect(weighted[0].scoreConfirm).toBeLessThan(2);
    });
  });
});
