import { describe, it, expect } from 'vitest';

import { getToolSpecs, getTools, handleToolCall } from '../src/tools/index.js';
import { getTools as getArxivTools } from '@nullius/arxiv-mcp/tooling';
import { getTools as getHepdataTools } from '@nullius/hepdata-mcp/tooling';
import { getTools as getOpenalexTools } from '@nullius/openalex-mcp/tooling';
import { getTools as getPdgTools } from '@nullius/pdg-mcp/tooling';
import { getTools as getZoteroTools } from '@nullius/zotero-mcp/tooling';
import { findBudgetBoundMismatches, findRequiredKeyMismatches } from '@nullius/shared';
import { zodToMcpInputSchema } from '../src/tools/mcpSchema.js';
import type { ToolExposureMode, ToolSpec } from '../src/tools/registry.js';
import { HEP_TOOL_RISK_LEVELS, type ToolRiskLevel } from '../src/tool-risk.js';
import { InspireSearchToolSchema } from '../src/tools/registry/inspireSchemas.js';
import { HepImportFromZoteroToolSchema } from '../src/tools/registry/projectSchemas.js';

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

describe('Tool registry contracts (M2)', () => {
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
      // Destructive tools may return CONFIRMATION_REQUIRED before INVALID_PARAMS (H-11a Phase 2)
      const expectedCodes = spec.riskLevel === 'destructive'
        ? ['INVALID_PARAMS', 'CONFIRMATION_REQUIRED']
        : ['INVALID_PARAMS'];
      expect(expectedCodes).toContain(payload.error?.code);
    }
  });

  it('negative control: contract test catches schema drift', () => {
    const specs = getToolSpecs('standard');
    const defs = getTools('standard').map(d => {
      if (d.name !== 'inspire_search') return d;
      return {
        ...d,
        inputSchema: { type: 'object', properties: {}, required: [] },
      };
    });

    expect(() => assertToolContracts(specs, defs)).toThrow(/inputSchema drift/);
  });

  it('inspire_search metadata only requires query at the MCP layer', () => {
    const tool = getTools('standard').find(t => t.name === 'inspire_search');
    expect(tool).toBeDefined();
    expect((tool?.inputSchema as any).required ?? []).toEqual(['query']);
    expect((tool?.inputSchema as any).additionalProperties).toBe(false);
    expect((tool?.inputSchema as any).properties.max_results.minimum).toBe(1);
    expect((tool?.inputSchema as any).properties.max_results.default).toBe(100);
  });

  it('inspire_literature metadata documents tolerated singleton-mode size compatibility', () => {
    const tool = getTools('standard').find(t => t.name === 'inspire_literature');
    expect(tool).toBeDefined();
    expect(tool?.description).toContain('get_paper: { recid } only. Do not pass size, page, or options.');
    expect(tool?.description).toContain('lookup_by_id: { identifier } only. Do not pass size, sort, page, or options; accidental size is ignored.');
    expect(tool?.description).toContain('get_author: { identifier } only. Do not pass size, sort, page, or options; accidental size is ignored.');
    expect((tool?.inputSchema as any).properties.size.description).toContain('Ignored by lookup_by_id, get_paper, and get_author');
    expect((tool?.inputSchema as any).properties.identifier.description).toContain('size is tolerated and ignored');
  });

  // The tools that write output files refuse a limit that is not a whole
  // number in range instead of replacing it by the default; a digit string is
  // still read as its number.
  it('inspire_search refuses invalid max_results and page values instead of using defaults', () => {
    expect(InspireSearchToolSchema.safeParse({ query: 'qcd', max_results: -100 }).success).toBe(false);
    expect(InspireSearchToolSchema.safeParse({ query: 'qcd', page: '\r\t-5' }).success).toBe(false);
    expect(InspireSearchToolSchema.safeParse({ query: 'qcd', size: 2000 }).success).toBe(false);
    const parsed = InspireSearchToolSchema.parse({ query: 'qcd', max_results: ' 50 ', page: '2' });
    expect(parsed.max_results).toBe(50);
    expect(parsed.page).toBe(2);
  });

  it('hep_import_from_zotero refuses an out-of-range concurrency instead of using the default', () => {
    expect(HepImportFromZoteroToolSchema.safeParse({ output_dir: 'out', item_keys: ['ABCD1234'], concurrency: 999 }).success).toBe(false);
    expect(HepImportFromZoteroToolSchema.parse({ output_dir: 'out', item_keys: ['ABCD1234'], concurrency: '8' }).concurrency).toBe(8);
  });

  it('the strict limits keep publishing their bounds in the input schema', () => {
    const tool = getTools('standard').find(t => t.name === 'inspire_search');
    expect((tool?.inputSchema as any).properties.size).toMatchObject({ type: 'integer', minimum: 1, maximum: 1000, default: 25 });
  });

  it('non-budget numeric params remain fail-closed', () => {
    const download = getToolSpecs('full').find(spec => spec.name === 'hepdata_download');
    expect(download).toBeDefined();
    expect(download!.zodSchema.safeParse({ hepdata_id: -1, _confirm: true }).success).toBe(false);
  });
});

describe('Tool risk level contracts (H-11a)', () => {
  const validRiskLevels: ToolRiskLevel[] = ['read', 'write', 'destructive'];

  it('every tool has a valid riskLevel', () => {
    const specs = getToolSpecs('full');
    const issues: string[] = [];
    for (const spec of specs) {
      if (!validRiskLevels.includes(spec.riskLevel)) {
        issues.push(`[${spec.name}] invalid riskLevel: ${spec.riskLevel}`);
      }
    }
    if (issues.length > 0) {
      throw new Error(`Risk level violations:\n${issues.join('\n')}`);
    }
  });

  it('riskLevel matches HEP_TOOL_RISK_LEVELS local map', () => {
    const specs = getToolSpecs('full');
    const mismatches: string[] = [];
    for (const spec of specs) {
      const expected = HEP_TOOL_RISK_LEVELS[spec.name];
      if (expected === undefined) {
        mismatches.push(`[${spec.name}] missing from HEP_TOOL_RISK_LEVELS`);
      } else if (spec.riskLevel !== expected) {
        mismatches.push(`[${spec.name}] riskLevel=${spec.riskLevel} but HEP_TOOL_RISK_LEVELS says ${expected}`);
      }
    }
    if (mismatches.length > 0) {
      throw new Error(`HEP_TOOL_RISK_LEVELS drift:\n${mismatches.join('\n')}`);
    }
  });

  it('HEP_TOOL_RISK_LEVELS has no stale entries', () => {
    const specs = getToolSpecs('full');
    const registeredNames = new Set(specs.map(s => s.name));
    const stale: string[] = [];
    for (const name of Object.keys(HEP_TOOL_RISK_LEVELS)) {
      if (registeredNames.has(name)) continue;
      stale.push(name);
    }
    if (stale.length > 0) {
      throw new Error(`Stale HEP_TOOL_RISK_LEVELS entries:\n${stale.join('\n')}`);
    }
  });

  it('destructive tools include _confirm in Zod schema', () => {
    const specs = getToolSpecs('full');
    const destructiveSpecs = specs.filter(s => s.riskLevel === 'destructive');
    expect(destructiveSpecs.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const spec of destructiveSpecs) {
      const mcpSchema = zodToMcpInputSchema(spec.zodSchema);
      const props = (mcpSchema as any).properties ?? {};
      if (!props._confirm) {
        missing.push(spec.name);
      }
    }
    if (missing.length > 0) {
      throw new Error(`Destructive tools missing _confirm in schema:\n${missing.join('\n')}`);
    }
  });

  it('does not expose generic orchestrator tool surface through hep-mcp', () => {
    const names = new Set(getToolSpecs('full').map(spec => spec.name));
    expect(Array.from(names).some(name => name.startsWith('orch_'))).toBe(false);
  });

  it('hep-mcp keeps no run substrate of its own: no hep_run_* tools and no run_id parameter', () => {
    const tools = getTools('full');
    expect(tools.map(tool => tool.name).filter(name => name.startsWith('hep_run_'))).toEqual([]);
    const withRunId = tools
      .filter(tool => Object.prototype.hasOwnProperty.call((tool.inputSchema as any).properties ?? {}, 'run_id'))
      .map(tool => tool.name);
    expect(withRunId).toEqual([]);
  });
});

describe('Destructive tool confirmation gate (H-11a Phase 2)', () => {
  it('destructive tool without _confirm returns CONFIRMATION_REQUIRED', async () => {
    // A destructive tool with invalid args: the confirmation check comes before validation.
    const res = await handleToolCall('hepdata_download', { hepdata_id: -1 }, 'standard');
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(payload.error.data.tool).toBe('hepdata_download');
    expect(payload.error.data.risk_level).toBe('destructive');
    expect(payload.error.data.next_actions).toHaveLength(1);
    expect(payload.error.data.next_actions[0].args._confirm).toBe(true);
  });

  it('destructive tool with _confirm: true passes confirmation gate', async () => {
    // With _confirm: true it passes the gate and stops at argument validation
    // (hepdata_id must be positive), before any network call.
    const res = await handleToolCall('hepdata_download', { hepdata_id: -1, _confirm: true }, 'standard');
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    // Should NOT be CONFIRMATION_REQUIRED — it passed the gate
    expect(payload.error?.code).not.toBe('CONFIRMATION_REQUIRED');
  });

  it('non-destructive tools are not affected by _confirm gate', async () => {
    // A read tool should work without _confirm
    const res = await handleToolCall('hep_health', { check_inspire: false, inspire_timeout_ms: 1000 }, 'standard');
    expect(res.isError).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP annotations, titles and structuredContent
// ─────────────────────────────────────────────────────────────────────────────

describe('MCP annotations and titles', () => {
  it('every listed tool carries a non-empty title and all four boolean hints', () => {
    const issues: string[] = [];
    const tools = getTools('full');
    expect(tools).toHaveLength(58);
    for (const tool of tools) {
      if (typeof tool.title !== 'string' || tool.title.trim() === '') issues.push(`${tool.name}: missing title`);
      const annotations = tool.annotations as unknown as Record<string, unknown> | undefined;
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        if (typeof annotations?.[hint] !== 'boolean') issues.push(`${tool.name}: ${hint} is not a boolean`);
      }
    }
    expect(issues).toEqual([]);
  });

  it('agrees with the standalone servers for every re-exported tool', () => {
    const standalone = [
      ...getArxivTools('full'),
      ...getHepdataTools('full'),
      ...getOpenalexTools('full'),
      ...getPdgTools('full'),
      ...getZoteroTools('full'),
    ];
    const hepByName = new Map(getTools('full').map(t => [t.name, t]));
    const mismatches: string[] = [];
    for (const tool of standalone) {
      const hep = hepByName.get(tool.name);
      if (!hep) {
        mismatches.push(`${tool.name}: not listed by hep-mcp`);
        continue;
      }
      if (hep.title !== tool.title) mismatches.push(`${tool.name}: title ${hep.title} != ${tool.title}`);
      if (stableStringify(hep.annotations) !== stableStringify(tool.annotations)) {
        mismatches.push(`${tool.name}: annotations ${stableStringify(hep.annotations)} != ${stableStringify(tool.annotations)}`);
      }
    }
    expect(standalone).toHaveLength(35);
    expect(mismatches).toEqual([]);
  });

  it('readOnlyHint and destructiveHint follow the riskLevel that gates _confirm', () => {
    const issues: string[] = [];
    const specsByName = new Map(getToolSpecs('full').map(s => [s.name, s]));
    for (const tool of getTools('full')) {
      const risk = specsByName.get(tool.name)!.riskLevel;
      if (tool.annotations.readOnlyHint !== (risk === 'read')) issues.push(`${tool.name}: readOnlyHint vs ${risk}`);
      if (risk === 'destructive' && !tool.annotations.destructiveHint) issues.push(`${tool.name}: destructive without destructiveHint`);
    }
    expect(issues).toEqual([]);
  });
});

describe('structuredContent', () => {
  async function callWith(name: string, args: Record<string, unknown>, result: unknown) {
    const spec = getToolSpecs('full').find(s => s.name === name)!;
    const original = spec.handler;
    spec.handler = (async () => result) as typeof spec.handler;
    try {
      return await handleToolCall(name, args, 'full');
    } finally {
      spec.handler = original;
    }
  }

  it('mirrors the JSON text block of an object result', async () => {
    const res = await callWith('hep_health', {}, { ok: true, nested: { values: [1, 2] }, skipped: undefined });
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent).toEqual(JSON.parse(res.content[0]!.text));
  });

  it('carries the compacted object the text shows, not the full result', async () => {
    const paper = {
      recid: '1', title: 'T', authors: ['A', 'B', 'C', 'D'], author_count: 4,
      abstract: 'long abstract', inspire_url: 'https://inspirehep.net/literature/1',
    };
    const res = await callWith('inspire_search_next', { next_url: 'https://inspirehep.net/api/literature?q=x' }, { total: 1, papers: [paper] });
    expect(res.structuredContent).toEqual(JSON.parse(res.content[0]!.text));
    const papers = (res.structuredContent as { papers: Array<Record<string, unknown>> }).papers;
    expect(papers[0]!.abstract).toBeUndefined();
    expect(papers[0]!.authors).toEqual(['A', 'B', 'C']);
  });

  it('is kept between the soft and hard byte caps and left out once the text is truncated', async () => {
    const between = await callWith('hep_health', {}, { blob: 'x'.repeat(50_000) });
    expect(between.structuredContent).toEqual(JSON.parse(between.content[0]!.text));

    const truncated = await callWith('hep_health', {}, { blob: 'x'.repeat(100_000) });
    expect(truncated.content[0]!.text).toContain('[TRUNCATED');
    expect(truncated.structuredContent).toBeUndefined();
  });

  it('is left out for markdown text, string and array results', async () => {
    const markdown = await callWith('inspire_search', { query: 't:x', format: 'markdown' }, { total: 0, papers: [] });
    expect(() => JSON.parse(markdown.content[0]!.text)).toThrow();
    expect(markdown.structuredContent).toBeUndefined();
    expect((await callWith('hep_health', {}, 'plain text')).structuredContent).toBeUndefined();
    expect((await callWith('hep_health', {}, [1, 2])).structuredContent).toBeUndefined();
  });
});

describe('Tool inputSchema required keys', () => {
  it.each<ToolExposureMode>(['standard', 'full'])('required lists exactly the keys whose omission fails to parse (%s)', mode => {
    const specs = new Map(getToolSpecs(mode).map(spec => [spec.name, spec]));
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
    const specs = new Map(getToolSpecs(mode).map(spec => [spec.name, spec]));
    const issues = getTools(mode).flatMap(def => {
      const spec = specs.get(def.name);
      if (!spec) return [`[${def.name}] no tool spec`];
      return findBudgetBoundMismatches(spec.zodSchema, def.inputSchema).map(issue => `[${def.name}] ${issue}`);
    });
    expect(issues).toEqual([]);
  });
});
