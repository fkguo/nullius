/**
 * Research Timeline
 * Reference: legacy plan - inspire_research_timeline
 */

import * as api from '../../api/client.js';
import type { PaperSummary } from '@autoresearch/shared';
import { getCurrentYear } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TimelineParams {
  topic: string;
  start_year?: number;
  end_year?: number;
}

export interface TimelinePhase {
  year: number;
  paper_count: number;
  citation_sum: number;
  key_papers: PaperSummary[];
}

export interface TimelineResult {
  topic: string;
  time_range: { start: number; end: number };
  phases: TimelinePhase[];
  total_papers: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function buildResearchTimeline(
  params: TimelineParams
): Promise<TimelineResult> {
  const currentYear = getCurrentYear();
  const { topic, end_year = currentYear } = params;

  // First search to find earliest paper
  const initialSearch = await api.search(`${topic} topcite:10+`, {
    sort: 'mostrecent',
    size: 1,
  });

  // Determine start year
  let start_year = params.start_year;
  if (!start_year) {
    const oldestSearch = await api.search(topic, { size: 1 });
    start_year = oldestSearch.papers[0]?.year || end_year - 20;
  }

  // Build timeline by year (parallel batches)
  const phases: TimelinePhase[] = [];
  const years: number[] = [];
  for (let year = start_year; year <= end_year; year++) {
    years.push(year);
  }

  for (let i = 0; i < years.length; i += BATCH_SIZE) {
    const batch = years.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (year) => {
        try {
          const result = await api.search(
            `${topic} date:${year}`,
            { sort: 'mostcited', size: 5 }
          );
          return { year, result };
        } catch (error) {
          // Log at debug level for troubleshooting
          console.debug(`[hep-research-mcp] timeline search (year=${year}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
          return { year, result: { total: 0, papers: [], has_more: false } };
        }
      })
    );

    for (const { year, result } of batchResults) {
      if (result.total > 0) {
        const citationSum = result.papers.reduce(
          (sum, p) => sum + (p.citation_count || 0), 0
        );

        phases.push({
          year,
          paper_count: result.total,
          citation_sum: citationSum,
          key_papers: result.papers.slice(0, 3),
        });
      }
    }
  }

  // Sort phases by year
  phases.sort((a, b) => a.year - b.year);

  return {
    topic,
    time_range: { start: start_year, end: end_year },
    phases,
    total_papers: initialSearch.total,
  };
}
