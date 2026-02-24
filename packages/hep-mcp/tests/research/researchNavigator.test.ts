import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/tools/research/topicAnalysis.js', () => ({
  analyzeTopicUnified: vi.fn(),
}));

vi.mock('../../src/tools/research/discoverPapers.js', () => ({
  discoverPapers: vi.fn(),
}));

vi.mock('../../src/tools/research/networkAnalysis.js', () => ({
  analyzeNetwork: vi.fn(),
}));

vi.mock('../../src/tools/research/fieldSurvey.js', () => ({
  performFieldSurvey: vi.fn(),
}));

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

const { handleToolCall, getToolSpecs, getTools } = await import('../../src/tools/index.js');
const topicAnalysis = await import('../../src/tools/research/topicAnalysis.js');
const discoverPapers = await import('../../src/tools/research/discoverPapers.js');
const networkAnalysis = await import('../../src/tools/research/networkAnalysis.js');
const fieldSurvey = await import('../../src/tools/research/fieldSurvey.js');
const experts = await import('../../src/tools/research/experts.js');
const findConnections = await import('../../src/tools/research/findConnections.js');
const traceSource = await import('../../src/tools/research/traceSource.js');
const analyzePapers = await import('../../src/tools/research/analyzePapers.js');

function parseErrorPayload(result: Awaited<ReturnType<typeof handleToolCall>>): {
  error?: {
    code?: string;
    data?: { issues?: Array<{ path?: Array<string | number> }> };
  };
} {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

describe('Research navigator facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches topic_analysis mode and forwards topic_options/limit', async () => {
    vi.mocked(topicAnalysis.analyzeTopicUnified).mockResolvedValueOnce({ ok: true } as any);

    const res = await handleToolCall('inspire_research_navigator', {
      mode: 'topic_analysis',
      topic: 'qcd',
      topic_mode: 'emerging',
      time_range: { start: 2020, end: 2025 },
      limit: 7,
      topic_options: {
        include_sociology: true,
        sample_mode: 'fast',
      },
    });

    expect(res.isError).toBeFalsy();
    expect(topicAnalysis.analyzeTopicUnified).toHaveBeenCalledTimes(1);
    expect(topicAnalysis.analyzeTopicUnified).toHaveBeenCalledWith({
      topic: 'qcd',
      mode: 'emerging',
      time_range: { start: 2020, end: 2025 },
      limit: 7,
      options: {
        include_sociology: true,
        sample_mode: 'fast',
      },
    });
  });

  it('dispatches discover mode and forwards discover_options/limit', async () => {
    vi.mocked(discoverPapers.discoverPapers).mockResolvedValueOnce({ ok: true } as any);

    const res = await handleToolCall('inspire_research_navigator', {
      mode: 'discover',
      discover_mode: 'related',
      seed_recids: ['1', '2'],
      limit: 11,
      discover_options: {
        strategy: 'co_citation',
        min_relevance: 0.66,
      },
    });

    expect(res.isError).toBeFalsy();
    expect(discoverPapers.discoverPapers).toHaveBeenCalledTimes(1);
    expect(discoverPapers.discoverPapers).toHaveBeenCalledWith({
      mode: 'related',
      seed_recids: ['1', '2'],
      limit: 11,
      options: {
        strategy: 'co_citation',
        min_relevance: 0.66,
      },
    });
  });

  it('dispatches network mode and forwards network_options/limit', async () => {
    vi.mocked(networkAnalysis.analyzeNetwork).mockResolvedValueOnce({ ok: true } as any);

    const res = await handleToolCall('inspire_research_navigator', {
      mode: 'network',
      network_mode: 'collaboration',
      seed: '123',
      limit: 9,
      network_options: {
        network_mode: 'author',
        depth: 2,
        max_seed_authors_for_expansion: 8,
      },
    });

    expect(res.isError).toBeFalsy();
    expect(networkAnalysis.analyzeNetwork).toHaveBeenCalledTimes(1);
    expect(networkAnalysis.analyzeNetwork).toHaveBeenCalledWith({
      mode: 'collaboration',
      seed: '123',
      limit: 9,
      options: {
        network_mode: 'author',
        depth: 2,
        max_seed_authors_for_expansion: 8,
      },
    });
  });

  it('dispatches field_survey mode', async () => {
    vi.mocked(fieldSurvey.performFieldSurvey).mockResolvedValueOnce({ ok: true } as any);

    const res = await handleToolCall('inspire_research_navigator', {
      mode: 'field_survey',
      topic: 'qcd',
      iterations: 3,
      prefer_journal: true,
      focus: ['controversies', 'methodology'],
    });

    expect(res.isError).toBeFalsy();
    expect(fieldSurvey.performFieldSurvey).toHaveBeenCalledTimes(1);
    expect(fieldSurvey.performFieldSurvey).toHaveBeenCalledWith({
      topic: 'qcd',
      iterations: 3,
      prefer_journal: true,
      focus: ['controversies', 'methodology'],
    });
  });

  it('dispatches experts mode with markdown formatting', async () => {
    vi.mocked(experts.findExperts).mockResolvedValueOnce({ topic: 'qcd', experts: [] } as any);

    const res = await handleToolCall('inspire_research_navigator', {
      mode: 'experts',
      topic: 'qcd',
      format: 'markdown',
      limit: 3,
    });

    expect(res.isError).toBeFalsy();
    expect(experts.findExperts).toHaveBeenCalledWith({ topic: 'qcd', limit: 3 });
    expect(res.content[0]?.text).toContain('## Experts in "qcd"');
  });

  it('dispatches connections mode and forwards include_external args', async () => {
    vi.mocked(findConnections.findConnections).mockResolvedValueOnce({ ok: true } as any);

    const res = await handleToolCall('inspire_research_navigator', {
      mode: 'connections',
      seed_recids: ['1', '2'],
      include_external: true,
      max_external_depth: 2,
    });

    expect(res.isError).toBeFalsy();
    expect(findConnections.findConnections).toHaveBeenCalledWith({
      recids: ['1', '2'],
      include_external: true,
      max_external_depth: 2,
    });
  });

  it('dispatches trace_source mode from seed_recids[0]', async () => {
    vi.mocked(traceSource.traceOriginalSource).mockResolvedValueOnce({ ok: true } as any);

    const res = await handleToolCall('inspire_research_navigator', {
      mode: 'trace_source',
      seed_recids: ['123'],
      max_depth: 3,
      max_refs_per_level: 2,
      cross_validate: false,
    });

    expect(res.isError).toBeFalsy();
    expect(traceSource.traceOriginalSource).toHaveBeenCalledWith({
      recid: '123',
      max_depth: 3,
      max_refs_per_level: 2,
      cross_validate: false,
    });
  });

  it('dispatches analyze mode (compat) to analyzePapers', async () => {
    vi.mocked(analyzePapers.analyzePapers).mockResolvedValueOnce({ ok: true } as any);

    const res = await handleToolCall('inspire_research_navigator', {
      mode: 'analyze',
      seed: '42',
      analysis_type: ['overview'],
    });

    expect(res.isError).toBeFalsy();
    expect(analyzePapers.analyzePapers).toHaveBeenCalledWith({ recids: ['42'], analysis_type: ['overview'] });
  });

  it('rejects invalid combination: network mode missing seed', async () => {
    const res = await handleToolCall('inspire_research_navigator', {
      mode: 'network',
      network_mode: 'citation',
    } as any);

    expect(res.isError).toBe(true);
    const payload = parseErrorPayload(res);
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['seed'] })])
    );
  });

  it('rejects invalid combination: discover mode missing discover_mode', async () => {
    const res = await handleToolCall('inspire_research_navigator', {
      mode: 'discover',
      topic: 'qcd',
    } as any);

    expect(res.isError).toBe(true);
    const payload = parseErrorPayload(res);
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['discover_mode'] })])
    );
  });

  it('rejects trace_source when seed_recids has multiple items', async () => {
    const res = await handleToolCall('inspire_research_navigator', {
      mode: 'trace_source',
      seed_recids: ['1', '2'],
    } as any);

    expect(res.isError).toBe(true);
    const payload = parseErrorPayload(res);
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['seed_recids'] })])
    );
  });

  it('rejects experts mode without topic', async () => {
    const res = await handleToolCall('inspire_research_navigator', {
      mode: 'experts',
    } as any);

    expect(res.isError).toBe(true);
    const payload = parseErrorPayload(res);
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['topic'] })])
    );
  });

  it('getTools exposes maturity prefixes and NOT FOR clauses', () => {
    const standardDescriptions = getTools('standard').map(t => t.description);
    const fullDescriptions = getTools('full').map(t => t.description);

    expect(standardDescriptions.some(d => d.startsWith('[Deprecated]'))).toBe(false);
    expect(fullDescriptions.some(d => d.startsWith('[Experimental]'))).toBe(true);
    expect(standardDescriptions.some(d => /NOT FOR\b/i.test(d))).toBe(true);

    const facade = getToolSpecs('standard').find(s => s.name === 'inspire_research_navigator');
    expect(facade).toBeTruthy();
  });
});
