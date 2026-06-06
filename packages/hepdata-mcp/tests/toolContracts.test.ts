import { describe, it, expect } from 'vitest';

import { getToolSpecs, getTools, handleToolCall } from '../src/tools/index.js';
import { zodToMcpInputSchema } from '../src/tools/mcpSchema.js';
import type { ToolExposureMode, ToolSpec } from '../src/tools/registry.js';
import {
  HepDataDownloadSchema,
  HepDataGetTableSchema,
  HepDataSearchSchema,
} from '../src/tools/schemas.js';

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

describe('Tool registry contracts (M0)', () => {
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
      if (d.name !== 'hepdata_search') return d;
      return {
        ...d,
        inputSchema: { type: 'object', properties: {}, required: [] },
      };
    });

    expect(() => assertToolContracts(specs, defs)).toThrow(/inputSchema drift/);
  });

  it('HepDataSearchSchema falls back to defaults for invalid page/size budgets', () => {
    const parsed = HepDataSearchSchema.parse({
      query: 'LHCb cross section',
      page: '\r\t-5',
      size: 999,
    });
    expect(parsed.page).toBe(1);
    expect(parsed.size).toBe(10);
  });

  it('HepDataSearchSchema still rejects invalid identifier numerics', () => {
    expect(HepDataSearchSchema.safeParse({
      inspire_recid: -1,
      query: 'LHCb cross section',
    }).success).toBe(false);
  });

  it('HepDataGetTableSchema accepts json/yaml/csv and defaults to json', () => {
    expect(HepDataGetTableSchema.parse({ table_id: 1 }).format).toBe('json');
    for (const format of ['json', 'yaml', 'csv'] as const) {
      expect(HepDataGetTableSchema.parse({ table_id: 1, format }).format).toBe(format);
    }
    expect(HepDataGetTableSchema.safeParse({ table_id: 1, format: 'root' }).success).toBe(false);
  });

  it('HepDataDownloadSchema defaults format to original and accepts the heavy formats', () => {
    expect(HepDataDownloadSchema.parse({ hepdata_id: 1, _confirm: true }).format).toBe('original');
    for (const format of ['original', 'json', 'csv', 'root', 'yaml', 'yoda', 'yoda1', 'yoda.h5'] as const) {
      expect(HepDataDownloadSchema.parse({ hepdata_id: 1, _confirm: true, format }).format).toBe(format);
    }
    expect(HepDataDownloadSchema.safeParse({ hepdata_id: 1, _confirm: true, format: 'pdf' }).success).toBe(false);
    // _confirm gate is preserved.
    expect(HepDataDownloadSchema.safeParse({ hepdata_id: 1 }).success).toBe(false);
  });

  it('HepDataSearchSchema accepts max_results and rejects non-positive values', () => {
    expect(HepDataSearchSchema.parse({ query: 'x', max_results: 100 }).max_results).toBe(100);
    // Omitted -> undefined (client falls back to size for single-page behavior).
    expect(HepDataSearchSchema.parse({ query: 'x' }).max_results).toBeUndefined();
    // Budget-int drops invalid (<=0) values to undefined rather than throwing.
    expect(HepDataSearchSchema.parse({ query: 'x', max_results: -5 }).max_results).toBeUndefined();
  });
});
