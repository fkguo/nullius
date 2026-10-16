import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getToolSpecs, getTools, handleToolCall } from '../src/tools/index.js';
import { zodToMcpInputSchema } from '../src/tools/mcpSchema.js';
import type { ToolExposureMode, ToolSpec } from '../src/tools/registry.js';

function packageRootFromThisFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const primitive = JSON.stringify(value);
    return primitive === undefined ? 'undefined' : primitive;
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function assertToolContracts(specs: ToolSpec[], toolDefs: Array<{ name: string; inputSchema: unknown }>): void {
  const issues: string[] = [];

  const defsByName = new Map(toolDefs.map(d => [d.name, d]));

  for (const spec of specs) {
    if (typeof spec.handler !== 'function') {
      issues.push(`[${spec.name}] missing handler`);
      continue;
    }

    const def = defsByName.get(spec.name);
    if (!def) {
      issues.push(`[${spec.name}] missing tool definition`);
      continue;
    }

    const expected = zodToMcpInputSchema(spec.zodSchema);
    if (stableStringify(def.inputSchema) !== stableStringify(expected)) {
      issues.push(`[${spec.name}] inputSchema drift (not derived from zodSchema)`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`Tool contract violations:\n${issues.join('\n')}`);
  }
}

describe('Tool registry contracts', () => {
  it.each<ToolExposureMode>(['standard', 'full'])('tool list matches registry (%s)', mode => {
    const specs = getToolSpecs(mode);
    const defs = getTools(mode);

    expect(defs.map(d => d.name).sort()).toEqual(specs.map(s => s.name).sort());
    assertToolContracts(specs, defs);
  });

  it.each<ToolExposureMode>(['standard', 'full'])('schema.parse guards handlers (%s)', async mode => {
    const specs = getToolSpecs(mode);

    for (const spec of specs) {
      const requiresArgs = !spec.zodSchema.safeParse({}).success;
      if (!requiresArgs) continue;

      const res = await handleToolCall(spec.name, {}, mode);
      expect(res.isError).toBe(true);

      const payload = JSON.parse(res.content[0]?.text ?? '{}') as {
        error?: { code?: string };
      };
      expect(payload.error?.code).toBe('INVALID_PARAMS');
    }
  });

  it('negative control: contract test catches schema drift', () => {
    const specs = getToolSpecs('standard');
    const defs = getTools('standard').map(d => {
      if (d.name !== 'zotero_local') return d;
      return {
        ...d,
        inputSchema: { type: 'object', properties: {}, required: [] },
      };
    });

    expect(() => assertToolContracts(specs, defs)).toThrow(/inputSchema drift/);
  });

  it('does not advertise a resources capability without a real resources surface', () => {
    const source = fs.readFileSync(path.join(packageRootFromThisFile(), 'src/index.ts'), 'utf-8');

    expect(source).not.toContain('resources: {}');
    expect(source).not.toContain('ListResourcesRequestSchema');
    expect(source).not.toContain('ReadResourceRequestSchema');
  });

  it('zotero_local falls back to default limit/start for invalid pagination budgets', () => {
    const spec = getToolSpecs('standard').find(s => s.name === 'zotero_local');
    expect(spec).toBeDefined();
    const parsed = spec!.zodSchema.parse({
      mode: 'list_items',
      limit: -1,
      start: '\r\t-5',
    });
    expect(parsed.limit).toBe(50);
    expect(parsed.start).toBe(0);
  });

  it('zotero_find_items still rejects invalid non-budget numerics', () => {
    const spec = getToolSpecs('standard').find(s => s.name === 'zotero_find_items');
    expect(spec).toBeDefined();
    expect(spec!.zodSchema.safeParse({
      identifiers: { title: 'Test title' },
      filters: { year: -1 },
    }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP annotations, titles and structuredContent
// ─────────────────────────────────────────────────────────────────────────────

describe('MCP annotations and titles', () => {
  it('every listed tool carries a non-empty title and all four boolean hints', () => {
    const issues: string[] = [];
    for (const tool of getTools('full')) {
      if (typeof tool.title !== 'string' || tool.title.trim() === '') issues.push(`${tool.name}: missing title`);
      const annotations = tool.annotations as unknown as Record<string, unknown> | undefined;
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        if (typeof annotations?.[hint] !== 'boolean') issues.push(`${tool.name}: ${hint} is not a boolean`);
      }
    }
    expect(issues).toEqual([]);
  });
});

describe('structuredContent', () => {
  it('mirrors the JSON text block of an object result and is absent otherwise', async () => {
    const spec = getToolSpecs('full').find(s => s.name === 'zotero_find_items')!;
    const original = spec.handler;
    try {
      spec.handler = (async () => ({ id: 'x', nested: { values: [1, 2] }, skipped: undefined })) as typeof spec.handler;
      const res = await handleToolCall('zotero_find_items', { identifiers: { doi: '10.1000/x' } }, 'full');
      expect(res.isError).not.toBe(true);
      expect(res.structuredContent).toBeDefined();
      expect(res.structuredContent).toEqual(JSON.parse(res.content[0]!.text));

      spec.handler = (async () => [1, 2]) as typeof spec.handler;
      const arrayRes = await handleToolCall('zotero_find_items', { identifiers: { doi: '10.1000/x' } }, 'full');
      expect(arrayRes.structuredContent).toBeUndefined();
    } finally {
      spec.handler = original;
    }
  });
});
