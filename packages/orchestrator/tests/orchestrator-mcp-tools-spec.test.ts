import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ORCH_TOOL_SPECS } from '../src/index.js';
import { getFrontDoorAuthoritySurface } from '../../../scripts/lib/front-door-authority-map.mjs';

function repoRootFromThisFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

function readText(root: string, relPath: string): string {
  return fs.readFileSync(path.join(root, relPath), 'utf-8');
}

function extractOrchToolNamesFromText(text: string): string[] {
  const out: string[] = [];
  const re = /\borch_[a-z0-9]+(?:_[a-z0-9]+)*\b/g;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    out.push(String(match[0] ?? ''));
  }
  return Array.from(new Set(out));
}

function expectContainsAll(text: string, snippets: string[], label: string): void {
  const missing = snippets.filter(snippet => !text.includes(snippet));
  expect(missing, `${label}: missing required wording: ${missing.join(' | ')}`).toEqual([]);
}

function expectContainsNone(text: string, snippets: string[], label: string): void {
  const present = snippets.filter(snippet => text.includes(snippet));
  expect(present, `${label}: forbidden wording still present: ${present.join(' | ')}`).toEqual([]);
}

describe('orchestrator MCP tools spec drift guard', () => {
  const root = repoRootFromThisFile();

  it('front-door authority map records the orchestrator-owned spec lock', () => {
    expect(getFrontDoorAuthoritySurface('orchestrator_mcp_tools_spec')).toMatchObject({
      classification: 'canonical_public',
      surface_kind: 'exact_doc_inventory',
      owner: '@autoresearch/orchestrator',
      exact_inventory_source: 'meta/docs/orchestrator-mcp-tools-spec.md',
      live_registry_source: 'packages/orchestrator/src/orch-tools/index.ts / @autoresearch/orchestrator exported ORCH_TOOL_SPECS',
      drift_test_source: 'packages/orchestrator/tests/orchestrator-mcp-tools-spec.test.ts',
    });
  });

  it('meta/docs/orchestrator-mcp-tools-spec.md publishes the exact live orch_* inventory', () => {
    const live = ORCH_TOOL_SPECS
      .map(tool => tool.name)
      .filter(name => name.startsWith('orch_'))
      .sort((left, right) => left.localeCompare(right));

    const md = readText(root, 'meta/docs/orchestrator-mcp-tools-spec.md');
    const referenced = extractOrchToolNamesFromText(md).sort((left, right) => left.localeCompare(right));

    expect(referenced).toEqual(live);
  });

  it('meta/docs/orchestrator-mcp-tools-spec.md keeps orchestrator-owned narrative invariants', () => {
    const md = readText(root, 'meta/docs/orchestrator-mcp-tools-spec.md');

    expectContainsAll(
      md,
      [
        '**Rule**: `orch_*` owns lifecycle state, approvals, queueing, and orchestration policy.',
        '5. `autoresearch` remains the generic front door for lifecycle / workflow-plan / bounded computation; `orch_*` is the MCP/operator counterpart of that control plane rather than a competing product identity.',
        '`hep://` and `orch://` are intentionally separate owned namespaces. Cross-scheme correlation must be carried explicitly by workflow metadata or operator context, not by implicit aliasing.',
        '2. `packages/hep-autoresearch` is now a provider-local internal parser/toolkit residue. The retired public `hepar` shell must not reclaim `orch_*` or `autoresearch` authority.',
        'packages/orchestrator/tests/orchestrator-mcp-tools-spec.test.ts',
      ],
      'meta/docs/orchestrator-mcp-tools-spec.md',
    );
    expectContainsNone(
      md,
      ['packages/hep-mcp/tests/docs/docToolDrift.test.ts'],
      'meta/docs/orchestrator-mcp-tools-spec.md',
    );
  });
});
