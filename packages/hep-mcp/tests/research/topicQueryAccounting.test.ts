import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopicEvolutionSchema, TopicEvolutionParamsSchema, type PaperSummary } from '@nullius/shared';

vi.mock('../../src/api/client.js', () => ({ search: vi.fn(), searchByUrl: vi.fn() }));
const api = await import('../../src/api/client.js');
const { buildResearchTimeline } = await import('../../src/tools/research/timeline.js');
const { analyzeTopicEvolution } = await import('../../src/tools/research/topicEvolution.js');

function paper(recid: string, citation_count?: number): PaperSummary {
  return { recid, title: `Paper ${recid}`, authors: ['Author A', 'Author B', 'Author C', 'Author D'], citation_count };
}
function result(total: number, papers: PaperSummary[] = []) {
  return { total, papers, has_more: false };
}

beforeEach(() => vi.resetAllMocks());

describe('topic timeline query accounting', () => {
  it('counts the same requested population and time interval, and labels sampled citations', async () => {
    vi.mocked(api.search).mockImplementation(async (query, options) => {
      if (query === '(quantum or optical) and date:2020->2021' && options?.size === 1) return result(220);
      if (query === '(quantum or optical) and date:2020->2020') return result(100, [paper('1', 7), paper('2', 3)]);
      if (query === '(quantum or optical) and date:2021->2021') return result(120, [paper('3', 20)]);
      throw new Error(`Unexpected query: ${query}`);
    });
    const timeline = await buildResearchTimeline({ topic: 'quantum or optical', start_year: 2020, end_year: 2021 });
    expect(timeline.total_papers).toBe(220);
    expect(timeline.total_search.query).toBe('(quantum or optical) and date:2020->2021');
    expect(timeline.phases.map(phase => phase.paper_count)).toEqual([100, 120]);
    expect(timeline.phases[0]).toMatchObject({ sample_citation_sum: 10, missing_citation_count: 0, search: {
      requested_page_size: 5, sort: 'mostcited', returned_count: 2, sample_complete: false,
    } });
    expect(timeline.phases[0]).not.toHaveProperty('citation_sum');
    expect(timeline.coverage).toEqual({ period_queries: 'complete', paper_samples: 'partial' });
    expect(api.search).toHaveBeenCalledTimes(3);
  });

  it('retains true zero years and marks failed years unavailable rather than zero', async () => {
    vi.mocked(api.search).mockImplementation(async (query, options) => {
      if (options?.size === 1) return result(12);
      if (query.endsWith('2020->2020')) return result(0);
      throw new Error('503 upstream unavailable');
    });
    const timeline = await buildResearchTimeline({ topic: 'topic', start_year: 2020, end_year: 2021 });
    expect(timeline.phases).toHaveLength(2);
    expect(timeline.phases[0]).toMatchObject({ paper_count: 0, sample_citation_sum: 0, search: { status: 'available', returned_count: 0, sample_complete: true, has_more: false } });
    expect(timeline.phases[1]).toMatchObject({ paper_count: null, sample_citation_sum: null, search: { status: 'unavailable', returned_count: null, sample_complete: null, has_more: null, error: '503 upstream unavailable' } });
    expect(timeline.coverage.period_queries).toBe('partial');
  });

  it('keeps an unavailable interval total distinct from available yearly counts', async () => {
    vi.mocked(api.search).mockImplementation(async (_query, options) => {
      if (options?.size === 1) throw new Error('total lookup unavailable');
      return result(1, [paper('1', 2)]);
    });
    const timeline = await buildResearchTimeline({ topic: 'topic', start_year: 2020, end_year: 2020 });
    expect(timeline.total_papers).toBeNull();
    expect(timeline.total_search).toMatchObject({ status: 'unavailable', error: 'total lookup unavailable' });
    expect(timeline.phases[0].paper_count).toBe(1);
  });

  it('does not silently replace an unknown sampled citation count with zero', async () => {
    vi.mocked(api.search).mockResolvedValue(result(2, [paper('1', 2), paper('2')]));
    const timeline = await buildResearchTimeline({ topic: 'topic', start_year: 2020, end_year: 2020 });
    expect(timeline.phases[0]).toMatchObject({ sample_citation_sum: null, missing_citation_count: 1 });
  });

  it('declares a bounded default lookback without inferring an earliest year from a newest-first page', async () => {
    vi.mocked(api.search).mockResolvedValue(result(0));
    const timeline = await buildResearchTimeline({ topic: 'topic', end_year: 2020 });
    expect(timeline.time_range).toEqual({ start: 2000, end: 2020 });
    expect(timeline.time_range_basis).toBe('default_20_year_lookback');
    expect(timeline.phases).toHaveLength(21);
    expect(api.search).toHaveBeenCalledTimes(22);
  });

  it('rejects invalid intervals before querying the provider', async () => {
    await expect(buildResearchTimeline({ topic: 'topic', start_year: 2021, end_year: 2020 })).rejects.toThrow('start <= end');
    await expect(buildResearchTimeline({ topic: 'topic', start_year: 2020.5, end_year: 2021 })).rejects.toThrow('integer years');
    await expect(analyzeTopicEvolution({ topic: 'topic', start_year: 2021, end_year: 2020 })).rejects.toThrow('start <= end');
    expect(api.search).not.toHaveBeenCalled();
  });
});

describe('topic evolution sample and period accounting', () => {
  it.each([true, false])('rejects the retired include_subtopics option even when set to %s', async include_subtopics => {
    await expect(analyzeTopicEvolution({ topic: 'topic', start_year: 2020, end_year: 2024, include_subtopics } as never)).rejects.toThrow(/include_subtopics/);
    expect(api.search).not.toHaveBeenCalled();
  });

  it('preserves sample size, continuation and warnings instead of claiming a full-population author summary', async () => {
    vi.mocked(api.search).mockImplementation(async (_query, options) => options?.size === 1000 ? {
      total: 2000, papers: [paper('1', 10), paper('2', 5)], has_more: true,
      next_url: 'https://inspirehep.net/api/literature?page=2', warning: 'Provider result limit warning',
    } : result(300));
    const evolution = await analyzeTopicEvolution({ topic: 'topic', start_year: 2020, end_year: 2024 });
    expect(TopicEvolutionSchema.parse(evolution)).toEqual(evolution);
    expect(TopicEvolutionParamsSchema.parse({ topic: 'topic' }).granularity).toBe('5year');
    expect(evolution.phases[0]).toMatchObject({ paper_count: 2000, search: {
      status: 'available', requested_page_size: 1000, sort: 'mostcited', returned_count: 2,
      has_more: true, sample_complete: false, next_url: 'https://inspirehep.net/api/literature?page=2', warning: 'Provider result limit warning',
    } });
    expect(evolution.phases[0].key_authors).toEqual(['Author A', 'Author B', 'Author C']);
    expect(evolution.sample_basis.key_authors).toBe('occurrences_among_first_three_authors_of_sampled_papers');
    expect(evolution.coverage).toEqual({ period_queries: 'complete', paper_samples: 'partial' });
    expect(api.searchByUrl).not.toHaveBeenCalled();
    expect(evolution.phases[0]).not.toHaveProperty('citation_momentum');
    expect(evolution.current_status).not.toHaveProperty('growth_rate');
    expect(evolution.current_status).not.toHaveProperty('trend');
    expect(evolution).not.toHaveProperty('subtopics');
    expect(evolution.current_status).toMatchObject({ recent_papers: 300, time_range: { start: 2023, end: 2024 }, search: { query: '(topic) and date:2023->2024' } });
  });

  it('never computes a publication-count change across an unavailable period', async () => {
    vi.mocked(api.search).mockImplementation(async (query, options) => {
      if (options?.size === 1) return result(300);
      if (query.endsWith('2021->2021')) throw new Error('period offline');
      const count = query.endsWith('2020->2020') ? 10 : query.endsWith('2022->2022') ? 100 : 200;
      return result(count);
    });
    const evolution = await analyzeTopicEvolution({ topic: 'topic', start_year: 2020, end_year: 2023, granularity: 'year' });
    expect(evolution.phases.map(phase => phase.paper_count)).toEqual([10, null, 100, 200]);
    expect(evolution.phases.slice(0, 3).map(phase => phase.publication_count_change)).toEqual([null, null, null]);
    expect(evolution.phases[3].publication_count_change).toEqual({ previous_period: '2022', previous_paper_count: 100, fraction: 1 });
    expect(evolution.phases[1].search.status).toBe('unavailable');
    expect(evolution.coverage.period_queries).toBe('partial');
  });

  it('retains zero periods and distinguishes a zero denominator from a decrease to zero', async () => {
    vi.mocked(api.search).mockImplementation(async query => result(query.endsWith('2021->2021') ? 10 : 0));
    const evolution = await analyzeTopicEvolution({ topic: 'topic', start_year: 2020, end_year: 2022, granularity: 'year' });
    expect(evolution.phases.map(phase => phase.paper_count)).toEqual([0, 10, 0]);
    expect(evolution.phases[1].publication_count_change).toBeNull();
    expect(evolution.phases[2].publication_count_change).toEqual({ previous_period: '2021', previous_paper_count: 10, fraction: -1 });
  });

  it('does not compare a full period with a shorter final period', async () => {
    vi.mocked(api.search).mockResolvedValue(result(100));
    const evolution = await analyzeTopicEvolution({ topic: 'topic', start_year: 2020, end_year: 2025, granularity: '5year' });
    expect(evolution.phases.map(phase => phase.period)).toEqual(['2020-2024', '2025-2025']);
    expect(evolution.phases[1].publication_count_change).toBeNull();
  });

  it('exposes failure of the recent-count query without inventing a zero count', async () => {
    vi.mocked(api.search).mockImplementation(async (_query, options) => {
      if (options?.size === 1) throw new Error('recent query offline');
      return result(0);
    });
    const evolution = await analyzeTopicEvolution({ topic: 'topic', start_year: 2020, end_year: 2024 });
    expect(evolution.current_status).toMatchObject({ recent_papers: null, search: { status: 'unavailable', error: 'recent query offline' } });
    expect(evolution.phases[0].paper_count).toBe(0);
  });
});
