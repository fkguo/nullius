import type { Paper } from '@autoresearch/shared';
import type { DeepPaperAnalysis } from '../deepAnalyze.js';
import { HUMANIZED_LABELS, METHOD_CONCEPTS, TOPIC_CONCEPTS, type SemanticConcept } from './collectionSemanticLexicon.js';

export interface GroupingPaper { recid: string; title: string; abstract?: string; keywords?: string[]; methodology?: string; conclusions?: string; citation_count?: number; }
export interface SemanticCluster { label: string; keywords: string[]; paper_ids: string[]; representative_papers: string[]; }
export interface CollectionSemanticGrouping { topic_groups: SemanticCluster[]; method_groups: SemanticCluster[]; topic_assignments: Record<string, string>; method_assignments: Record<string, string>; topic_fallback_rate: number; method_fallback_rate: number; }

type ConceptScore = { label: string; score: number };

const SOURCE_WEIGHTS = { title: 4, abstract: 3, keywords: 3, methodology: 4, conclusions: 2 } as const;

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

function scoreConcepts(paper: GroupingPaper, concepts: SemanticConcept[], focus: 'topic' | 'method'): ConceptScore[] {
  const title = normalize(paper.title);
  const abstract = normalize(paper.abstract ?? '');
  const methodology = normalize(paper.methodology ?? '');
  const conclusions = normalize(paper.conclusions ?? '');
  const keywords = normalize((paper.keywords ?? []).join(' '));
  return concepts.map(concept => ({
    label: concept.label,
    score: concept.aliases.reduce((sum, alias) => {
      const needle = normalize(alias);
      return sum
        + (title.includes(needle) ? SOURCE_WEIGHTS.title : 0)
        + (abstract.includes(needle) ? SOURCE_WEIGHTS.abstract : 0)
        + (keywords.includes(needle) ? SOURCE_WEIGHTS.keywords : 0)
        + (focus === 'method' && methodology.includes(needle) ? SOURCE_WEIGHTS.methodology : 0)
        + (conclusions.includes(needle) ? SOURCE_WEIGHTS.conclusions : 0);
    }, 0),
  })).sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
}

function chooseLabel(scores: ConceptScore[], mode: 'topic' | 'method'): string {
  const [first, second] = scores;
  if (!first || first.score === 0) return 'uncertain';
  if (mode === 'method' && second && second.score > 0 && second.score >= first.score * 0.75) return 'cross_cutting';
  if (mode === 'topic' && second && second.score > 0 && second.score >= first.score * 0.9) return first.label;
  return first.label;
}

function topKeywords(label: string, concepts: SemanticConcept[]): string[] {
  const concept = concepts.find(item => item.label === label);
  if (!concept) return [label];
  return [label, ...concept.aliases.slice(0, 2).map(alias => alias.replace(/\s+/g, '_'))];
}

function representatives(papers: GroupingPaper[], limit: number): string[] {
  return [...papers].sort((left, right) => (right.citation_count ?? 0) - (left.citation_count ?? 0) || left.recid.localeCompare(right.recid)).slice(0, limit).map(paper => paper.recid);
}

function buildClusters(papers: GroupingPaper[], assignments: Record<string, string>, concepts: SemanticConcept[]): SemanticCluster[] {
  const groups = new Map<string, GroupingPaper[]>();
  for (const paper of papers) groups.set(assignments[paper.recid], [...(groups.get(assignments[paper.recid]) ?? []), paper]);
  return [...groups.entries()].sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0])).map(([label, members]) => ({
    label,
    keywords: topKeywords(label, concepts),
    paper_ids: members.map(member => member.recid),
    representative_papers: representatives(members, 5),
  }));
}

export function humanizeSemanticLabel(label: string): string {
  return HUMANIZED_LABELS[label] ?? label.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

export function toGroupingPaper(paper: Paper | DeepPaperAnalysis): GroupingPaper {
  return {
    recid: paper.recid ?? paper.arxiv_id ?? paper.title,
    title: paper.title,
    abstract: 'abstract' in paper ? paper.abstract : ('structure' in paper ? paper.structure?.abstract : undefined),
    keywords: 'keywords' in paper ? paper.keywords : undefined,
    methodology: 'methodology' in paper ? paper.methodology : undefined,
    conclusions: 'conclusions' in paper ? paper.conclusions : undefined,
    citation_count: 'citation_count' in paper ? paper.citation_count : undefined,
  };
}

export function groupCollectionSemantics(papers: GroupingPaper[]): CollectionSemanticGrouping {
  const topicAssignments = Object.fromEntries(papers.map(paper => [paper.recid, chooseLabel(scoreConcepts(paper, TOPIC_CONCEPTS, 'topic'), 'topic')]));
  const methodAssignments = Object.fromEntries(papers.map(paper => [paper.recid, chooseLabel(scoreConcepts(paper, METHOD_CONCEPTS, 'method'), 'method')]));
  return {
    topic_groups: buildClusters(papers, topicAssignments, TOPIC_CONCEPTS),
    method_groups: buildClusters(papers, methodAssignments, METHOD_CONCEPTS),
    topic_assignments: topicAssignments,
    method_assignments: methodAssignments,
    topic_fallback_rate: papers.length === 0 ? 0 : papers.filter(paper => topicAssignments[paper.recid] === 'uncertain').length / papers.length,
    method_fallback_rate: papers.length === 0 ? 0 : papers.filter(paper => methodAssignments[paper.recid] === 'uncertain' || methodAssignments[paper.recid] === 'cross_cutting').length / papers.length,
  };
}
