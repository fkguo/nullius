import { describe, it, expect } from 'vitest';
import { normalizeArxivId } from '../src/source/arxivSource.js';

describe('normalizeArxivId', () => {
  it('accepts a bare modern id and strips the version', () => {
    expect(normalizeArxivId('2401.09012')).toBe('2401.09012');
    expect(normalizeArxivId('2401.09012v3')).toBe('2401.09012');
  });

  it('accepts a legacy sub-archive id', () => {
    expect(normalizeArxivId('hep-ph/9501234')).toBe('hep-ph/9501234');
    expect(normalizeArxivId('hep-ph/9501234v2')).toBe('hep-ph/9501234');
  });

  it('extracts the id from abs / pdf / src URLs', () => {
    expect(normalizeArxivId('https://arxiv.org/abs/2301.12345')).toBe('2301.12345');
    expect(normalizeArxivId('https://arxiv.org/pdf/2301.12345')).toBe('2301.12345');
    expect(normalizeArxivId('https://arxiv.org/src/2301.12345')).toBe('2301.12345');
  });

  it('extracts the id from the canonical /e-print/ source URL it now emits', () => {
    // Regression: the package emits arxiv.org/e-print/<id> as source_url, so the
    // normalizer must round-trip its own output (previously only abs|pdf|src).
    expect(normalizeArxivId('https://arxiv.org/e-print/2301.12345')).toBe('2301.12345');
    expect(normalizeArxivId('https://arxiv.org/e-print/2301.12345v2')).toBe('2301.12345');
  });

  it('accepts the arXiv: prefix and rejects non-arxiv input', () => {
    expect(normalizeArxivId('arXiv:2401.09012')).toBe('2401.09012');
    expect(normalizeArxivId('not an id')).toBeNull();
  });
});
