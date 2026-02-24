/**
 * Topic Analysis Tool (Consolidated)
 * Combines: research_timeline, topic_evolution, find_emerging_papers
 *
 * Modes:
 * - 'timeline': Generate research timeline showing yearly publication trends
 * - 'evolution': Analyze topic evolution over time with phases
 * - 'emerging': Find papers with rapidly growing citation momentum
 * - 'all': Run all analyses
 */

import { buildResearchTimeline, type TimelineResult } from './timeline.js';
import { analyzeTopicEvolution, type TopicEvolutionResult } from './topicEvolution.js';
import { findEmergingPapers, type FindEmergingResult } from './emergingPapers.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type TopicAnalysisMode = 'timeline' | 'evolution' | 'emerging' | 'all';

export interface TopicAnalysisParams {
  /** Topic keywords to analyze */
  topic: string;
  /** Analysis mode */
  mode: TopicAnalysisMode;
  /** Time range filter */
  time_range?: { start: number; end: number };
  /** Mode-specific options */
  options?: TopicAnalysisOptions;
  /** Max results for emerging papers (default: 10) */
  limit?: number;
}

export interface TopicAnalysisOptions {
  // Timeline options
  start_year?: number;
  end_year?: number;

  // Evolution options
  granularity?: 'year' | '5year' | 'decade';
  include_subtopics?: boolean;

  // Emerging options
  min_citations?: number;
  min_momentum?: number;
  include_sociology?: boolean;
  sample_mode?: 'full' | 'fast';
  sociology_options?: {
    disruption?: {
      max_refs_to_check?: number;
      max_refs_for_nj_query?: number;
      max_refs_for_nk_estimate?: number;
      nk_search_limit_fast?: number;
      nk_search_limit_full?: number;
    };
    new_entrant?: {
      lookback_years?: number;
      fast_mode_sample_size?: number;
    };
  };
}

export interface TopicAnalysisResult {
  topic: string;
  mode: TopicAnalysisMode;
  /** Timeline results (if mode includes 'timeline') */
  timeline?: TimelineResult;
  /** Evolution results (if mode includes 'evolution') */
  evolution?: TopicEvolutionResult;
  /** Emerging papers results (if mode includes 'emerging') */
  emerging?: FindEmergingResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unified topic analysis tool
 */
export async function analyzeTopicUnified(
  params: TopicAnalysisParams
): Promise<TopicAnalysisResult> {
  const { topic, mode, time_range, options = {}, limit = 10 } = params;

  const result: TopicAnalysisResult = {
    topic,
    mode,
  };

  const runTimeline = mode === 'timeline' || mode === 'all';
  const runEvolution = mode === 'evolution' || mode === 'all';
  const runEmerging = mode === 'emerging' || mode === 'all';

  // Run analyses in parallel where possible
  const promises: Promise<void>[] = [];

  if (runTimeline) {
    promises.push(
      buildResearchTimeline({
        topic,
        start_year: options.start_year ?? time_range?.start,
        end_year: options.end_year ?? time_range?.end,
      }).then(r => { result.timeline = r; })
    );
  }

  if (runEvolution) {
    promises.push(
      analyzeTopicEvolution({
        topic,
        start_year: options.start_year ?? time_range?.start,
        end_year: options.end_year ?? time_range?.end,
        granularity: options.granularity,
        include_subtopics: options.include_subtopics,
      }).then(r => { result.evolution = r; })
    );
  }

  if (runEmerging) {
    promises.push(
      findEmergingPapers({
        topic,
        time_range,
        limit,
        min_citations: options.min_citations,
        min_momentum: options.min_momentum,
        include_sociology: options.include_sociology,
        sample_mode: options.sample_mode,
        sociology_options: options.sociology_options,
      }).then(r => { result.emerging = r; })
    );
  }

  await Promise.all(promises);

  return result;
}
