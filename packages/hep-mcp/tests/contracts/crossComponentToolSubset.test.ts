/**
 * H-16b: Cross-component contract test — TOOL_NAMES ⊂ registry.getTools('full')
 *
 * Ensures every tool name constant in packages/shared/src/tool-names.ts
 * has a corresponding entry in the hep-mcp tool registry.
 */
import { describe, expect, it } from 'vitest';

import * as shared from '@autoresearch/shared';
import { getTools } from '../../src/tools/index.js';
import { computeToolCatalogHash } from '../../src/tools/utils/health.js';

/**
 * Extract all tool name constants from @autoresearch/shared exports.
 * Tool name constants are lowercase strings with underscores containing at least
 * two segments (prefix_action), matching known tool name prefixes.
 * Excludes namespace prefixes like 'hep_run_' which end with underscore.
 */
function extractToolNameConstants(): string[] {
  const TOOL_NAME_PREFIXES = ['hep_', 'inspire_', 'pdg_', 'zotero_', 'hepdata_'];
  const names: string[] = [];
  for (const [_key, value] of Object.entries(shared)) {
    if (typeof value !== 'string') continue;
    // Skip namespace prefixes (end with underscore, e.g. 'hep_run_')
    if (value.endsWith('_')) continue;
    if (TOOL_NAME_PREFIXES.some(prefix => value.startsWith(prefix))) {
      names.push(value);
    }
  }
  // Deduplicate (same constant may be re-exported)
  return [...new Set(names)];
}

describe('H-16b: cross-component tool subset contract', () => {
  const registeredNames = new Set(getTools('full').map(t => t.name));
  const sharedConstants = extractToolNameConstants();

  it('TOOL_NAMES constants are non-empty', () => {
    expect(sharedConstants.length).toBeGreaterThan(0);
  });

  it('every shared TOOL_NAMES constant exists in getTools("full")', () => {
    const missing = sharedConstants.filter(name => !registeredNames.has(name));
    expect(missing).toEqual([]);
  });

  it('registry is non-empty', () => {
    expect(registeredNames.size).toBeGreaterThan(0);
  });

  it('computeToolCatalogHash returns a valid SHA-256 hex string', () => {
    const hash = computeToolCatalogHash('full');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('computeToolCatalogHash is deterministic', () => {
    const h1 = computeToolCatalogHash('full');
    const h2 = computeToolCatalogHash('full');
    expect(h1).toBe(h2);
  });

  it('standard mode is a subset of full mode', () => {
    const standardNames = getTools('standard').map(t => t.name);
    const missing = standardNames.filter(name => !registeredNames.has(name));
    expect(missing).toEqual([]);
  });
});
