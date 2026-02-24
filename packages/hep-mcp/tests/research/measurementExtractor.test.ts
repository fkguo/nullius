/**
 * Unit tests for measurementExtractor patterns
 * Tests regex patterns for extracting measurements from text
 */

import { describe, it, expect } from 'vitest';

// Re-create the patterns for testing (they are not exported from the module)
const UNITS_PATTERN = '(?:GeV|MeV|keV|eV|TeV|fm|pb|fb|mb|nb|Hz|s|m|kg|K|rad)?';

const SYMMETRIC_PATTERN = new RegExp(
  `(\\d+\\.?\\d*)\\s*(?:\\\\pm|±|\\+/-|\\+\\/-|\\+-|\\$\\\\pm\\$)\\s*(\\d+\\.?\\d*)\\s*${UNITS_PATTERN}`,
  'gi'
);

const ASYMMETRIC_PATTERN = new RegExp(
  `(\\d+\\.?\\d*)\\s*\\+(\\d+\\.?\\d*)\\s*-(\\d+\\.?\\d*)\\s*${UNITS_PATTERN}`,
  'gi'
);

const PARENTHETICAL_PATTERN = new RegExp(
  `(\\d+\\.\\d+)\\((\\d+)\\)\\s*${UNITS_PATTERN}`,
  'gi'
);

const SCIENTIFIC_PATTERN = new RegExp(
  `\\(?\\s*(\\d+\\.?\\d*)\\s*(?:\\\\pm|±|\\+/-)\\s*(\\d+\\.?\\d*)\\s*\\)?\\s*(?:\\\\times|×|\\*|x)\\s*10\\^?\\{?(-?\\d+)\\}?`,
  'gi'
);

const LATEX_ASYMMETRIC_PATTERN = new RegExp(
  `\\$?(\\d+\\.?\\d*)\\s*(?:\\^\\{\\+?(\\d+\\.?\\d*)\\}\\s*_\\{-?(\\d+\\.?\\d*)\\}|_\\{-?(\\d+\\.?\\d*)\\}\\s*\\^\\{\\+?(\\d+\\.?\\d*)\\})\\s*${UNITS_PATTERN}\\$?`,
  'gi'
);

describe('Measurement Extraction Patterns', () => {
  describe('SYMMETRIC_PATTERN', () => {
    it('should match value ± uncertainty', () => {
      const text = '80.4 ± 0.1 GeV';
      const match = SYMMETRIC_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('80.4');
      expect(match![2]).toBe('0.1');
    });

    it('should match value \\pm uncertainty', () => {
      const text = '80.4 \\pm 0.1 GeV';
      SYMMETRIC_PATTERN.lastIndex = 0;
      const match = SYMMETRIC_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('80.4');
      expect(match![2]).toBe('0.1');
    });

    it('should match value +/- uncertainty', () => {
      const text = '125.09 +/- 0.24';
      SYMMETRIC_PATTERN.lastIndex = 0;
      const match = SYMMETRIC_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('125.09');
      expect(match![2]).toBe('0.24');
    });

    it('should match without unit', () => {
      const text = '0.1181 ± 0.0011';
      SYMMETRIC_PATTERN.lastIndex = 0;
      const match = SYMMETRIC_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('0.1181');
      expect(match![2]).toBe('0.0011');
    });
  });

  describe('ASYMMETRIC_PATTERN', () => {
    it('should match value +upper -lower', () => {
      const text = '125.10 +0.14 -0.11 GeV';
      const match = ASYMMETRIC_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('125.10');
      expect(match![2]).toBe('0.14');
      expect(match![3]).toBe('0.11');
    });

    it('should match integer values', () => {
      const text = '125 +2 -3 MeV';
      ASYMMETRIC_PATTERN.lastIndex = 0;
      const match = ASYMMETRIC_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('125');
      expect(match![2]).toBe('2');
      expect(match![3]).toBe('3');
    });
  });

  describe('PARENTHETICAL_PATTERN', () => {
    it('should match value(uncertainty)', () => {
      const text = '0.1181(11)';
      const match = PARENTHETICAL_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('0.1181');
      expect(match![2]).toBe('11');
    });

    it('should match with unit', () => {
      const text = '125.10(14) GeV';
      PARENTHETICAL_PATTERN.lastIndex = 0;
      const match = PARENTHETICAL_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('125.10');
      expect(match![2]).toBe('14');
    });
  });

  describe('SCIENTIFIC_PATTERN', () => {
    it('should match (value ± uncertainty) × 10^exponent', () => {
      const text = '(1.23 ± 0.05) × 10^-3';
      const match = SCIENTIFIC_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('1.23');
      expect(match![2]).toBe('0.05');
      expect(match![3]).toBe('-3');
    });

    it('should match with \\times', () => {
      const text = '(2.5 ± 0.3) \\times 10^{-5}';
      SCIENTIFIC_PATTERN.lastIndex = 0;
      const match = SCIENTIFIC_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('2.5');
      expect(match![2]).toBe('0.3');
      expect(match![3]).toBe('-5');
    });
  });

  describe('LATEX_ASYMMETRIC_PATTERN', () => {
    it('should match $value^{+upper}_{-lower}$', () => {
      const text = '$80.4^{+0.1}_{-0.2}$';
      const match = LATEX_ASYMMETRIC_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('80.4');
      expect(match![2]).toBe('0.1');
      expect(match![3]).toBe('0.2');
    });

    it('should match without dollar signs', () => {
      const text = '80.4^{+0.1}_{-0.2}';
      LATEX_ASYMMETRIC_PATTERN.lastIndex = 0;
      const match = LATEX_ASYMMETRIC_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('80.4');
      expect(match![2]).toBe('0.1');
      expect(match![3]).toBe('0.2');
    });

    it('should match reversed order $value_{-lower}^{+upper}$', () => {
      const text = '$80.4_{-0.2}^{+0.1}$';
      LATEX_ASYMMETRIC_PATTERN.lastIndex = 0;
      const match = LATEX_ASYMMETRIC_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('80.4');
      // For reversed order, groups 4 and 5 are used
      expect(match![4]).toBe('0.2');
      expect(match![5]).toBe('0.1');
    });

    it('should match with unit', () => {
      const text = '$125.10^{+0.14}_{-0.11}$ GeV';
      LATEX_ASYMMETRIC_PATTERN.lastIndex = 0;
      const match = LATEX_ASYMMETRIC_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('125.10');
      expect(match![2]).toBe('0.14');
      expect(match![3]).toBe('0.11');
    });

    it('should match integer values', () => {
      const text = '$125^{+2}_{-3}$';
      LATEX_ASYMMETRIC_PATTERN.lastIndex = 0;
      const match = LATEX_ASYMMETRIC_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('125');
      expect(match![2]).toBe('2');
      expect(match![3]).toBe('3');
    });

    it('should match without plus sign prefix', () => {
      const text = '$80.4^{0.1}_{-0.2}$';
      LATEX_ASYMMETRIC_PATTERN.lastIndex = 0;
      const match = LATEX_ASYMMETRIC_PATTERN.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('80.4');
      expect(match![2]).toBe('0.1');
      expect(match![3]).toBe('0.2');
    });
  });

  describe('Edge cases', () => {
    it('should handle multiple measurements in text', () => {
      const text = 'The mass is 80.4 ± 0.1 GeV and width is 2.1 ± 0.2 GeV';
      SYMMETRIC_PATTERN.lastIndex = 0;

      const matches: string[][] = [];
      let match;
      while ((match = SYMMETRIC_PATTERN.exec(text)) !== null) {
        matches.push([match[1], match[2]]);
      }

      expect(matches.length).toBe(2);
      expect(matches[0]).toEqual(['80.4', '0.1']);
      expect(matches[1]).toEqual(['2.1', '0.2']);
    });

    it('should not match invalid formats', () => {
      const invalidTexts = [
        '80.4 - 0.1',  // Missing plus
        '80.4 0.1',    // No operator
        'abc ± xyz',   // Non-numeric
      ];

      for (const text of invalidTexts) {
        SYMMETRIC_PATTERN.lastIndex = 0;
        const match = SYMMETRIC_PATTERN.exec(text);
        expect(match).toBeNull();
      }
    });
  });
});
