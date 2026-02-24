/**
 * Narrative Generation for Review Synthesis
 * Generates academic prose in different structures: dialectic, progressive, convergent
 */

import type { DeepPaperAnalysis } from '../deepAnalyze.js';
import type { CriticalAnalysisResult } from '../criticalAnalysis.js';
import type { ConflictAnalysis } from '../conflictDetector.js';
import type { PaperGroup } from './grouping.js';

export type NarrativeStructure = 'dialectic' | 'progressive' | 'convergent';

export interface NarrativeSections {
  /** Introduction and historical context */
  introduction: string;
  /** Current state of research */
  current_state: string;
  /** Debates and controversies */
  debates?: string;
  /** Methodological challenges */
  methodology_challenges?: string;
  /** Future directions */
  outlook: string;
}

/**
 * Generate introduction section based on structure
 */
function generateIntroduction(
  structure: NarrativeStructure,
  focusTopic: string,
  papers: DeepPaperAnalysis[],
  yearRange: { start: number; end: number },
  metadata: Map<string, { year?: number; citations?: number }>
): string {
  const totalPapers = papers.length;
  const yearsSpan = yearRange.end - yearRange.start;

  // Find seminal papers (oldest highly cited)
  const withMeta = papers.map(p => ({
    paper: p,
    year: metadata.get(p.recid)?.year || yearRange.end,
    citations: metadata.get(p.recid)?.citations || 0,
  }));
  withMeta.sort((a, b) => a.year - b.year);
  const oldest = withMeta[0];

  let intro = '';

  switch (structure) {
    case 'dialectic':
      intro = `The study of ${focusTopic} has evolved through a dialectical process of competing theories and experimental tests. `;
      intro += `Over the past ${yearsSpan} years (${yearRange.start}-${yearRange.end}), the field has produced ${totalPapers} significant contributions. `;
      if (oldest) {
        intro += `Early foundational work, exemplified by "${oldest.paper.title}", established the theoretical framework that subsequent research would both build upon and challenge.`;
      }
      break;

    case 'progressive':
      intro = `Research on ${focusTopic} has followed a progressive trajectory of increasing precision and scope. `;
      intro += `Beginning around ${yearRange.start}, the field has accumulated ${totalPapers} key papers that trace the evolution from early explorations to current precision measurements. `;
      if (oldest) {
        intro += `The foundations were laid in works such as "${oldest.paper.title}", which established the initial methodological approaches.`;
      }
      break;

    case 'convergent':
    default:
      intro = `Multiple independent approaches have converged on our current understanding of ${focusTopic}. `;
      intro += `Spanning ${yearsSpan} years of research (${yearRange.start}-${yearRange.end}), ${totalPapers} papers contribute complementary perspectives. `;
      if (oldest) {
        intro += `The convergence can be traced from early works like "${oldest.paper.title}" to recent precision studies.`;
      }
      break;
  }

  return intro;
}

/**
 * Generate current state section with citations
 */
function generateCurrentState(
  papers: DeepPaperAnalysis[],
  groups: PaperGroup[],
  criticalResults?: CriticalAnalysisResult[]
): string {
  const paragraphs: string[] = [];

  paragraphs.push('The current landscape of research can be characterized by several distinct approaches.');

  // Build paper index for citations
  const paperIndex = new Map<string, number>();
  papers.forEach((p, i) => paperIndex.set(p.recid, i));

  // Summarize each methodological group with citations
  for (const group of groups.slice(0, 3)) {
    const groupPapers = group.papers.slice(0, 3);
    const citations = groupPapers
      .map(p => {
        const idx = paperIndex.get(p.recid);
        return idx !== undefined ? `[${idx + 1}]` : '';
      })
      .filter(c => c)
      .join(',');

    let paragraph = `In the area of ${group.name.toLowerCase()}, `;
    paragraph += `${group.papers.length} papers contribute to our understanding`;
    if (citations) paragraph += ` ${citations}`;
    paragraph += '. ';

    // Add key insights with more detail
    if (group.key_insights.length > 0) {
      paragraph += `Key findings include: ${group.key_insights.slice(0, 2).join('; ')}. `;
    }

    paragraphs.push(paragraph);
  }

  // Add reliability assessment
  if (criticalResults && criticalResults.length > 0) {
    const avgReliability = criticalResults.reduce(
      (sum, r) => sum + (r.integrated_assessment?.reliability_score || 0), 0
    ) / criticalResults.length;

    if (avgReliability > 0.7) {
      paragraphs.push('Overall, the body of evidence shows strong internal consistency and independent verification.');
    } else if (avgReliability > 0.5) {
      paragraphs.push('The evidence base shows moderate consistency, with some areas requiring further validation.');
    } else {
      paragraphs.push('Significant portions of the evidence remain preliminary or contested.');
    }
  }

  return paragraphs.join('\n\n');
}

/**
 * Generate debates section (for dialectic structure)
 */
function generateDebates(
  conflicts: ConflictAnalysis[],
  criticalResults?: CriticalAnalysisResult[]
): string | undefined {
  if (conflicts.length === 0 && (!criticalResults || criticalResults.length === 0)) {
    return undefined;
  }

  const lines: string[] = [];

  lines.push('Several points of tension exist within the current literature.');

  // Hard conflicts
  const hardConflicts = conflicts.filter(c => c.conflict_type === 'hard');
  if (hardConflicts.length > 0) {
    lines.push(
      `Most notably, ${hardConflicts.length} hard conflict${hardConflicts.length > 1 ? 's' : ''} ` +
      `have been identified where measurements differ by more than 5σ.`
    );
    const conflict = hardConflicts[0];
    if (conflict.measurements.length >= 2) {
      lines.push(
        `For example, regarding ${conflict.quantity}, tension exists between ` +
        `"${conflict.measurements[0].title}" and "${conflict.measurements[1].title}" ` +
        `(${conflict.tension_sigma}σ).`
      );
    }
  }

  // Soft tensions
  const softConflicts = conflicts.filter(c => c.conflict_type === 'soft');
  if (softConflicts.length > 0) {
    lines.push(
      `Additionally, ${softConflicts.length} soft tension${softConflicts.length > 1 ? 's' : ''} (3-5σ) ` +
      `warrant attention and may indicate systematic effects or genuine physical discrepancies.`
    );
  }

  // Red flags from critical analysis
  if (criticalResults) {
    const allRedFlags = criticalResults.flatMap(r => r.questions?.red_flags || []);
    const concernFlags = allRedFlags.filter(f => f.severity === 'concern');
    if (concernFlags.length > 0) {
      lines.push(
        `Critical analysis has also identified ${concernFlags.length} concern${concernFlags.length > 1 ? 's' : ''} ` +
        `across the analyzed papers, including issues such as "${concernFlags[0]?.description || 'methodological questions'}".`
      );
    }
  }

  return lines.length > 1 ? lines.join(' ') : undefined;
}

/**
 * Generate methodology challenges section
 */
function generateMethodologyChallenges(
  papers: DeepPaperAnalysis[],
  _criticalResults?: CriticalAnalysisResult[]
): string | undefined {
  const challenges: string[] = [];

  // Look for methodology-related text in papers
  for (const paper of papers.slice(0, 5)) {
    const methodText = (paper.methodology || '').toLowerCase();
    if (methodText.includes('systematic') || methodText.includes('uncertainty')) {
      challenges.push('systematic uncertainty estimation');
    }
    if (methodText.includes('background') || methodText.includes('contamination')) {
      challenges.push('background control');
    }
    if (methodText.includes('extrapolation') || methodText.includes('model-dependent')) {
      challenges.push('model dependence');
    }
  }

  // Unique challenges
  const uniqueChallenges = [...new Set(challenges)].slice(0, 3);

  if (uniqueChallenges.length === 0) {
    return undefined;
  }

  let text = 'Methodological challenges in this field include ';
  text += uniqueChallenges.join(', ') + '. ';
  text += 'These issues require careful attention when interpreting results and comparing across different analyses.';

  return text;
}

/**
 * Generate outlook section
 */
function generateOutlook(
  structure: NarrativeStructure,
  focusTopic: string,
  conflicts: ConflictAnalysis[],
  criticalResults?: CriticalAnalysisResult[]
): string {
  const lines: string[] = [];

  switch (structure) {
    case 'dialectic':
      lines.push('The dialectical development of this field suggests that resolution of current tensions ');
      lines.push('will likely lead to a more refined synthesis of theoretical and experimental understanding.');
      break;

    case 'progressive':
      lines.push('The progressive refinement of techniques and accumulated data ');
      lines.push('position the field well for continued advances in precision and scope.');
      break;

    case 'convergent':
    default:
      lines.push('The convergence of multiple approaches provides a robust foundation ');
      lines.push('for addressing remaining open questions.');
      break;
  }

  if (conflicts.length > 0) {
    lines.push(
      `Resolution of the ${conflicts.length} identified tension${conflicts.length > 1 ? 's' : ''} ` +
      `represents a priority for future research.`
    );
  }

  // Add recommendations from critical analysis
  if (criticalResults) {
    const recommendations = criticalResults.flatMap(
      r => r.integrated_assessment?.recommendations || []
    );
    const uniqueRecs = [...new Set(recommendations)].slice(0, 2);
    if (uniqueRecs.length > 0) {
      lines.push(`Key recommendations for future work include: ${uniqueRecs.join('; ')}.`);
    }
  }

  lines.push(`Continued research on ${focusTopic} will benefit from both improved experimental precision and theoretical advances.`);

  return lines.join(' ');
}

/**
 * Generate full narrative sections
 */
export function generateNarrativeSections(
  structure: NarrativeStructure,
  focusTopic: string,
  papers: DeepPaperAnalysis[],
  groups: PaperGroup[],
  yearRange: { start: number; end: number },
  metadata: Map<string, { year?: number; citations?: number }>,
  conflicts: ConflictAnalysis[],
  criticalResults?: CriticalAnalysisResult[]
): NarrativeSections {
  return {
    introduction: generateIntroduction(structure, focusTopic, papers, yearRange, metadata),
    current_state: generateCurrentState(papers, groups, criticalResults),
    debates: generateDebates(conflicts, criticalResults),
    methodology_challenges: generateMethodologyChallenges(papers, criticalResults),
    outlook: generateOutlook(structure, focusTopic, conflicts, criticalResults),
  };
}
