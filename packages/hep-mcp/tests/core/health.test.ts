import { describe, it, expect } from 'vitest';
import { computeToolCatalogHash } from '../../src/tools/utils/health.js';

describe('H-17: tool_catalog_hash', () => {
  it('returns a 64-character hex string', () => {
    const hash = computeToolCatalogHash('standard');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable (idempotent) across repeated calls', () => {
    const h1 = computeToolCatalogHash('standard');
    const h2 = computeToolCatalogHash('standard');
    expect(h1).toBe(h2);
  });

  it('differs between standard and full modes', () => {
    const standard = computeToolCatalogHash('standard');
    const full = computeToolCatalogHash('full');
    // full mode has more tools than standard
    expect(standard).not.toBe(full);
  });
});
