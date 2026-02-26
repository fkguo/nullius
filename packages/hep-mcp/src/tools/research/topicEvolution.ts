/**
 * Topic Evolution Tool
 * Analyzes the evolution of a research topic over time
 */

import * as api from '../../api/client.js';
import type { PaperSummary } from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TopicEvolutionParams {
  topic: string;
  start_year?: number;
  end_year?: number;
  granularity?: 'year' | '5year' | 'decade';
  include_subtopics?: boolean;
}

export interface EvolutionPhase {
  period: string;
  paper_count: number;
  citation_momentum: number;
  key_papers: PaperSummary[];
  key_authors: string[];
  description?: string;
}

export interface Subtopic {
  name: string;
  emerged_year: number;
  paper_count: number;
  key_papers: string[];
}

export interface CurrentStatus {
  recent_papers: number;
  growth_rate: number;
  trend: 'growing' | 'stable' | 'declining';
}

export interface TopicEvolutionResult {
  topic: string;
  time_range: { start: number; end: number };
  phases: EvolutionPhase[];
  subtopics?: Subtopic[];
  current_status: CurrentStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function getPeriodRanges(
  startYear: number,
  endYear: number,
  granularity: 'year' | '5year' | 'decade'
): { label: string; start: number; end: number }[] {
  const ranges: { label: string; start: number; end: number }[] = [];

  if (granularity === 'year') {
    for (let y = startYear; y <= endYear; y++) {
      ranges.push({ label: String(y), start: y, end: y });
    }
  } else if (granularity === '5year') {
    for (let y = startYear; y <= endYear; y += 5) {
      const end = Math.min(y + 4, endYear);
      ranges.push({ label: `${y}-${end}`, start: y, end });
    }
  } else {
    for (let y = Math.floor(startYear / 10) * 10; y <= endYear; y += 10) {
      const start = Math.max(y, startYear);
      const end = Math.min(y + 9, endYear);
      ranges.push({ label: `${start}-${end}`, start, end });
    }
  }

  return ranges;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Implementation
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzeTopicEvolution(
  params: TopicEvolutionParams
): Promise<TopicEvolutionResult> {
  const currentYear = new Date().getFullYear();
  const {
    topic,
    start_year,
    end_year = currentYear,
    granularity = '5year',
  } = params;

  // Detect start year if not provided
  let startYear = start_year;
  if (!startYear) {
    const oldestQuery = `${topic} date:1900->`;
    const oldest = await api.search(oldestQuery, { sort: 'mostrecent', size: 1 });
    if (oldest.papers.length > 0 && oldest.papers[0].year) {
      startYear = oldest.papers[0].year;
    } else {
      startYear = currentYear - 20;
    }
  }

  // Get period ranges
  const periods = getPeriodRanges(startYear, end_year, granularity);
  const phases: EvolutionPhase[] = [];

  // Analyze periods in parallel batches (respect rate limits)
  const BATCH_SIZE = 3;
  for (let i = 0; i < periods.length; i += BATCH_SIZE) {
    const batch = periods.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (period) => {
        const query = `${topic} date:${period.start}->${period.end}`;
        try {
          // Avoid truncating per-period samples; INSPIRE allows up to 1000 per page.
          return { period, result: await api.search(query, { sort: 'mostcited', size: 1000 }) };
        } catch (error) {
          // Log at debug level for troubleshooting
          console.debug(`[hep-mcp] topicEvolution search (period=${period.start}-${period.end}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
          return { period, result: { total: 0, papers: [], has_more: false } };
        }
      })
    );

    for (const { period, result } of batchResults) {
      if (result.total === 0) continue;

      // Get key papers (top cited)
      const keyPapers = result.papers.slice(0, 5);

      // Extract key authors
      const authorCounts = new Map<string, number>();
      for (const paper of result.papers) {
        for (const author of paper.authors.slice(0, 3)) {
          authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
        }
      }
      const keyAuthors = [...authorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name]) => name);

      phases.push({
        period: period.label,
        paper_count: result.total,
        citation_momentum: 0, // Will calculate below
        key_papers: keyPapers,
        key_authors: keyAuthors,
      });
    }
  }

  // Sort phases by period label to maintain chronological order
  phases.sort((a, b) => a.period.localeCompare(b.period));

  // Calculate citation momentum for each phase
  for (let i = 1; i < phases.length; i++) {
    const prev = phases[i - 1].paper_count;
    const curr = phases[i].paper_count;
    if (prev > 0) {
      phases[i].citation_momentum = (curr - prev) / prev;
    }
  }

  // Calculate current status
  const recentYears = 2;
  const recentQuery = `${topic} date:${currentYear - recentYears}->`;
  const recentResult = await api.search(recentQuery, { size: 1 });
  const recent_papers = recentResult.total;

  // Calculate growth rate
  let growth_rate = 0;
  let trend: 'growing' | 'stable' | 'declining' = 'stable';

  if (phases.length >= 2) {
    const lastPhase = phases[phases.length - 1];
    const prevPhase = phases[phases.length - 2];
    if (prevPhase.paper_count > 0) {
      growth_rate = (lastPhase.paper_count - prevPhase.paper_count) / prevPhase.paper_count;
      if (growth_rate > 0.2) trend = 'growing';
      else if (growth_rate < -0.2) trend = 'declining';
    }
  }

  return {
    topic,
    time_range: { start: startYear, end: end_year },
    phases,
    current_status: {
      recent_papers,
      growth_rate,
      trend,
    },
  };
}
