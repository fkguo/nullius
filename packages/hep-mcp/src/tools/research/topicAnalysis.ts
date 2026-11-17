/** Bounded publication timeline and topic metadata views. */
import { buildResearchTimeline, type TimelineResult } from './timeline.js';
import type { TopicEvolutionParams as SharedTopicEvolutionParams } from '@nullius/shared';
import { analyzeTopicEvolution, type TopicEvolutionResult } from './topicEvolution.js';

export type TopicAnalysisMode = 'timeline' | 'evolution' | 'all';

export interface TopicAnalysisParams {
  topic: string;
  mode: TopicAnalysisMode;
  time_range?: { start: number; end: number };
  options?: TopicAnalysisOptions;
}

export interface TopicAnalysisOptions {
  start_year?: number;
  end_year?: number;
  granularity?: SharedTopicEvolutionParams['granularity'];
}

export interface TopicAnalysisResult {
  topic: string;
  mode: TopicAnalysisMode;
  timeline?: TimelineResult;
  evolution?: TopicEvolutionResult;
}

export async function analyzeTopicUnified(params: TopicAnalysisParams): Promise<TopicAnalysisResult> {
  const { topic, mode, time_range, options = {} } = params;
  const result: TopicAnalysisResult = { topic, mode };
  const pending: Promise<void>[] = [];

  if (mode === 'timeline' || mode === 'all') {
    pending.push(buildResearchTimeline({
      topic,
      start_year: options.start_year ?? time_range?.start,
      end_year: options.end_year ?? time_range?.end,
    }).then(value => { result.timeline = value; }));
  }
  if (mode === 'evolution' || mode === 'all') {
    pending.push(analyzeTopicEvolution({
      topic,
      start_year: options.start_year ?? time_range?.start,
      end_year: options.end_year ?? time_range?.end,
      granularity: options.granularity ?? '5year',
    }).then(value => { result.evolution = value; }));
  }
  await Promise.all(pending);
  return result;
}
