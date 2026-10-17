#!/usr/bin/env tsx
/**
 * SYNC-02: Generate the tool catalog JSONs from the runtime registry.
 *
 * Usage: pnpm --filter @nullius/hep-mcp catalog   (build first)
 * Outputs (deterministic: mode, count, sorted tool names — no timestamp, no commit):
 *   tool_catalog.standard.json
 *   tool_catalog.full.json
 *
 * The registry reads HEP_ENABLE_ZOTERO when it loads; the catalog always
 * lists the full inventory, so the flag is pinned before the import.
 * tests/contracts/toolCatalog.test.ts holds the checked-in files to this output.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

process.env.HEP_ENABLE_ZOTERO = '1';

// Import from compiled output (must build first)
const { buildToolCatalog, renderToolCatalog } = await import('../dist/tools/utils/toolCatalog.js');

const outDir = resolve(import.meta.dirname, '..');

for (const mode of ['standard', 'full'] as const) {
  const catalog = buildToolCatalog(mode);
  const path = resolve(outDir, `tool_catalog.${mode}.json`);
  writeFileSync(path, renderToolCatalog(catalog), 'utf-8');
  console.log(`[ok] ${path} (${catalog.count} tools)`);
}
