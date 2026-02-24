import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InspireAdvancedToolSchema_legacy } from '../../src/tools/research/schemas.js';

vi.mock('../../src/tools/research/experts.js', () => ({
  findExperts: vi.fn(),
}));

vi.mock('../../src/tools/research/findConnections.js', () => ({
  findConnections: vi.fn(),
}));

vi.mock('../../src/tools/research/traceSource.js', () => ({
  traceOriginalSource: vi.fn(),
}));

vi.mock('../../src/tools/research/analyzePapers.js', () => ({
  analyzePapers: vi.fn(),
}));

const { handleToolCall, getToolSpecs } = await import('../../src/tools/index.js');
const experts = await import('../../src/tools/research/experts.js');
const findConnections = await import('../../src/tools/research/findConnections.js');
const traceSource = await import('../../src/tools/research/traceSource.js');
const analyzePapers = await import('../../src/tools/research/analyzePapers.js');

function getFacadeSchema(): { safeParse: (value: unknown) => { success: boolean } } {
  const spec = getToolSpecs('standard').find(s => s.name === 'inspire_research_navigator');
  if (!spec) {
    throw new Error('Missing inspire_research_navigator from standard tool specs');
  }
  return spec.zodSchema;
}

describe('Research navigator parity vs inspire_advanced legacy schema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('experts parity: find_experts -> experts', async () => {
    vi.mocked(experts.findExperts).mockResolvedValueOnce({ topic: 'qcd', experts: [] } as any);

    const legacyArgs = {
      mode: 'find_experts' as const,
      topic: 'qcd',
      limit: 5,
      format: 'markdown' as const,
    };

    expect(InspireAdvancedToolSchema_legacy.safeParse(legacyArgs).success).toBe(true);

    const facadeArgs = {
      mode: 'experts' as const,
      topic: legacyArgs.topic,
      limit: legacyArgs.limit,
      format: legacyArgs.format,
    };

    expect(getFacadeSchema().safeParse(facadeArgs).success).toBe(true);

    const res = await handleToolCall('inspire_research_navigator', facadeArgs);
    expect(res.isError).toBeFalsy();
    expect(experts.findExperts).toHaveBeenCalledWith({ topic: 'qcd', limit: 5 });
    expect(res.content[0]?.text).toContain('## Experts in "qcd"');
  });

  it('connections parity: find_connections -> connections', async () => {
    vi.mocked(findConnections.findConnections).mockResolvedValueOnce({ ok: true } as any);

    const legacyArgs = {
      mode: 'find_connections' as const,
      recids: ['1', '2'],
      include_external: true,
      max_external_depth: 2,
    };

    expect(InspireAdvancedToolSchema_legacy.safeParse(legacyArgs).success).toBe(true);

    const facadeArgs = {
      mode: 'connections' as const,
      seed_recids: legacyArgs.recids,
      include_external: legacyArgs.include_external,
      max_external_depth: legacyArgs.max_external_depth,
    };

    expect(getFacadeSchema().safeParse(facadeArgs).success).toBe(true);

    const res = await handleToolCall('inspire_research_navigator', facadeArgs);
    expect(res.isError).toBeFalsy();
    expect(findConnections.findConnections).toHaveBeenCalledWith({
      recids: ['1', '2'],
      include_external: true,
      max_external_depth: 2,
    });
  });

  it('trace parity: trace_original_source -> trace_source', async () => {
    vi.mocked(traceSource.traceOriginalSource).mockResolvedValueOnce({ ok: true } as any);

    const legacyArgs = {
      mode: 'trace_original_source' as const,
      recid: '1',
      max_depth: 3,
      max_refs_per_level: 2,
      cross_validate: true,
    };

    expect(InspireAdvancedToolSchema_legacy.safeParse(legacyArgs).success).toBe(true);

    const facadeArgs = {
      mode: 'trace_source' as const,
      seed: legacyArgs.recid,
      max_depth: legacyArgs.max_depth,
      max_refs_per_level: legacyArgs.max_refs_per_level,
      cross_validate: legacyArgs.cross_validate,
    };

    expect(getFacadeSchema().safeParse(facadeArgs).success).toBe(true);

    const res = await handleToolCall('inspire_research_navigator', facadeArgs);
    expect(res.isError).toBeFalsy();
    expect(traceSource.traceOriginalSource).toHaveBeenCalledWith({
      recid: '1',
      max_depth: 3,
      max_refs_per_level: 2,
      cross_validate: true,
    });
  });

  it('analyze parity: analyze_papers -> analyze (compat)', async () => {
    vi.mocked(analyzePapers.analyzePapers).mockResolvedValueOnce({ ok: true } as any);

    const legacyArgs = {
      mode: 'analyze_papers' as const,
      recids: ['1', '2'],
      analysis_type: ['overview'] as const,
    };

    expect(InspireAdvancedToolSchema_legacy.safeParse(legacyArgs).success).toBe(true);

    const facadeArgs = {
      mode: 'analyze' as const,
      recids: legacyArgs.recids,
      analysis_type: legacyArgs.analysis_type,
    };

    expect(getFacadeSchema().safeParse(facadeArgs).success).toBe(true);

    const res = await handleToolCall('inspire_research_navigator', facadeArgs);
    expect(res.isError).toBeFalsy();
    expect(analyzePapers.analyzePapers).toHaveBeenCalledWith({
      recids: ['1', '2'],
      analysis_type: ['overview'],
    });
  });

  it('evolution guard: invalid legacy payloads map to invalid facade payloads', () => {
    const invalidConnectionsLegacy = {
      mode: 'find_connections' as const,
      include_external: true,
    };
    const invalidConnectionsFacade = {
      mode: 'connections' as const,
      include_external: true,
    };

    expect(InspireAdvancedToolSchema_legacy.safeParse(invalidConnectionsLegacy).success).toBe(false);
    expect(getFacadeSchema().safeParse(invalidConnectionsFacade).success).toBe(false);

    const invalidTraceLegacy = {
      mode: 'trace_original_source' as const,
      max_depth: 2,
    };
    const invalidTraceFacade = {
      mode: 'trace_source' as const,
      max_depth: 2,
    };

    expect(InspireAdvancedToolSchema_legacy.safeParse(invalidTraceLegacy).success).toBe(false);
    expect(getFacadeSchema().safeParse(invalidTraceFacade).success).toBe(false);
  });
});
