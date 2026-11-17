/** Bounded yearly publication counts and explicitly sampled paper metadata. */
import type { PaperSummary } from '@nullius/shared';
import { getCurrentYear } from './config.js';
import { queryTopicMetadata, topicPeriodQuery, topicTimeRange, type TopicMetadataQuery } from './topicMetadataQuery.js';

export interface TimelineParams {
  topic: string;
  start_year?: number;
  end_year?: number;
}

export interface TimelinePhase {
  year: number;
  paper_count: number | null;
  /** Sum over the returned page only; null if any sampled citation count is missing. */
  sample_citation_sum: number | null;
  missing_citation_count: number | null;
  key_papers: PaperSummary[];
  search: TopicMetadataQuery;
}

export interface TimelineResult {
  topic: string;
  time_range: { start: number; end: number };
  time_range_basis: 'requested_start' | 'default_20_year_lookback';
  phases: TimelinePhase[];
  total_papers: number | null;
  total_search: TopicMetadataQuery;
  coverage: {
    period_queries: 'complete' | 'partial';
    paper_samples: 'complete' | 'partial';
  };
}

const BATCH_SIZE = 3;

export async function buildResearchTimeline(params: TimelineParams): Promise<TimelineResult> {
  const { topic } = params;
  const timeRange = topicTimeRange(params.start_year, params.end_year ?? getCurrentYear());
  // Count exactly the requested topic population and interval, without a citation threshold.
  const totalSearch = await queryTopicMetadata(topicPeriodQuery(topic, timeRange.start, timeRange.end), { size: 1 });
  const phases: TimelinePhase[] = [];
  const years = Array.from({ length: timeRange.end - timeRange.start + 1 }, (_, i) => timeRange.start + i);

  for (let i = 0; i < years.length; i += BATCH_SIZE) {
    const batch = await Promise.all(years.slice(i, i + BATCH_SIZE).map(async year => {
      const { result, observation } = await queryTopicMetadata(topicPeriodQuery(topic, year, year), { sort: 'mostcited', size: 5 });
      const missing = result?.papers.filter(paper => paper.citation_count === undefined).length ?? null;
      return {
        year,
        paper_count: result?.total ?? null,
        sample_citation_sum: result && missing === 0
          ? result.papers.reduce((sum, paper) => sum + paper.citation_count!, 0) : null,
        missing_citation_count: missing,
        key_papers: result?.papers.slice(0, 3) ?? [],
        search: observation,
      };
    }));
    phases.push(...batch);
  }

  return {
    topic,
    time_range: timeRange,
    time_range_basis: params.start_year === undefined ? 'default_20_year_lookback' : 'requested_start',
    phases,
    total_papers: totalSearch.result?.total ?? null,
    total_search: totalSearch.observation,
    coverage: {
      period_queries: phases.every(phase => phase.search.status === 'available') ? 'complete' : 'partial',
      paper_samples: phases.every(phase => phase.search.sample_complete === true) ? 'complete' : 'partial',
    },
  };
}
