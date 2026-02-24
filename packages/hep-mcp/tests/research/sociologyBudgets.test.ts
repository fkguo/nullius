import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/api/client.js', () => ({
  getCitations: vi.fn(),
  getReferences: vi.fn(),
  search: vi.fn(),
}));

vi.mock('../../src/tools/research/emergingPapers.js', () => ({
  findEmergingPapers: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const { calculateDisruptionIndex } = await import('../../src/tools/research/disruptionIndex.js');
const { analyzeNewEntrants } = await import('../../src/tools/research/newEntrantRatio.js');
const emerging = await import('../../src/tools/research/emergingPapers.js');
const { analyzeTopicUnified } = await import('../../src/tools/research/topicAnalysis.js');
const { getToolSpecs } = await import('../../src/tools/index.js');

describe('Sociology P1 budgets: configurable + warnings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('disruptionIndex emits warnings and diagnostics when budgets are hit', async () => {
    vi.mocked(api.getCitations).mockResolvedValueOnce({
      total: 40,
      papers: [],
      has_more: false,
    } as any);

    vi.mocked(api.getReferences).mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, i) => ({
        recid: String(1000 + i),
      })) as any
    );

    vi.mocked(api.search).mockImplementation(async (query: string) => {
      // N_k estimation queries:
      //   refersto:recid:<ref> and not refersto:recid:<target>
      if (query.includes(' and not refersto:recid:42')) {
        const ref = query.match(/refersto:recid:(\d+)/)?.[1] ?? 'x';
        return {
          total: 100,
          papers: [{ recid: `nk_${ref}` }],
          has_more: true,
        } as any;
      }

      // N_j combined query
      return { total: 30, papers: [], has_more: false } as any;
    });

    const res = await calculateDisruptionIndex({ recid: '42', sample_mode: 'fast' });

    expect(res.sample_size).toBe(40);
    expect(res.n_j).toBe(30);
    expect(res.n_i).toBe(10);
    expect(res.n_k).toBe(10);
    expect(res.disruption_index).toBe(-0.4);
    expect(res.interpretation).toBe('consolidating');
    expect(res.confidence).toBe('low');

    expect(res.warnings?.some(w => w.includes('max_refs_to_check'))).toBe(true);
    expect(res.warnings?.some(w => w.includes('max_refs_for_nj_query'))).toBe(true);
    expect(res.warnings?.some(w => w.includes('max_refs_for_nk_estimate'))).toBe(true);
    expect(res.warnings?.some(w => w.includes('nk_search_limit'))).toBe(true);

    expect(res.diagnostics?.refs_total).toBe(100);
    expect(res.diagnostics?.refs_used_for_set).toBe(20);
    expect(res.diagnostics?.nj_refs_used).toBe(15);
    expect(res.diagnostics?.nk_refs_used).toBe(5);
    expect(res.diagnostics?.nk_search_truncated_queries).toBeGreaterThan(0);
  });

  it('newEntrantRatio warns on truncated author lists and fast-mode sampling', async () => {
    vi.mocked(api.search).mockResolvedValue({
      total: 0,
      papers: [],
      has_more: false,
    } as any);

    const res = await analyzeNewEntrants({
      topic: 'qcd',
      sample_mode: 'fast',
      fast_mode_sample_size: 2,
      lookback_years: 5,
      papers: [
        {
          recid: '1',
          title: 'Big collaboration paper (truncated authors)',
          authors: ['Alice', 'Bob', 'Charlie'],
          author_count: 3000,
          citation_count: 100,
        },
        {
          recid: '2',
          title: 'Small team paper',
          authors: ['Dave', 'Eve', 'Frank'],
          author_count: 3,
          citation_count: 50,
        },
      ] as any,
    });

    expect(res.sample_mode).toBe('fast');
    expect(res.total_unique_authors).toBe(6);
    expect(res.sample_size).toBe(2);
    expect(res.new_entrant_ratio).toBe(1);
    expect(res.warnings?.some(w => w.includes('author_count>authors.length'))).toBe(true);
    expect(res.warnings?.some(w => w.includes('Fast mode checks only top'))).toBe(true);
  });

  it('research_navigator schema accepts topic_options.sociology_options and forwards them to emergingPapers', async () => {
    const spec = getToolSpecs('standard').find(s => s.name === 'inspire_research_navigator');
    expect(spec).toBeTruthy();

    // Schema accept (no throw)
    spec!.zodSchema.parse({
      mode: 'topic_analysis',
      topic: 'qcd',
      topic_mode: 'emerging',
      topic_options: {
        include_sociology: true,
        sample_mode: 'fast',
        sociology_options: {
          disruption: {
            max_refs_to_check: 33,
            nk_search_limit_fast: 20,
          },
          new_entrant: {
            fast_mode_sample_size: 12,
          },
        },
      },
    });

    vi.mocked(emerging.findEmergingPapers).mockResolvedValueOnce({
      topic: 'qcd',
      papers: [],
      total_candidates: 0,
    } as any);

    await analyzeTopicUnified({
      topic: 'qcd',
      mode: 'emerging',
      limit: 7,
      options: {
        include_sociology: true,
        sample_mode: 'fast',
        sociology_options: {
          disruption: { max_refs_to_check: 33, nk_search_limit_fast: 20 },
          new_entrant: { fast_mode_sample_size: 12 },
        },
      },
    });

    expect(vi.mocked(emerging.findEmergingPapers)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emerging.findEmergingPapers)).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'qcd',
        limit: 7,
        include_sociology: true,
        sample_mode: 'fast',
        sociology_options: {
          disruption: { max_refs_to_check: 33, nk_search_limit_fast: 20 },
          new_entrant: { fast_mode_sample_size: 12 },
        },
      })
    );
  });
});
