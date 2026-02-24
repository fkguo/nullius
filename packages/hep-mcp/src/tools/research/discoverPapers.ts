/**
 * Discover Papers Tool (Consolidated)
 * Combines: find_seminal_papers, find_related_papers, research_expansion, generate_survey
 *
 * Modes:
 * - 'seminal': Find foundational/seminal papers on a topic
 * - 'related': Find papers related to a collection based on citation patterns
 * - 'expansion': Expand research directions from seed papers
 * - 'survey': Generate a structured reading list
 */

import { findSeminalPapers, type FindSeminalResult } from './seminalPapers.js';
import { findRelatedPapers, type RelatedPapers } from './findRelated.js';
import { researchExpansion, type ExpansionResult } from './expansion.js';
import { generateSurvey, type SurveyResult } from './survey.js';
import type {
  RelatedStrategy,
  ExpansionDirection,
  SurveyGoal,
  SurveyPrioritize,
} from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DiscoverMode = 'seminal' | 'related' | 'expansion' | 'survey';

export interface DiscoverPapersParams {
  /** Discovery mode */
  mode: DiscoverMode;
  /** Topic keywords (required for 'seminal' mode) */
  topic?: string;
  /** Seed paper recids (required for 'related', 'expansion', 'survey' modes) */
  seed_recids?: string[];
  /** Max results (default: 10-20 depending on mode) */
  limit?: number;
  /** Mode-specific options */
  options?: DiscoverOptions;
}

export interface DiscoverOptions {
  // Seminal options
  time_range?: { start: number; end: number };
  include_reviews?: boolean;
  include_emerging?: boolean;
  min_citations?: number;

  // Related options
  strategy?: RelatedStrategy;
  min_relevance?: number;

  // Expansion options
  direction?: ExpansionDirection;
  depth?: number;
  filters?: {
    min_citations?: number;
    year_range?: { start?: number; end?: number };
  };

  // Survey options
  goal?: SurveyGoal;
  prioritize?: SurveyPrioritize;
}

export interface DiscoverPapersResult {
  mode: DiscoverMode;
  /** Seminal papers result (if mode='seminal') */
  seminal?: FindSeminalResult;
  /** Related papers result (if mode='related') */
  related?: RelatedPapers;
  /** Expansion result (if mode='expansion') */
  expansion?: ExpansionResult;
  /** Survey result (if mode='survey') */
  survey?: SurveyResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unified paper discovery tool
 */
export async function discoverPapers(
  params: DiscoverPapersParams
): Promise<DiscoverPapersResult> {
  const { mode, topic, seed_recids, limit = 20, options = {} } = params;

  const result: DiscoverPapersResult = { mode };

  switch (mode) {
    case 'seminal': {
      if (!topic) throw new Error('topic is required for seminal mode');
      result.seminal = await findSeminalPapers({
        topic,
        time_range: options.time_range,
        limit,
        include_reviews: options.include_reviews,
        include_emerging: options.include_emerging,
        min_citations: options.min_citations,
      });
      break;
    }

    case 'related': {
      if (!seed_recids?.length) throw new Error('seed_recids required for related mode');
      result.related = await findRelatedPapers({
        recids: seed_recids,
        strategy: options.strategy || 'all',
        limit,
        min_relevance: options.min_relevance ?? 0.3,
      });
      break;
    }

    case 'expansion': {
      if (!seed_recids?.length) throw new Error('seed_recids required for expansion mode');
      result.expansion = await researchExpansion({
        seed_recids,
        direction: options.direction || 'all',
        depth: options.depth ?? 2,
        max_results: limit,
        filters: options.filters ? {
          ...options.filters,
          exclude_in_library: false,
        } : undefined,
      });
      break;
    }

    case 'survey': {
      if (!seed_recids?.length) throw new Error('seed_recids required for survey mode');
      result.survey = await generateSurvey({
        seed_recids,
        goal: options.goal || 'comprehensive_review',
        max_papers: limit,
        prioritize: options.prioritize || 'relevance',
        include_reviews: options.include_reviews ?? true,
      });
      break;
    }

    default:
      throw new Error(`Unknown mode: ${mode}`);
  }

  return result;
}
