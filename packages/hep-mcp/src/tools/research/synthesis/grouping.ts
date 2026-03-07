/**
 * Paper Grouping Strategies
 * Organize papers by timeline, methodology, impact, or comparison
 */

import type { DeepPaperAnalysis } from '../deepAnalyze.js';
import { groupCollectionSemantics, humanizeSemanticLabel, toGroupingPaper } from './collectionSemanticGrouping.js';

export interface PaperGroup {
  name: string;
  description: string;
  papers: Array<{
    recid: string;
    title: string;
    contribution: string;
  }>;
  key_insights: string[];
}

/**
 * Extract main contribution from paper
 */
function extractContribution(paper: DeepPaperAnalysis): string {
  if (paper.conclusions) {
    // Take first sentence
    const firstSentence = paper.conclusions.split(/[.!?]/)[0];
    if (firstSentence && firstSentence.length > 20) {
      return firstSentence.trim() + '.';
    }
  }

  if (paper.structure?.abstract) {
    const firstSentence = paper.structure.abstract.split(/[.!?]/)[0];
    return firstSentence.trim() + '.';
  }

  return 'Analysis of ' + paper.title;
}

/**
 * Extract group-level insights
 */
function extractGroupInsights(label: string, papers: DeepPaperAnalysis[]): string[] {
  const insights: string[] = [];
  if (label !== 'uncertain') insights.push(`Shared semantic grouping: ${humanizeSemanticLabel(label)}`);

  // Count theorems
  const totalTheorems = papers.reduce((sum, p) => sum + (p.theorems?.length || 0), 0);
  if (totalTheorems > 0) {
    insights.push(`Contains ${totalTheorems} theorem-like statements`);
  }

  return insights;
}

/**
 * Group papers by timeline (year)
 */
export function groupByTimeline(
  papers: DeepPaperAnalysis[],
  metadata: Map<string, { year?: number; citations?: number }>
): PaperGroup[] {
  const yearGroups = new Map<number, DeepPaperAnalysis[]>();

  for (const paper of papers) {
    const meta = metadata.get(paper.recid);
    const year = meta?.year || new Date().getFullYear();
    if (!yearGroups.has(year)) {
      yearGroups.set(year, []);
    }
    yearGroups.get(year)!.push(paper);
  }

  const sortedYears = [...yearGroups.keys()].sort((a, b) => a - b);

  return sortedYears.map(year => ({
    name: `${year}`,
    description: `Papers published in ${year}`,
    papers: yearGroups.get(year)!.map(p => ({
      recid: p.recid,
      title: p.title,
      contribution: extractContribution(p),
    })),
    key_insights: [],
  }));
}

/**
 * Group papers by methodology using TF-IDF semantic clustering
 */
export function groupByMethodology(
  papers: DeepPaperAnalysis[],
  maxPerGroup: number
): PaperGroup[] {
  if (papers.length === 0) return [];
  const clusters = groupCollectionSemantics(papers.map(toGroupingPaper)).method_groups;
  const paperMap = new Map(papers.map(paper => [paper.recid, paper]));
  return clusters.map(cluster => {
    const members = cluster.paper_ids.map(recid => paperMap.get(recid)).filter((paper): paper is DeepPaperAnalysis => !!paper);
    return {
      name: humanizeSemanticLabel(cluster.label),
      description: `Papers grouped under ${humanizeSemanticLabel(cluster.label)}.`,
      papers: members.slice(0, maxPerGroup).map(paper => ({ recid: paper.recid, title: paper.title, contribution: extractContribution(paper) })),
      key_insights: extractGroupInsights(cluster.label, members),
    };
  });
}

/**
 * Group papers by citation impact (overview)
 */
export function groupByImpact(
  papers: DeepPaperAnalysis[],
  metadata: Map<string, { year?: number; citations?: number }>
): PaperGroup[] {
  const withCitations = papers.map(p => ({
    paper: p,
    citations: metadata.get(p.recid)?.citations || 0,
    year: metadata.get(p.recid)?.year || 0,
  }));

  withCitations.sort((a, b) => b.citations - a.citations);

  const currentYear = new Date().getFullYear();
  const seminal = withCitations.filter(p => p.citations >= 100);
  const important = withCitations.filter(p => p.citations >= 20 && p.citations < 100);
  const recent = withCitations.filter(p => p.year >= currentYear - 2 && p.citations < 20);

  const groups: PaperGroup[] = [];

  if (seminal.length > 0) {
    groups.push({
      name: 'Seminal Works',
      description: 'Highly cited foundational papers (100+ citations)',
      papers: seminal.slice(0, 10).map(p => ({
        recid: p.paper.recid,
        title: p.paper.title,
        contribution: extractContribution(p.paper),
      })),
      key_insights: [],
    });
  }

  if (important.length > 0) {
    groups.push({
      name: 'Important Contributions',
      description: 'Well-cited papers (20-100 citations)',
      papers: important.slice(0, 10).map(p => ({
        recid: p.paper.recid,
        title: p.paper.title,
        contribution: extractContribution(p.paper),
      })),
      key_insights: [],
    });
  }

  if (recent.length > 0) {
    groups.push({
      name: 'Recent Developments',
      description: 'Recent papers within last 2 years',
      papers: recent.slice(0, 10).map(p => ({
        recid: p.paper.recid,
        title: p.paper.title,
        contribution: extractContribution(p.paper),
      })),
      key_insights: [],
    });
  }

  return groups;
}

/**
 * Group papers for comparison (same as methodology)
 */
export function groupForComparison(
  papers: DeepPaperAnalysis[],
  maxPerGroup: number
): PaperGroup[] {
  return groupByMethodology(papers, maxPerGroup);
}
