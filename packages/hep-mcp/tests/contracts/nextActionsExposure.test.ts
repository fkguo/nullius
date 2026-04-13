import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getToolSpecs as getOrchestratorToolSpecs } from '@autoresearch/orchestrator';
import { getToolSpecs } from '../../src/tools/index.js';

function repoRootFromThisFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..');
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      out.push(fullPath);
    }
  }
  return out;
}

function extractNextActionToolRefs(source: string): string[] {
  if (!source.includes('next_actions')) return [];
  const refs: string[] = [];
  // Match string literals: tool: 'some_tool'
  const stringRegex = /tool\s*:\s*['"`]([a-z][a-z0-9_]+)['"`]/g;
  for (let match = stringRegex.exec(source); match; match = stringRegex.exec(source)) {
    refs.push(String(match[1] ?? ''));
  }
  // Match constant references: tool: SOME_TOOL (H-16a)
  const constRegex = /tool:\s*([A-Z][A-Z0-9_]+)/g;
  for (let match = constRegex.exec(source); match; match = constRegex.exec(source)) {
    refs.push(String(match[1] ?? '').toLowerCase());
  }
  return refs;
}

describe('Contract: next_actions tool exposure', () => {
  it('all next_actions tool refs stay on the standard hep surface or point to live generic orchestrator tools', () => {
    const root = repoRootFromThisFile();
    const toolsRoot = path.join(root, 'packages', 'hep-mcp', 'src', 'tools');
    const files = collectTsFiles(toolsRoot);

    const referenced = new Set<string>();
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const name of extractNextActionToolRefs(source)) {
        referenced.add(name);
      }
    }

    expect(referenced.size).toBeGreaterThan(0);

    const standardNames = new Set(getToolSpecs('standard').map(spec => spec.name));
    const orchestratorNames = new Set(getOrchestratorToolSpecs('full').map(spec => spec.name));
    const missing = Array.from(referenced)
      .filter(name => !standardNames.has(name) && !orchestratorNames.has(name))
      .sort();

    expect(missing).toEqual([]);
  });
});
