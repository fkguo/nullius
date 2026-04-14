import { describe, it, expect } from 'vitest';

import { getToolSpecs, getTools, handleToolCall } from '../src/tools/index.js';
import { zodToMcpInputSchema } from '../src/tools/mcpSchema.js';
import type { ToolExposureMode, ToolSpec } from '../src/tools/registry.js';
import { HEP_TOOL_RISK_LEVELS, type ToolRiskLevel } from '../src/tool-risk.js';
import * as T from '../src/tool-names.js';
import { InspireSearchToolSchema } from '../src/tools/registry/inspireSchemas.js';
import {
  HepRunBuildMeasurementsToolSchema,
  HepProjectQueryEvidenceToolSchema,
  HepProjectCompareMeasurementsToolSchema,
} from '../src/tools/registry/projectSchemas.js';

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

  it('inspire_literature metadata explicitly distinguishes get_paper compatibility from strict lookup_by_id usage', () => {
    const tool = getTools('standard').find(t => t.name === 'inspire_literature');
    expect(tool).toBeDefined();
    expect(tool?.description).toContain('get_paper: { recid } only. Do not pass size, page, or options.');
    expect(tool?.description).toContain('lookup_by_id: { identifier } only. Do not pass size, sort, page, or options.');
    expect((tool?.inputSchema as any).properties.size.description).toContain("Do not provide for lookup_by_id");
    expect((tool?.inputSchema as any).properties.identifier.description).toContain('For lookup_by_id, pass identifier only');
  });

  it('inspire_search falls back to defaults for invalid max_results budgets', () => {
    const parsed = InspireSearchToolSchema.parse({
      query: 'qcd',
      max_results: -100,
      page: '\r\t-5',
    });
    expect(parsed.max_results).toBe(100);
    expect(parsed.page).toBe(1);
  });

  it('hep_run_build_measurements no longer clamps invalid max_results; it falls back to default', () => {
    const parsed = HepRunBuildMeasurementsToolSchema.parse({
      run_id: 'run-1',
      max_results: 999999,
    });
    expect(parsed.max_results).toBe(500);
  });

  it('hep_project_query_evidence falls back to defaults for invalid concurrency/limit budgets', () => {
    const parsed = HepProjectQueryEvidenceToolSchema.parse({
      project_id: 'project-1',
      query: 'beta function',
      concurrency: -100,
      limit: '\r\t999',
    });
    expect(parsed.concurrency).toBe(4);
    expect(parsed.limit).toBe(10);
  });

  it('non-budget numeric params remain fail-closed', () => {
    expect(HepProjectCompareMeasurementsToolSchema.safeParse({
      run_id: 'run-1',
      input_runs: [{ run_id: 'run-a' }, { run_id: 'run-b' }],
      min_tension_sigma: -1,
    }).success).toBe(false);
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

  it('hep-mcp tool surface keeps hep_run_* distinct without also exporting orch_*', () => {
    const names = getTools('full').map(tool => tool.name);
    const orchNames = names.filter(name => name.startsWith('orch_'));
    const hepRunNames = new Set(names.filter(name => name.startsWith(T.HEP_RUN_PREFIX)));
    expect(orchNames.length).toBe(0);
    expect(orchNames.filter(name => hepRunNames.has(name))).toEqual([]);
  });
});

describe('Destructive tool confirmation gate (H-11a Phase 2)', () => {
  it('destructive tool without _confirm returns CONFIRMATION_REQUIRED', async () => {
    // Use a destructive tool with minimal args (will fail validation but confirmation check is first)
    const res = await handleToolCall('hep_export_project', { run_id: 'test-run' }, 'standard');
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(payload.error.data.tool).toBe('hep_export_project');
    expect(payload.error.data.risk_level).toBe('destructive');
    expect(payload.error.data.next_actions).toHaveLength(1);
    expect(payload.error.data.next_actions[0].args._confirm).toBe(true);
  });

  it('destructive tool with _confirm: true passes confirmation gate', async () => {
    // With _confirm: true, it should pass the gate and hit the normal handler
    // (which will fail for other reasons since test-run doesn't exist, but the error code should differ)
    const res = await handleToolCall('hep_export_project', { run_id: 'nonexistent-run', _confirm: true }, 'standard');
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
