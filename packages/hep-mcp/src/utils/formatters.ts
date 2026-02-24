/**
 * Markdown Formatters
 * Converts tool results to readable Markdown format
 */

import type { PaperSummary } from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type OutputFormat = 'json' | 'markdown';

// ─────────────────────────────────────────────────────────────────────────────
// Paper Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a single paper as Markdown
 */
export function formatPaperMarkdown(paper: PaperSummary, index?: number): string {
  const lines: string[] = [];

  // Title with optional index
  const prefix = index !== undefined ? `${index}. ` : '';
  const title = paper.title || 'Untitled';
  lines.push(`${prefix}**${title}**`);

  // Authors
  if (paper.authors?.length) {
    const totalAuthorCount = paper.author_count ?? paper.authors.length;
    const authorStr = totalAuthorCount > 5
      ? `${paper.authors.slice(0, 5).join(', ')} et al.`
      : paper.authors.join(', ');
    lines.push(`   *${authorStr}*`);
  }

  // Publication info
  const meta: string[] = [];
  if (paper.year) meta.push(`${paper.year}`);
  if (paper.citation_count !== undefined) meta.push(`${paper.citation_count} citations`);
  if (paper.publication_summary) meta.push(paper.publication_summary);

  if (meta.length) {
    lines.push(`   ${meta.join(' | ')}`);
  }

  // Links
  const links: string[] = [];
  if (paper.inspire_url) links.push(`[INSPIRE](${paper.inspire_url})`);
  if (paper.arxiv_url) links.push(`[arXiv](${paper.arxiv_url})`);
  if (paper.doi_url) links.push(`[DOI](${paper.doi_url})`);

  if (links.length) {
    lines.push(`   ${links.join(' · ')}`);
  }

  // IDs (copy/paste-friendly chaining for downstream tools)
  const ids: string[] = [];
  if (paper.recid) ids.push(`recid=\`${paper.recid}\``);
  if (paper.arxiv_id) ids.push(`arXiv=\`${paper.arxiv_id}\``);
  if (paper.doi) ids.push(`DOI=\`${paper.doi}\``);

  if (ids.length) {
    lines.push(`   IDs: ${ids.join(' | ')}`);
  }

  return lines.join('\n');
}

/**
 * Format a list of papers as Markdown
 */
export function formatPaperListMarkdown(
  papers: PaperSummary[],
  title?: string
): string {
  const lines: string[] = [];

  if (title) {
    lines.push(`## ${title}\n`);
  }

  papers.forEach((paper, i) => {
    lines.push(formatPaperMarkdown(paper, i + 1));
    lines.push(''); // Empty line between papers
  });

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Search Result Formatting
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchResultData {
  total: number;
  papers: PaperSummary[];
  has_more: boolean;
}

export function formatSearchResultMarkdown(result: SearchResultData): string {
  const lines: string[] = [];

  lines.push(`## Search Results\n`);
  lines.push(`Found **${result.total}** papers${result.has_more ? ' (showing partial results)' : ''}\n`);

  result.papers.forEach((paper, i) => {
    lines.push(formatPaperMarkdown(paper, i + 1));
    lines.push('');
  });

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Expert Formatting
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpertData {
  name: string;
  paper_count: number;
  total_citations: number;
  h_index_estimate: number;
  top_papers?: { recid: string; title: string; citations: number }[];
}

export function formatExpertsMarkdown(
  topic: string,
  experts: ExpertData[]
): string {
  const lines: string[] = [];

  lines.push(`## Experts in "${topic}"\n`);

  experts.forEach((expert, i) => {
    lines.push(`${i + 1}. **${expert.name}**`);
    lines.push(`   - Papers: ${expert.paper_count} | Citations: ${expert.total_citations} | h-index: ${expert.h_index_estimate}`);

    if (expert.top_papers?.length) {
      lines.push(`   - Top papers:`);
      expert.top_papers.slice(0, 3).forEach(p => {
        lines.push(`     - ${p.title} (${p.citations} citations)`);
      });
    }
    lines.push('');
  });

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline Formatting
// ─────────────────────────────────────────────────────────────────────────────

export interface TimelinePhaseData {
  year: number;
  paper_count: number;
  total_citations: number;
  top_paper?: PaperSummary;
}

export function formatTimelineMarkdown(
  topic: string,
  phases: TimelinePhaseData[]
): string {
  const lines: string[] = [];

  lines.push(`## Research Timeline: "${topic}"\n`);
  lines.push(`| Year | Papers | Citations | Top Paper |`);
  lines.push(`|------|--------|-----------|-----------|`);

  phases.forEach(phase => {
    const topPaper = phase.top_paper?.title
      ? phase.top_paper.title.slice(0, 40) + (phase.top_paper.title.length > 40 ? '...' : '')
      : '-';
    lines.push(`| ${phase.year} | ${phase.paper_count} | ${phase.total_citations} | ${topPaper} |`);
  });

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic Table Formatting
// ─────────────────────────────────────────────────────────────────────────────

export function formatTableMarkdown(
  headers: string[],
  rows: string[][]
): string {
  const lines: string[] = [];

  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);

  rows.forEach(row => {
    lines.push(`| ${row.join(' | ')} |`);
  });

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Output Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format output based on format parameter
 */
export function formatOutput(
  data: unknown,
  format: OutputFormat,
  markdownFormatter?: () => string
): string {
  if (format === 'markdown' && markdownFormatter) {
    return markdownFormatter();
  }
  return JSON.stringify(data, null, 2);
}
