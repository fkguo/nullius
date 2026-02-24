import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DiscoverPapersToolSchema_legacy,
  FieldSurveyToolSchema_legacy,
  NetworkAnalysisToolSchema_legacy,
  TopicAnalysisToolSchema_legacy,
} from '../../src/tools/research/schemas.js';

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

const { handleToolCall, getToolSpecs } = await import('../../src/tools/index.js');
const topicAnalysis = await import('../../src/tools/research/topicAnalysis.js');
const discoverPapers = await import('../../src/tools/research/discoverPapers.js');
const networkAnalysis = await import('../../src/tools/research/networkAnalysis.js');
const fieldSurvey = await import('../../src/tools/research/fieldSurvey.js');

function getFacadeSchema(): { safeParse: (value: unknown) => { success: boolean } } {
  const spec = getToolSpecs('standard').find(s => s.name === 'inspire_research_navigator');
  if (!spec) {
    throw new Error('Missing inspire_research_navigator from standard tool specs');
  }
  return spec.zodSchema;
}

describe('Research navigator parity vs legacy schemas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('topic_analysis parity: forwards topic_options.sociology_options', async () => {
    vi.mocked(topicAnalysis.analyzeTopicUnified).mockResolvedValueOnce({ ok: true } as any);

    const legacyArgs = {
      topic: 'qcd',
      mode: 'emerging' as const,
      limit: 6,
      options: {
        include_sociology: true,
        sample_mode: 'fast' as const,
        sociology_options: {
          disruption: {
            max_refs_to_check: 21,
            nk_search_limit_fast: 12,
          },
          new_entrant: {
            fast_mode_sample_size: 10,
          },
        },
      },
    };

    expect(TopicAnalysisToolSchema_legacy.safeParse(legacyArgs).success).toBe(true);

    const facadeArgs = {
      mode: 'topic_analysis' as const,
      topic: legacyArgs.topic,
      topic_mode: legacyArgs.mode,
      limit: legacyArgs.limit,
      topic_options: legacyArgs.options,
    };

    expect(getFacadeSchema().safeParse(facadeArgs).success).toBe(true);

    const res = await handleToolCall('inspire_research_navigator', facadeArgs);
    expect(res.isError).toBeFalsy();
    expect(topicAnalysis.analyzeTopicUnified).toHaveBeenCalledWith(
      expect.objectContaining(legacyArgs)
    );
  });

  it('discover parity: forwards discover options/limit mapping', async () => {
    vi.mocked(discoverPapers.discoverPapers).mockResolvedValueOnce({ ok: true } as any);

    const legacyArgs = {
      mode: 'expansion' as const,
      seed_recids: ['101', '202'],
      limit: 13,
      options: {
        direction: 'forward' as const,
        depth: 2,
        filters: {
          min_citations: 10,
          year_range: { start: 2015, end: 2024 },
        },
      },
    };

    expect(DiscoverPapersToolSchema_legacy.safeParse(legacyArgs).success).toBe(true);

    const facadeArgs = {
      mode: 'discover' as const,
      discover_mode: legacyArgs.mode,
      seed_recids: legacyArgs.seed_recids,
      limit: legacyArgs.limit,
      discover_options: legacyArgs.options,
    };

    expect(getFacadeSchema().safeParse(facadeArgs).success).toBe(true);

    const res = await handleToolCall('inspire_research_navigator', facadeArgs);
    expect(res.isError).toBeFalsy();
    expect(discoverPapers.discoverPapers).toHaveBeenCalledWith(
      expect.objectContaining(legacyArgs)
    );
  });

  it('network parity: forwards network_options mapping', async () => {
    vi.mocked(networkAnalysis.analyzeNetwork).mockResolvedValueOnce({ ok: true } as any);

    const legacyArgs = {
      mode: 'collaboration' as const,
      seed: 'hep-ph',
      limit: 9,
      options: {
        network_mode: 'topic' as const,
        depth: 3,
        min_papers: 4,
        max_seed_authors_for_expansion: 5,
      },
    };

    expect(NetworkAnalysisToolSchema_legacy.safeParse(legacyArgs).success).toBe(true);

    const facadeArgs = {
      mode: 'network' as const,
      network_mode: legacyArgs.mode,
      seed: legacyArgs.seed,
      limit: legacyArgs.limit,
      network_options: legacyArgs.options,
    };

    expect(getFacadeSchema().safeParse(facadeArgs).success).toBe(true);

    const res = await handleToolCall('inspire_research_navigator', facadeArgs);
    expect(res.isError).toBeFalsy();
    expect(networkAnalysis.analyzeNetwork).toHaveBeenCalledWith(
      expect.objectContaining(legacyArgs)
    );
  });

  it('field_survey parity: forwards iterations/prefer_journal/focus', async () => {
    vi.mocked(fieldSurvey.performFieldSurvey).mockResolvedValueOnce({ ok: true } as any);

    const legacyArgs = {
      topic: 'qcd',
      iterations: 4,
      prefer_journal: true,
      focus: ['controversies', 'methodology'] as const,
    };

    expect(FieldSurveyToolSchema_legacy.safeParse(legacyArgs).success).toBe(true);

    const facadeArgs = {
      mode: 'field_survey' as const,
      ...legacyArgs,
    };

    expect(getFacadeSchema().safeParse(facadeArgs).success).toBe(true);

    const res = await handleToolCall('inspire_research_navigator', facadeArgs);
    expect(res.isError).toBeFalsy();
    expect(fieldSurvey.performFieldSurvey).toHaveBeenCalledWith(
      expect.objectContaining(legacyArgs)
    );
  });

  it('evolution guard: mapped invalid legacy payloads are rejected by facade schema', () => {
    const invalidDiscoverLegacy = {
      mode: 'related' as const,
      limit: 5,
    };
    const invalidDiscoverFacade = {
      mode: 'discover' as const,
      discover_mode: 'related' as const,
      limit: 5,
    };

    expect(DiscoverPapersToolSchema_legacy.safeParse(invalidDiscoverLegacy).success).toBe(false);
    expect(getFacadeSchema().safeParse(invalidDiscoverFacade).success).toBe(false);

    const invalidNetworkLegacy = {
      mode: 'citation' as const,
      limit: 10,
    };
    const invalidNetworkFacade = {
      mode: 'network' as const,
      network_mode: 'citation' as const,
      limit: 10,
    };

    expect(NetworkAnalysisToolSchema_legacy.safeParse(invalidNetworkLegacy).success).toBe(false);
    expect(getFacadeSchema().safeParse(invalidNetworkFacade).success).toBe(false);
  });
});
