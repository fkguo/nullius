/** Bounded publication-count changes and sampled topic metadata by period. */
import {
  type TopicEvolution,
  type TopicEvolutionParams,
  TopicEvolutionSchema,
  TopicEvolutionParamsSchema,
} from '@nullius/shared';
import { queryTopicMetadata, topicPeriodQuery, topicTimeRange } from './topicMetadataQuery.js';

export type TopicEvolutionResult = TopicEvolution;
type EvolutionPhase = TopicEvolution['phases'][number];
type TopicGranularity = TopicEvolutionParams['granularity'];

function getPeriodRanges(startYear: number, endYear: number, granularity: TopicGranularity) {
  const ranges: { label: string; start: number; end: number }[] = [];
  const width = granularity === 'year' ? 1 : granularity === '5year' ? 5 : 10;
  const firstStart = granularity === 'decade' ? Math.floor(startYear / 10) * 10 : startYear;
  for (let year = firstStart; year <= endYear; year += width) {
    const start = Math.max(year, startYear);
    const end = Math.min(year + width - 1, endYear);
    ranges.push({ label: width === 1 ? String(start) : `${start}-${end}`, start, end });
  }
  return ranges;
}

export async function analyzeTopicEvolution(params: TopicEvolutionParams): Promise<TopicEvolutionResult> {
  const validated = TopicEvolutionParamsSchema.parse(params);
  const { topic, granularity } = validated;
  const timeRange = topicTimeRange(validated.start_year, validated.end_year ?? new Date().getFullYear());
  const periods = getPeriodRanges(timeRange.start, timeRange.end, granularity);
  const phases: EvolutionPhase[] = [];

  for (let i = 0; i < periods.length; i += 3) {
    const batch = await Promise.all(periods.slice(i, i + 3).map(async period => {
      const { result, observation } = await queryTopicMetadata(
        topicPeriodQuery(topic, period.start, period.end), { sort: 'mostcited', size: 1000 },
      );
      const authorCounts = new Map<string, number>();
      for (const paper of result?.papers ?? []) {
        for (const author of paper.authors.slice(0, 3)) authorCounts.set(author, (authorCounts.get(author) ?? 0) + 1);
      }
      return {
        period: period.label,
        time_range: { start: period.start, end: period.end },
        paper_count: result?.total ?? null,
        publication_count_change: null,
        key_papers: result?.papers.slice(0, 5) ?? [],
        key_authors: [...authorCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([name]) => name),
        search: observation,
      };
    }));
    phases.push(...batch);
  }

  for (let i = 1; i < phases.length; i++) {
    const previous = phases[i - 1];
    const current = phases[i];
    if (previous.paper_count !== null && previous.paper_count > 0 && current.paper_count !== null
      && previous.time_range.end - previous.time_range.start === current.time_range.end - current.time_range.start) {
      current.publication_count_change = {
        previous_period: previous.period,
        previous_paper_count: previous.paper_count,
        fraction: (current.paper_count - previous.paper_count) / previous.paper_count,
      };
    }
  }

  // Recent counts refer to the final two years of the requested interval, not today's unrelated population.
  const recentRange = { start: Math.max(timeRange.start, timeRange.end - 1), end: timeRange.end };
  const recent = await queryTopicMetadata(topicPeriodQuery(topic, recentRange.start, recentRange.end), { size: 1 });
  return TopicEvolutionSchema.parse({
    topic,
    time_range: timeRange,
    time_range_basis: validated.start_year === undefined ? 'default_20_year_lookback' : 'requested_start',
    phases,
    current_status: { recent_papers: recent.result?.total ?? null, time_range: recentRange, search: recent.observation },
    sample_basis: {
      papers: 'single_mostcited_page_per_period',
      key_papers_limit: 5,
      key_authors: 'occurrences_among_first_three_authors_of_sampled_papers',
    },
    coverage: {
      period_queries: phases.every(phase => phase.search.status === 'available') ? 'complete' : 'partial',
      paper_samples: phases.every(phase => phase.search.sample_complete === true) ? 'complete' : 'partial',
    },
  });
}
