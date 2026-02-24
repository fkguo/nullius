/**
 * Tests for conflict detection with unit conversion
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectConflicts } from '../../src/tools/research/conflictDetector.js';
import * as api from '../../src/api/client.js';
import * as measurementExtractor from '../../src/tools/research/measurementExtractor.js';

// Mock API client
vi.mock('../../src/api/client.js', () => ({
  getPaper: vi.fn(),
}));

// Mock measurement extractor
vi.mock('../../src/tools/research/measurementExtractor.js', () => ({
  extractMeasurements: vi.fn(),
}));

describe('detectConflicts with unit conversion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should detect conflicts between GeV and MeV measurements', async () => {
    // Setup mock papers
    vi.mocked(api.getPaper).mockResolvedValueOnce({
      recid: '123',
      title: 'Paper A',
      year: 2020,
      citation_count: 10,
    } as any);

    vi.mocked(api.getPaper).mockResolvedValueOnce({
      recid: '456',
      title: 'Paper B',
      year: 2021,
      citation_count: 15,
    } as any);

    // Paper A measures mass in GeV: 1.5 ± 0.1 GeV
    vi.mocked(measurementExtractor.extractMeasurements)
      .mockResolvedValueOnce({
        success: true,
        measurements: [
          {
            value: 1.5,
            uncertainty: 0.1,
            unit: 'GeV',
            quantity_hint: 'mass',
            context: 'particle mass',
            source: 'abstract',
          },
        ],
      } as any);

    // Paper B measures mass in MeV: 2000 ± 50 MeV (= 2.0 ± 0.05 GeV)
    // This should create a conflict since 1.5 GeV vs 2.0 GeV differs by ~4.5σ
    vi.mocked(measurementExtractor.extractMeasurements)
      .mockResolvedValueOnce({
        success: true,
        measurements: [
          {
            value: 2000,
            uncertainty: 50,
            unit: 'MeV',
            quantity_hint: 'mass',
            context: 'particle mass',
            source: 'abstract',
          },
        ],
      } as any);

    const result = await detectConflicts({
      recids: ['123', '456'],
      min_tension_sigma: 3.0,
    });

    expect(result.success).toBe(true);
    expect(result.conflicts.length).toBeGreaterThan(0);

    // Should have detected the conflict after unit conversion
    const conflict = result.conflicts[0];
    expect(conflict.quantity).toBe('mass');
    expect(conflict.notes).toContain('MeV converted to GeV');
    expect(conflict.tension_sigma).toBeGreaterThan(3.0);
  });

  it('should handle compatible measurements in different units', async () => {
    // Setup mock papers
    vi.mocked(api.getPaper).mockResolvedValueOnce({
      recid: '123',
      title: 'Paper A',
      year: 2020,
      citation_count: 10,
    } as any);

    vi.mocked(api.getPaper).mockResolvedValueOnce({
      recid: '456',
      title: 'Paper B',
      year: 2021,
      citation_count: 15,
    } as any);

    // Paper A measures mass in GeV: 1.5 ± 0.2 GeV
    vi.mocked(measurementExtractor.extractMeasurements)
      .mockResolvedValueOnce({
        success: true,
        measurements: [
          {
            value: 1.5,
            uncertainty: 0.2,
            unit: 'GeV',
            quantity_hint: 'mass',
            context: 'particle mass',
            source: 'abstract',
          },
        ],
      } as any);

    // Paper B measures mass in MeV: 1550 ± 150 MeV (= 1.55 ± 0.15 GeV)
    // This should be compatible (tension < 3σ)
    vi.mocked(measurementExtractor.extractMeasurements)
      .mockResolvedValueOnce({
        success: true,
        measurements: [
          {
            value: 1550,
            uncertainty: 150,
            unit: 'MeV',
            quantity_hint: 'mass',
            context: 'particle mass',
            source: 'abstract',
          },
        ],
      } as any);

    const result = await detectConflicts({
      recids: ['123', '456'],
      min_tension_sigma: 3.0,
    });

    expect(result.success).toBe(true);
    expect(result.conflicts.length).toBe(0);
    expect(result.compatible_groups.length).toBeGreaterThan(0);
  });

  it('should handle cross-section measurements in pb and fb', async () => {
    // Setup mock papers
    vi.mocked(api.getPaper).mockResolvedValueOnce({
      recid: '789',
      title: 'Paper C',
      year: 2022,
      citation_count: 20,
    } as any);

    vi.mocked(api.getPaper).mockResolvedValueOnce({
      recid: '101',
      title: 'Paper D',
      year: 2023,
      citation_count: 25,
    } as any);

    // Paper C measures cross-section in pb: 1.5 ± 0.2 pb
    vi.mocked(measurementExtractor.extractMeasurements)
      .mockResolvedValueOnce({
        success: true,
        measurements: [
          {
            value: 1.5,
            uncertainty: 0.2,
            unit: 'pb',
            quantity_hint: 'cross section',
            context: 'production cross-section',
            source: 'abstract',
          },
        ],
      } as any);

    // Paper D measures cross-section in fb: 1600 ± 150 fb (= 1.6 ± 0.15 pb)
    vi.mocked(measurementExtractor.extractMeasurements)
      .mockResolvedValueOnce({
        success: true,
        measurements: [
          {
            value: 1600,
            uncertainty: 150,
            unit: 'fb',
            quantity_hint: 'cross section',
            context: 'production cross-section',
            source: 'abstract',
          },
        ],
      } as any);

    const result = await detectConflicts({
      recids: ['789', '101'],
      min_tension_sigma: 3.0,
    });

    expect(result.success).toBe(true);
    // Should be compatible after conversion
    expect(result.compatible_groups.length).toBeGreaterThan(0);
  });

  it('should reject incompatible units (mass vs time)', async () => {
    // Setup mock papers
    vi.mocked(api.getPaper).mockResolvedValueOnce({
      recid: '111',
      title: 'Paper E',
      year: 2020,
      citation_count: 10,
    } as any);

    vi.mocked(api.getPaper).mockResolvedValueOnce({
      recid: '222',
      title: 'Paper F',
      year: 2021,
      citation_count: 15,
    } as any);

    // Paper E measures mass in GeV
    vi.mocked(measurementExtractor.extractMeasurements)
      .mockResolvedValueOnce({
        success: true,
        measurements: [
          {
            value: 1.5,
            uncertainty: 0.1,
            unit: 'GeV',
            quantity_hint: 'mass',
            context: 'particle mass',
            source: 'abstract',
          },
        ],
      } as any);

    // Paper F measures time in ps (incompatible with GeV)
    vi.mocked(measurementExtractor.extractMeasurements)
      .mockResolvedValueOnce({
        success: true,
        measurements: [
          {
            value: 100,
            uncertainty: 10,
            unit: 'ps',
            quantity_hint: 'mass',  // Same quantity hint, but incompatible units
            context: 'test',
            source: 'abstract',
          },
        ],
      } as any);

    const result = await detectConflicts({
      recids: ['111', '222'],
      min_tension_sigma: 3.0,
    });

    expect(result.success).toBe(true);
    // Should not compare incompatible units
    // They're grouped together but areComparable should reject them
    expect(result.conflicts.length).toBe(0);
  });

  it('should handle multi-hop unit conversions (TeV -> GeV -> MeV)', async () => {
    // Setup mock papers
    vi.mocked(api.getPaper).mockResolvedValueOnce({
      recid: '333',
      title: 'Paper G',
      year: 2023,
      citation_count: 30,
    } as any);

    vi.mocked(api.getPaper).mockResolvedValueOnce({
      recid: '444',
      title: 'Paper H',
      year: 2023,
      citation_count: 35,
    } as any);

    // Paper G measures in TeV: 0.001 ± 0.0001 TeV (= 1 ± 0.1 GeV)
    vi.mocked(measurementExtractor.extractMeasurements)
      .mockResolvedValueOnce({
        success: true,
        measurements: [
          {
            value: 0.001,
            uncertainty: 0.0001,
            unit: 'TeV',
            quantity_hint: 'mass',
            context: 'particle mass',
            source: 'abstract',
          },
        ],
      } as any);

    // Paper H measures in MeV: 1100 ± 80 MeV (= 1.1 ± 0.08 GeV)
    vi.mocked(measurementExtractor.extractMeasurements)
      .mockResolvedValueOnce({
        success: true,
        measurements: [
          {
            value: 1100,
            uncertainty: 80,
            unit: 'MeV',
            quantity_hint: 'mass',
            context: 'particle mass',
            source: 'abstract',
          },
        ],
      } as any);

    const result = await detectConflicts({
      recids: ['333', '444'],
      min_tension_sigma: 3.0,
    });

    expect(result.success).toBe(true);
    // Should successfully convert TeV -> GeV -> MeV
    // Tension should be small: |1.0 - 1.1| / sqrt(0.1^2 + 0.08^2) ≈ 0.78σ
    expect(result.conflicts.length).toBe(0);
    expect(result.compatible_groups.length).toBeGreaterThan(0);
  });
});
