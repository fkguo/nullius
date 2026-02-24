/**
 * Paper Grouping Strategies
 * Organize papers by timeline, methodology, impact, or comparison
 */

import type { DeepPaperAnalysis } from '../deepAnalyze.js';
import { tokenize, calculateTFIDF, extractTopTerms } from './tfidf.js';

// Common methodology keywords in physics (fallback terms)
const METHOD_TERMS = [
  'perturbation', 'lattice', 'monte carlo', 'effective theory', 'eft',
  'unitarity', 'dispersion', 'bootstrap', 'holography', 'ads/cft',
  'sum rules', 'quark model', 'potential model', 'chiral',
  'phenomenology', 'phenomenological', 'qcd', 'qed', 'electroweak',
  'renormalization', 'resummation', 'factorization', 'amplitude',
  'scattering', 'decay', 'cross section', 'form factor',
];

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
 * Extract methodology keywords from paper (fallback method)
 */
function extractMethodKeywords(paper: DeepPaperAnalysis): string[] {
  const keywords: string[] = [];

  const searchText = [
    paper.methodology || '',
    paper.structure?.abstract || '',
  ].join(' ').toLowerCase();

  for (const term of METHOD_TERMS) {
    if (searchText.includes(term.toLowerCase())) {
      keywords.push(term);
    }
  }

  return keywords;
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
function extractGroupInsights(papers: DeepPaperAnalysis[]): string[] {
  const insights: string[] = [];

  // Count common keywords
  const keywordCounts = new Map<string, number>();
  for (const paper of papers) {
    const keywords = extractMethodKeywords(paper);
    for (const kw of keywords) {
      keywordCounts.set(kw, (keywordCounts.get(kw) || 0) + 1);
    }
  }

  // Find common themes
  const common = [...keywordCounts.entries()]
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  if (common.length > 0) {
    insights.push(`Common approaches: ${common.map(c => c[0]).join(', ')}`);
  }

  // Count theorems
  const totalTheorems = papers.reduce((sum, p) => sum + (p.theorems?.length || 0), 0);
  if (totalTheorems > 0) {
    insights.push(`Contains ${totalTheorems} theorem-like statements`);
  }

  return insights;
}

/**
 * Cluster papers by TF-IDF semantic similarity
 */
function clusterByTFIDF(
  papers: DeepPaperAnalysis[]
): Map<string, DeepPaperAnalysis[]> {
  if (papers.length === 0) return new Map();

  // Tokenize methodology sections
  const documents = papers.map(paper => {
    const text = [
      paper.methodology || '',
      paper.conclusions || '',
    ].join(' ');
    return tokenize(text);
  });

  // Calculate TF-IDF
  const recids = papers.map(p => p.recid);
  const tfidfScores = calculateTFIDF(documents, recids);
  const topTerms = extractTopTerms(tfidfScores, 3);

  // Find common cluster labels
  const termCounts = new Map<string, number>();
  for (const terms of topTerms.values()) {
    for (const term of terms) {
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
    }
  }

  // Select cluster labels (terms that appear in at least 2 papers)
  const clusterLabels = [...termCounts.entries()]
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([term]) => term);

  // Assign papers to clusters
  const clusters = new Map<string, DeepPaperAnalysis[]>();

  for (const paper of papers) {
    const paperTerms = topTerms.get(paper.recid) || [];

    // Find best matching cluster
    let bestCluster = 'general';
    for (const label of clusterLabels) {
      if (paperTerms.includes(label)) {
        bestCluster = label;
        break;
      }
    }

    if (!clusters.has(bestCluster)) {
      clusters.set(bestCluster, []);
    }
    clusters.get(bestCluster)!.push(paper);
  }

  return clusters;
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

  // Use TF-IDF clustering for semantic grouping
  const clusters = clusterByTFIDF(papers);

  // If TF-IDF clustering produces meaningful groups, use them
  if (clusters.size > 1 || (clusters.size === 1 && !clusters.has('general'))) {
    return [...clusters.entries()]
      .filter(([_, clusterPapers]) => clusterPapers.length > 0)
      .map(([clusterName, clusterPapers]) => ({
        name: clusterName.charAt(0).toUpperCase() + clusterName.slice(1),
        description: `Papers focusing on ${clusterName} methods`,
        papers: clusterPapers.slice(0, maxPerGroup).map(p => ({
          recid: p.recid,
          title: p.title,
          contribution: extractContribution(p),
        })),
        key_insights: extractGroupInsights(clusterPapers),
      }));
  }

  // Fallback to fixed keyword matching if TF-IDF doesn't produce good clusters
  const methodGroups = new Map<string, DeepPaperAnalysis[]>();

  for (const paper of papers) {
    const keywords = extractMethodKeywords(paper);
    const primaryMethod = keywords[0] || 'general';

    if (!methodGroups.has(primaryMethod)) {
      methodGroups.set(primaryMethod, []);
    }
    methodGroups.get(primaryMethod)!.push(paper);
  }

  return [...methodGroups.entries()]
    .filter(([_, groupPapers]) => groupPapers.length > 0)
    .map(([method, groupPapers]) => ({
      name: method.charAt(0).toUpperCase() + method.slice(1),
      description: `Papers using ${method} approach`,
      papers: groupPapers.slice(0, maxPerGroup).map(p => ({
        recid: p.recid,
        title: p.title,
        contribution: extractContribution(p),
      })),
      key_insights: extractGroupInsights(groupPapers),
    }));
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
