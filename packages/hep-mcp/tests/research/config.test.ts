/**
 * Research Config Tests
 * Tests for shared provider input validation
 */

import { describe, it, expect } from 'vitest';
import {
  validateRecid,
  validateRecids,
  validateMaxDepth,
  VALIDATION_LIMITS,
} from '../../src/tools/research/config.js';

describe('Parameter Validation', () => {
  describe('validateRecid', () => {
    it('should accept valid numeric recid', () => {
      expect(validateRecid('12345')).toBeNull();
      expect(validateRecid('1')).toBeNull();
      expect(validateRecid('999999')).toBeNull();
    });

    it('should reject empty string', () => {
      expect(validateRecid('')).toContain('empty');
    });

    it('should reject non-numeric recid', () => {
      expect(validateRecid('abc123')).toContain('numeric');
      expect(validateRecid('12.34')).toContain('numeric');
      expect(validateRecid('hep-th/0001001')).toContain('numeric');
    });

    it('should reject null/undefined', () => {
      expect(validateRecid(null as unknown as string)).toContain('non-empty');
      expect(validateRecid(undefined as unknown as string)).toContain('non-empty');
    });

    it('should reject excessively large recid', () => {
      const largeRecid = (VALIDATION_LIMITS.maxRecidValue + 1).toString();
      expect(validateRecid(largeRecid)).toContain('exceeds');
    });
  });

  describe('validateRecids', () => {
    it('should accept valid recids array', () => {
      expect(validateRecids(['123', '456', '789'])).toBeNull();
    });

    it('should reject empty array', () => {
      expect(validateRecids([])).toContain('empty');
    });

    it('should reject array with invalid recid', () => {
      expect(validateRecids(['123', 'abc', '456'])).toContain('numeric');
    });

    it('should accept many recids (no length cap)', () => {
      const manyRecids = Array.from({ length: 500 }, (_, i) => String(i + 1));
      expect(validateRecids(manyRecids)).toBeNull();
    });

    it('should reject non-array', () => {
      expect(validateRecids('123' as unknown as string[])).toContain('array');
    });
  });

  describe('validateMaxDepth', () => {
    it('should return default for undefined', () => {
      expect(validateMaxDepth(undefined)).toBe(2);
      expect(validateMaxDepth(undefined, 3)).toBe(3);
    });

    it('should clamp to minimum of 0', () => {
      expect(validateMaxDepth(0)).toBe(0);
      expect(validateMaxDepth(-5)).toBe(0);
    });

    it('should return valid values unchanged', () => {
      expect(validateMaxDepth(1)).toBe(1);
      expect(validateMaxDepth(3)).toBe(3);
      expect(validateMaxDepth(100)).toBe(100);
    });

    it('should handle NaN', () => {
      expect(validateMaxDepth(NaN)).toBe(2);
    });
  });
});
