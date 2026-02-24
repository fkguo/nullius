/**
 * Markdown Generation for Review Synthesis
 * Converts review structure to formatted markdown output
 */

import type { ConflictAnalysis } from '../conflictDetector.js';
import type { PaperGroup } from './grouping.js';
import type { NarrativeSections } from './narrative.js';

export type ReviewStyle = 'list' | 'narrative';

export interface SynthesizedReview {
  title: string;
  focus_topic: string;
  generated_at: string;

  overview: {
    total_papers: number;
    successful_analysis: number;
    year_range: { start: number; end: number };
    main_findings: string[];
  };

  groups: PaperGroup[];

  key_equations?: Array<{
    latex: string;
    source_paper: string;
    importance?: 'high' | 'medium' | 'low';
    description?: string;
  }>;

  bibliography?: string;

  critical_analysis?: {
    conflicts: ConflictAnalysis[];
    evidence_summary: {
      well_established: string[];
      controversial: string[];
      emerging: string[];
    };
    open_questions: string[];
    overall_assessment: {
      average_reliability: number;
      high_risk_papers: string[];
      recommendations: string[];
    };
  };

  narrative_sections?: NarrativeSections;
}

/**
 * Generate markdown from review
 */
export function generateMarkdown(review: SynthesizedReview, style: ReviewStyle = 'list'): string {
  const lines: string[] = [];

  lines.push(`# ${review.title}`);
  lines.push('');
  lines.push(`*Generated: ${review.generated_at}*`);
  lines.push('');

  // Narrative mode: use prose sections
  if (style === 'narrative' && review.narrative_sections) {
    lines.push('## Introduction');
    lines.push('');
    lines.push(review.narrative_sections.introduction);
    lines.push('');

    lines.push('## Current State of Research');
    lines.push('');
    lines.push(review.narrative_sections.current_state);
    lines.push('');

    if (review.narrative_sections.debates) {
      lines.push('## Debates and Tensions');
      lines.push('');
      lines.push(review.narrative_sections.debates);
      lines.push('');
    }

    if (review.narrative_sections.methodology_challenges) {
      lines.push('## Methodological Challenges');
      lines.push('');
      lines.push(review.narrative_sections.methodology_challenges);
      lines.push('');
    }

    lines.push('## Future Outlook');
    lines.push('');
    lines.push(review.narrative_sections.outlook);
    lines.push('');

  } else {
    // List mode: use bullet points
    // Overview
    lines.push('## Overview');
    lines.push('');
    lines.push(`- **Papers analyzed**: ${review.overview.total_papers} (${review.overview.successful_analysis} successful)`);
    lines.push(`- **Year range**: ${review.overview.year_range.start} - ${review.overview.year_range.end}`);
    lines.push('');

    if (review.overview.main_findings.length > 0) {
      lines.push('### Main Findings');
      lines.push('');
      for (const finding of review.overview.main_findings) {
        lines.push(`- ${finding}`);
      }
      lines.push('');
    }

    // Groups
    for (const group of review.groups) {
      lines.push(`## ${group.name}`);
      lines.push('');
      lines.push(group.description);
      lines.push('');

      for (const paper of group.papers) {
        lines.push(`### ${paper.title}`);
        lines.push('');
        lines.push(`*INSPIRE: ${paper.recid}*`);
        lines.push('');
        lines.push(paper.contribution);
        lines.push('');
      }

      if (group.key_insights.length > 0) {
        lines.push('**Key Insights:**');
        for (const insight of group.key_insights) {
          lines.push(`- ${insight}`);
        }
        lines.push('');
      }
    }
  }

  // Critical analysis section (for both modes)
  if (review.critical_analysis) {
    lines.push('## Critical Analysis');
    lines.push('');

    // Conflicts
    if (review.critical_analysis.conflicts.length > 0) {
      lines.push('### Detected Conflicts');
      lines.push('');
      for (const conflict of review.critical_analysis.conflicts.slice(0, 5)) {
        const typeLabel = conflict.conflict_type === 'hard' ? '**HARD**' :
                         conflict.conflict_type === 'soft' ? '*Soft*' : 'Apparent';
        lines.push(`- ${typeLabel} (${conflict.tension_sigma}σ): ${conflict.quantity}`);
        lines.push(`  - ${conflict.notes}`);
      }
      lines.push('');
    }

    // Evidence summary
    lines.push('### Evidence Summary');
    lines.push('');
    if (review.critical_analysis.evidence_summary.well_established.length > 0) {
      lines.push('**Well Established:**');
      for (const item of review.critical_analysis.evidence_summary.well_established) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }
    if (review.critical_analysis.evidence_summary.controversial.length > 0) {
      lines.push('**Controversial:**');
      for (const item of review.critical_analysis.evidence_summary.controversial) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }
    if (review.critical_analysis.evidence_summary.emerging.length > 0) {
      lines.push('**Emerging:**');
      for (const item of review.critical_analysis.evidence_summary.emerging) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }

    // Overall assessment
    lines.push('### Overall Assessment');
    lines.push('');
    lines.push(`- **Average Reliability Score**: ${(review.critical_analysis.overall_assessment.average_reliability * 100).toFixed(0)}%`);
    if (review.critical_analysis.overall_assessment.high_risk_papers.length > 0) {
      lines.push(`- **High Risk Papers**: ${review.critical_analysis.overall_assessment.high_risk_papers.join(', ')}`);
    }
    if (review.critical_analysis.overall_assessment.recommendations.length > 0) {
      lines.push('');
      lines.push('**Recommendations:**');
      for (const rec of review.critical_analysis.overall_assessment.recommendations) {
        lines.push(`- ${rec}`);
      }
    }
    lines.push('');
  }

  // Key equations
  if (review.key_equations && review.key_equations.length > 0) {
    lines.push('## Key Equations');
    lines.push('');
    for (const eq of review.key_equations) {
      // Show importance badge
      const badge = eq.importance === 'high' ? '**[HIGH]**'
        : eq.importance === 'medium' ? '*[MEDIUM]*' : '';
      if (badge) {
        lines.push(badge);
        lines.push('');
      }
      // Use $$ for display math (renders in both md and LaTeX)
      lines.push('$$');
      lines.push(eq.latex);
      lines.push('$$');
      lines.push('');
      lines.push(`*Source: ${eq.source_paper}${eq.description ? ` — ${eq.description}` : ''}*`);
      lines.push('');
    }
  }

  // Bibliography
  if (review.bibliography) {
    lines.push('## References');
    lines.push('');
    lines.push('```bibtex');
    lines.push(review.bibliography);
    lines.push('```');
  }

  return lines.join('\n');
}
