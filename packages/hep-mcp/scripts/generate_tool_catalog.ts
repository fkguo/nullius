#!/usr/bin/env tsx
/**
 * C-03: Generate tool catalog JSONs from the runtime registry.
 *
 * Usage: pnpm catalog
 * Outputs:
 *   tool_catalog.standard.json
 *   tool_catalog.full.json
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Import from compiled output (must build first)
const { getTools } = await import('../dist/tools/index.js');

function gitCommitHash(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function generateCatalog(mode: 'standard' | 'full') {
  const tools = getTools(mode);
  const names = tools.map((t: { name: string }) => t.name).sort();
  return {
    generated_at: new Date().toISOString(),
    commit: gitCommitHash(),
    mode,
    count: names.length,
    tools: names,
  };
}

const outDir = resolve(import.meta.dirname, '..');

for (const mode of ['standard', 'full'] as const) {
  const catalog = generateCatalog(mode);
  const path = resolve(outDir, `tool_catalog.${mode}.json`);
  writeFileSync(path, JSON.stringify(catalog, null, 2) + '\n', 'utf-8');
  console.log(`[ok] ${path} (${catalog.count} tools)`);
}
