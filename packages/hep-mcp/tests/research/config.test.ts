/**
 * Research Config Tests
 * Tests for configurable algorithm parameters
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getConfig,
  updateConfig,
  resetConfig,
  canonicalizeUnit,
  detectUnitCategory,
  getConversionFactor,
  validateRecid,
  validateRecids,
  validateMaxDepth,
  VALIDATION_LIMITS,
} from '../../src/tools/research/config.js';

describe('Research Config', () => {
  beforeEach(() => {
    resetConfig();
  });

  describe('getConfig', () => {
    it('should return default config', () => {
      const config = getConfig();

      expect(config.weights.citation).toBe(0.40);
      expect(config.weights.age).toBe(0.25);
      expect(config.weights.influence).toBe(0.20);
      expect(config.weights.quality).toBe(0.15);
    });

    it('should return default thresholds', () => {
      const config = getConfig();

      expect(config.thresholds.highInfluenceCitationsPerYear).toBe(50);
      expect(config.thresholds.seminalMinAge).toBe(10);
      expect(config.thresholds.seminalMinCitations).toBe(200);
      expect(config.thresholds.emergingMinAge).toBe(3);
      expect(config.thresholds.emergingMaxAge).toBe(15);
      expect(config.thresholds.emergingMomentumThreshold).toBe(0.4);
    });
  });

  describe('updateConfig', () => {
    it('should update weights', () => {
      updateConfig({
        weights: { citation: 0.5 },
      });

      const config = getConfig();
      expect(config.weights.citation).toBe(0.5);
      // Other weights should remain unchanged
      expect(config.weights.age).toBe(0.25);
    });

    it('should update thresholds', () => {
      updateConfig({
        thresholds: { seminalMinAge: 15 },
      });

      const config = getConfig();
      expect(config.thresholds.seminalMinAge).toBe(15);
    });

    it('should merge nested objects', () => {
      updateConfig({
        weights: { citation: 0.6 },
        thresholds: { emergingMomentumThreshold: 0.5 },
      });

      const config = getConfig();
      expect(config.weights.citation).toBe(0.6);
      expect(config.thresholds.emergingMomentumThreshold).toBe(0.5);
      // Other values should remain
      expect(config.weights.age).toBe(0.25);
      expect(config.thresholds.seminalMinAge).toBe(10);
    });
  });

  describe('resetConfig', () => {
    it('should reset to defaults', () => {
      updateConfig({
        weights: { citation: 0.9 },
        thresholds: { seminalMinAge: 99 },
      });

      resetConfig();

      const config = getConfig();
      expect(config.weights.citation).toBe(0.40);
      expect(config.thresholds.seminalMinAge).toBe(10);
    });
  });
});

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

describe('Physical unit normalization', () => {
  it('canonicalizes common HEP unit spellings', () => {
    expect(canonicalizeUnit(' GeV ')).toBe('GeV');
    expect(canonicalizeUnit('gev')).toBe('GeV');
    expect(canonicalizeUnit('GeV/c²')).toBe('GeV/c^2');
    expect(canonicalizeUnit('cm^{-2}')).toBe('cm^-2');
    expect(canonicalizeUnit('fb^{-1}')).toBe('/fb');
    expect(canonicalizeUnit('1/fb')).toBe('/fb');
  });

  it('detects unit categories and conversion factors', () => {
    expect(detectUnitCategory('GeV/c²')).toBe('mass');
    expect(detectUnitCategory('fb^{-1}')).toBe('luminosity');

    expect(getConversionFactor('GeV', 'MeV')).toBe(1e3);
    expect(getConversionFactor('MeV', 'GeV')).toBeCloseTo(1e-3);
    expect(getConversionFactor('GeV/c²', 'MeV/c²')).toBe(1e3);
    expect(getConversionFactor('fb^{-1}', '/pb')).toBe(1e3);
    expect(getConversionFactor('GeV', 's')).toBeNull();
  });
});
