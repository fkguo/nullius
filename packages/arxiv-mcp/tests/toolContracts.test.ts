import { describe, it, expect } from 'vitest';
import {
  TOOL_SPECS,
  getTools,
  getToolSpec,
  getToolSpecs,
  ArxivIdSchema,
  ArxivSearchSchema,
  ArxivPaperSourceSchema,
  normalizeArxivId,
  type ToolExposureMode,
} from '../src/tools/registry.js';
import { handleToolCall } from '../src/tools/dispatcher.js';
import {
  ARXIV_SEARCH,
  ARXIV_GET_METADATA,
  ARXIV_PAPER_SOURCE,
  findBudgetBoundMismatches,
  findRequiredKeyMismatches,
} from '@nullius/shared';
import { zodToMcpInputSchema } from '../src/tools/mcpSchema.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool registration
// ─────────────────────────────────────────────────────────────────────────────

describe('Tool registration', () => {
  it('registers exactly 3 tools', () => {
    expect(TOOL_SPECS).toHaveLength(3);
  });

  it('all tools appear in getTools output', () => {
    const tools = getTools('standard');
    const names = tools.map(t => t.name);
    expect(names).toContain(ARXIV_SEARCH);
    expect(names).toContain(ARXIV_GET_METADATA);
    expect(names).toContain(ARXIV_PAPER_SOURCE);
  });

  it('each tool has a valid inputSchema with type=object', () => {
    for (const spec of TOOL_SPECS) {
      const schema = zodToMcpInputSchema(spec.zodSchema);
      expect(schema.type).toBe('object');
    }
  });

  it('getToolSpec returns undefined for unknown tool', () => {
    expect(getToolSpec('nonexistent_tool')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────────────

describe('Dispatcher', () => {
  it('returns INVALID_PARAMS for missing required param (query)', async () => {
    const result = await handleToolCall(ARXIV_SEARCH, {});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('INVALID_PARAMS');
  });

  it('returns INVALID_PARAMS for unknown tool name', async () => {
    const result = await handleToolCall('nonexistent_tool', {});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('INVALID_PARAMS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ArxivIdSchema validation
// ─────────────────────────────────────────────────────────────────────────────

describe('ArxivIdSchema', () => {
  const validIds = [
    '2301.01234',
    '2301.12345',
    'hep-ph/0601234',
    '2301.01234v2',
    'hep-th/0601001v1',
    'math.GT/0309136',
    'cond-mat.str-el/0501001',
  ];

  const invalidIds = [
    'not-an-id',
    '12345',
    'http://google.com',
    '',
    'hep-ph-0601234',
    '2301.123',
  ];

  for (const id of validIds) {
    it(`accepts valid ID: ${id}`, () => {
      expect(() => ArxivIdSchema.parse(id)).not.toThrow();
    });
  }

  for (const id of invalidIds) {
    it(`rejects invalid ID: ${id}`, () => {
      expect(() => ArxivIdSchema.parse(id)).toThrow();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema-normalize SSOT contract (§6a)
// ─────────────────────────────────────────────────────────────────────────────

describe('Schema-normalize SSOT contract', () => {
  const testIds = [
    '2301.01234',
    '2301.12345v2',
    'hep-ph/0601234',
    'hep-th/0601001v1',
    'math.GT/0309136',
    'cond-mat.str-el/0501001',
  ];

  for (const id of testIds) {
    it(`ArxivIdSchema.parse(${id}) → normalizeArxivId returns non-null`, () => {
      // Schema accepts it
      expect(() => ArxivIdSchema.parse(id)).not.toThrow();
      // Normalize also accepts it
      const normalized = normalizeArxivId(id);
      expect(normalized).not.toBeNull();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Zod default enforcement (§6a)
// ─────────────────────────────────────────────────────────────────────────────

describe('Zod default enforcement', () => {
  it('ArxivSearchSchema defaults max_results to 10', () => {
    const parsed = ArxivSearchSchema.parse({ query: 'test' });
    expect(parsed.max_results).toBe(10);
  });

  it('ArxivSearchSchema falls back to default max_results for invalid budget values', () => {
    const parsed = ArxivSearchSchema.parse({ query: 'test', max_results: -100 as any });
    expect(parsed.max_results).toBe(10);
  });

  it('ArxivSearchSchema falls back to default start for polluted invalid strings', () => {
    const parsed = ArxivSearchSchema.parse({ query: 'test', start: '\r\t-100' as any });
    expect(parsed.start).toBe(0);
  });

  it('ArxivSearchSchema defaults sort_by to relevance', () => {
    const parsed = ArxivSearchSchema.parse({ query: 'test' });
    expect(parsed.sort_by).toBe('relevance');
  });

  it('ArxivPaperSourceSchema defaults mode to auto', () => {
    const parsed = ArxivPaperSourceSchema.parse({ arxiv_id: '2301.01234' });
    expect(parsed.mode).toBe('auto');
  });

  it('ArxivPaperSourceSchema defaults prefer to auto (not undefined)', () => {
    const parsed = ArxivPaperSourceSchema.parse({ arxiv_id: '2301.01234' });
    expect(parsed.prefer).toBe('auto');
  });

  it('ArxivPaperSourceSchema defaults extract to true', () => {
    const parsed = ArxivPaperSourceSchema.parse({ arxiv_id: '2301.01234' });
    expect(parsed.extract).toBe(true);
  });

  it('ArxivPaperSourceSchema defaults check_availability to false', () => {
    const parsed = ArxivPaperSourceSchema.parse({ arxiv_id: '2301.01234' });
    expect(parsed.check_availability).toBe(false);
  });

  it('ArxivPaperSourceSchema strips legacy max_content_kb without error', () => {
    const parsed = ArxivPaperSourceSchema.parse({
      arxiv_id: '2301.01234',
      max_content_kb: 256,
    } as any);
    expect('max_content_kb' in parsed).toBe(false);
  });
});

describe('Tool metadata drift regressions', () => {
  it('arxiv_paper_source no longer exposes max_content_kb', () => {
    const tool = getTools('standard').find(t => t.name === ARXIV_PAPER_SOURCE);
    expect(tool).toBeDefined();
    expect((tool?.inputSchema as any).properties.max_content_kb).toBeUndefined();
  });

  it('arxiv_search metadata no longer marks defaulted fields as required', () => {
    const tool = getTools('standard').find(t => t.name === ARXIV_SEARCH);
    expect(tool).toBeDefined();
    expect((tool?.inputSchema as any).required ?? []).toEqual(['query']);
    expect((tool?.inputSchema as any).additionalProperties).toBe(false);
    expect((tool?.inputSchema as any).properties.max_results.minimum).toBe(1);
    expect((tool?.inputSchema as any).properties.max_results.maximum).toBe(50);
    expect((tool?.inputSchema as any).properties.max_results.default).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Date cross-validation
// ─────────────────────────────────────────────────────────────────────────────

describe('Date cross-validation', () => {
  it('rejects date_from > date_to', () => {
    expect(() => ArxivSearchSchema.parse({
      query: 'test',
      date_from: '20240101',
      date_to: '20230101',
    })).toThrow();
  });

  it('accepts date_from <= date_to', () => {
    expect(() => ArxivSearchSchema.parse({
      query: 'test',
      date_from: '20230101',
      date_to: '20240101',
    })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Category validation
// ─────────────────────────────────────────────────────────────────────────────

describe('Category validation', () => {
  it('accepts valid categories in search', () => {
    expect(() => ArxivSearchSchema.parse({
      query: 'test',
      categories: ['hep-ph', 'cond-mat.str-el', 'stat.ML'],
    })).not.toThrow();
  });

  it('rejects invalid categories', () => {
    expect(() => ArxivSearchSchema.parse({
      query: 'test',
      categories: ['HEP-PH'],
    })).toThrow();
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
    const spec = getToolSpecs('full').find(s => s.name === ARXIV_GET_METADATA)!;
    const original = spec.handler;
    try {
      spec.handler = (async () => ({ id: 'x', nested: { values: [1, 2] }, skipped: undefined })) as typeof spec.handler;
      const res = await handleToolCall(ARXIV_GET_METADATA, { arxiv_id: '2301.01234' }, 'full');
      expect(res.isError).not.toBe(true);
      expect(res.structuredContent).toBeDefined();
      expect(res.structuredContent).toEqual(JSON.parse(res.content[0]!.text));

      spec.handler = (async () => [1, 2]) as typeof spec.handler;
      const arrayRes = await handleToolCall(ARXIV_GET_METADATA, { arxiv_id: '2301.01234' }, 'full');
      expect(arrayRes.structuredContent).toBeUndefined();
    } finally {
      spec.handler = original;
    }
  });
});

describe('Tool inputSchema required keys', () => {
  it.each<ToolExposureMode>(['standard', 'full'])('required lists exactly the keys whose omission fails to parse (%s)', mode => {
    const specs = new Map(TOOL_SPECS.map(spec => [spec.name, spec]));
    const defs = getTools(mode);
    expect(defs.length).toBeGreaterThan(0);
    const issues = defs.flatMap(def => {
      const spec = specs.get(def.name);
      if (!spec) return [`[${def.name}] no tool spec`];
      return findRequiredKeyMismatches(spec.zodSchema, def.inputSchema).map(issue => `[${def.name}] ${issue}`);
    });
    expect(issues).toEqual([]);
  });

  it.each<ToolExposureMode>(['standard', 'full'])('budget fields publish the bounds their parser applies (%s)', mode => {
    const specs = new Map(TOOL_SPECS.map(spec => [spec.name, spec]));
    const issues = getTools(mode).flatMap(def => {
      const spec = specs.get(def.name);
      if (!spec) return [`[${def.name}] no tool spec`];
      return findBudgetBoundMismatches(spec.zodSchema, def.inputSchema).map(issue => `[${def.name}] ${issue}`);
    });
    expect(issues).toEqual([]);
  });
});
