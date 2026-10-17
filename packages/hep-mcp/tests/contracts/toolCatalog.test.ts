/**
 * SYNC-02: the checked-in tool_catalog.{standard,full}.json must equal the
 * catalog the runtime registry produces, field for field, and carry no
 * volatile fields. Regenerate with `pnpm --filter @nullius/hep-mcp catalog`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ToolExposureMode } from '../../src/tools/registry.js';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..', '..');
const MODES: ToolExposureMode[] = ['standard', 'full'];

type Catalog = typeof import('../../src/tools/utils/toolCatalog.js');
let catalogModule: Catalog;

beforeAll(async () => {
  // The registry reads HEP_ENABLE_ZOTERO at module load; the catalog lists the
  // full inventory, so pin the flag before the first import of the registry.
  process.env.HEP_ENABLE_ZOTERO = '1';
  catalogModule = await import('../../src/tools/utils/toolCatalog.js');
});

describe('SYNC-02: checked-in tool catalog matches the runtime registry', () => {
  for (const mode of MODES) {
    it(`tool_catalog.${mode}.json equals buildToolCatalog('${mode}')`, () => {
      const file = resolve(PACKAGE_ROOT, `tool_catalog.${mode}.json`);
      const raw = readFileSync(file, 'utf-8');
      const checkedIn = JSON.parse(raw) as unknown;
      const expected = catalogModule.buildToolCatalog(mode);

      expect(checkedIn).toEqual(expected);
      // Byte-identical to what the generator writes, so `git diff --exit-code` is meaningful.
      expect(raw).toBe(catalogModule.renderToolCatalog(expected));
    });
  }

  it('carries only deterministic fields (no timestamp, no commit)', () => {
    for (const mode of MODES) {
      const checkedIn = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, `tool_catalog.${mode}.json`), 'utf-8')) as Record<string, unknown>;
      expect(Object.keys(checkedIn).sort()).toEqual(['count', 'mode', 'tools']);
    }
  });

  it('sorts tool names and counts them', () => {
    for (const mode of MODES) {
      const catalog = catalogModule.buildToolCatalog(mode);
      expect(catalog.tools).toEqual([...catalog.tools].sort());
      expect(catalog.count).toBe(catalog.tools.length);
      expect(catalog.count).toBeGreaterThan(0);
    }
  });
});
