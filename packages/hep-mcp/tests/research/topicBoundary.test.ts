import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopicAnalysisToolSchema } from '../../src/tools/research/schemas.js';

vi.mock('../../src/tools/research/timeline.js', () => ({ buildResearchTimeline: vi.fn() }));
vi.mock('../../src/tools/research/topicEvolution.js', () => ({ analyzeTopicEvolution: vi.fn() }));

const timeline = await import('../../src/tools/research/timeline.js');
const evolution = await import('../../src/tools/research/topicEvolution.js');
const { analyzeTopicUnified } = await import('../../src/tools/research/topicAnalysis.js');

beforeEach(() => vi.resetAllMocks());

describe('topic metadata boundary', () => {
  it('rejects the retired emerging mode instead of silently returning another analysis', () => {
    expect(TopicAnalysisToolSchema.safeParse({ topic: 'qcd', mode: 'emerging' }).success).toBe(false);
  });

  it.each([
    { min_momentum: 0.4 }, { min_citations: 20 }, { include_sociology: true },
    { sociology_options: { disruption: {} } }, { sample_mode: 'fast' },
    { include_subtopics: true }, { include_subtopics: false },
  ])('rejects retired ranking options: %j', options => {
    expect(TopicAnalysisToolSchema.safeParse({ topic: 'qcd', mode: 'all', options }).success).toBe(false);
  });

  it('retains both metadata views without adding a ranking or emerging result', async () => {
    const timelineValue = { topic: 'qcd', time_range: { start: 2020, end: 2025 }, phases: [], total_papers: 0, time_range_basis: 'requested_start' as const, total_search: { status: 'available' as const, query: '(qcd) and date:2020->2025', requested_page_size: 1, returned_count: 0, sample_complete: true, has_more: false }, coverage: { period_queries: 'complete' as const, paper_samples: 'complete' as const } };
    const evolutionValue = { topic: 'qcd', time_range: { start: 2020, end: 2025 }, time_range_basis: 'requested_start' as const, phases: [], current_status: { recent_papers: 0, time_range: { start: 2024, end: 2025 }, search: timelineValue.total_search }, sample_basis: { papers: 'single_mostcited_page_per_period' as const, key_papers_limit: 5 as const, key_authors: 'occurrences_among_first_three_authors_of_sampled_papers' as const }, coverage: timelineValue.coverage };
    vi.mocked(timeline.buildResearchTimeline).mockResolvedValue(timelineValue);
    vi.mocked(evolution.analyzeTopicEvolution).mockResolvedValue(evolutionValue);
    const params = TopicAnalysisToolSchema.parse({ topic: 'qcd', mode: 'all', time_range: { start: 2020, end: 2025 } });
    const result = await analyzeTopicUnified(params);
    expect(result).toEqual({ topic: 'qcd', mode: 'all', timeline: timelineValue, evolution: evolutionValue });
    expect(timeline.buildResearchTimeline).toHaveBeenCalledExactlyOnceWith({ topic: 'qcd', start_year: 2020, end_year: 2025 });
    expect(evolution.analyzeTopicEvolution).toHaveBeenCalledExactlyOnceWith({ topic: 'qcd', start_year: 2020, end_year: 2025, granularity: '5year' });
  });
});
