import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/api/client.js', () => ({
  getPaper: vi.fn(),
}));

vi.mock('../../src/tools/research/measurementExtractor.js', () => ({
  extractMeasurements: vi.fn(),
}));

vi.mock('@autoresearch/pdg-mcp/tooling', () => ({
  getToolSpec: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const measurementExtractor = await import('../../src/tools/research/measurementExtractor.js');
const pdgTooling = await import('@autoresearch/pdg-mcp/tooling');
const { detectConflicts } = await import('../../src/tools/research/conflictDetector.js');

describe('detectConflicts: PDG baseline (m_W)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes PDG world-average as a pseudo-measurement and computes tension', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce({
      recid: '123',
      title: 'New W mass measurement',
      year: 2022,
      citation_count: 0,
    } as any);

    vi.mocked(measurementExtractor.extractMeasurements).mockResolvedValueOnce({
      success: true,
      measurements: [
        {
          value: 80.4335,
          uncertainty: 0.0094,
          unit: 'GeV',
          quantity_hint: 'm_W',
          source_context: 'W mass',
          source_location: 'abstract',
          raw_match: '80.4335 ± 0.0094 GeV',
        },
      ],
    } as any);

    vi.mocked(pdgTooling.getToolSpec).mockImplementation((name: string) => {
      if (name !== 'pdg_get_property') return undefined as any;
      return {
        name: 'pdg_get_property',
        zodSchema: { parse: (x: any) => x },
        handler: async () => ({
          edition: '2024',
          value: {
            value: 80.377,
            error_positive: 0.005,
            error_negative: 0.005,
            unit_text: 'GeV',
          },
        }),
      } as any;
    });

    const result = await detectConflicts({
      recids: ['123'],
      target_quantities: ['m_W'],
      min_tension_sigma: 3.0,
    });

    expect(result.success).toBe(true);
    expect(result.conflicts.length).toBeGreaterThan(0);

    const conflict = result.conflicts[0]!;
    const recids = conflict.measurements.map(m => m.recid);
    expect(recids).toContain('123');
    expect(recids).toContain('PDG');
    expect(conflict.tension_sigma).toBeGreaterThan(3.0);
  });
});

