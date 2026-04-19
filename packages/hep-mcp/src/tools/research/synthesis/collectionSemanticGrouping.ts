import type {
  CollectionSemanticGrouping,
  GroupingAssignmentDetail,
  GroupingProvenance,
  Paper,
  SemanticCluster,
} from '@autoresearch/shared';
import type { DeepPaperAnalysis } from '../deepAnalyze.js';
import { calculateTFIDF, extractTopTerms, tokenize } from './tfidf.js';
import {
  METHOD_GENERIC_TERMS,
  TOPIC_GENERIC_TERMS,
} from './collectionSemanticLexicon.js';

export interface GroupingPaper { recid: string; title: string; abstract?: string; keywords?: string[]; methodology?: string; conclusions?: string; citation_count?: number; }
export type {
  CollectionSemanticGrouping,
  SemanticCluster,
} from '@autoresearch/shared';

type GroupingFocus = 'topic' | 'method';
type PaperProfile = { paper: GroupingPaper; topTerms: string[]; };

const SOURCE_WEIGHTS = { title: 3, abstract: 2, keywords: 2, methodology: 3, conclusions: 1 } as const;

function filterTerms(terms: string[], focus: GroupingFocus): string[] {
  const generic = focus === 'topic' ? TOPIC_GENERIC_TERMS : METHOD_GENERIC_TERMS;
  return terms.filter(term => term.length > 2 && !generic.has(term)).slice(0, 5);
}

function buildDocument(paper: GroupingPaper, focus: GroupingFocus): string {
  const texts: Array<[string | undefined, number]> = [
    [paper.title, SOURCE_WEIGHTS.title],
    [paper.abstract, SOURCE_WEIGHTS.abstract],
    [(paper.keywords ?? []).join(' '), SOURCE_WEIGHTS.keywords],
    [paper.methodology, focus === 'method' ? SOURCE_WEIGHTS.methodology : 1],
    [paper.conclusions, SOURCE_WEIGHTS.conclusions],
  ];
  return texts.flatMap(([text, weight]) => Array.from({ length: weight }, () => text ?? '')).join(' ');
}

function buildProfiles(papers: GroupingPaper[], focus: GroupingFocus): PaperProfile[] {
  const docs = papers.map(paper => tokenize(buildDocument(paper, focus)));
  const tfidf = calculateTFIDF(docs, papers.map(paper => paper.recid));
  const topTerms = extractTopTerms(tfidf, focus === 'topic' ? 4 : 5);
  return papers.map(paper => ({
    paper,
    topTerms: filterTerms(topTerms.get(paper.recid) ?? [], focus),
  }));
}

function overlap(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  return left.filter(term => rightSet.has(term)).length;
}

function selectClusterLabel(profile: PaperProfile, profiles: PaperProfile[], focus: GroupingFocus): GroupingAssignmentDetail {
  void focus;
  const openEvidence = profile.topTerms.slice(0, 3);
  const openPeers = profiles.filter(other => overlap(profile.topTerms, other.topTerms) >= 2);
  if (openEvidence.length >= 2 && openPeers.length >= 2) {
    return { label: openEvidence.slice(0, 3).join('_'), provenance: { mode: 'open_cluster', used_fallback: false, reason_code: openPeers.length >= 2 ? 'shared_top_terms' : 'single_paper_top_terms', confidence: openPeers.length >= 2 ? 0.75 : 0.55, evidence: openEvidence } };
  }
  return { label: 'uncertain', provenance: { mode: 'uncertain', used_fallback: false, reason_code: openEvidence.length > 0 ? 'insufficient_shared_signal' : 'no_semantic_signal', confidence: 0, evidence: openEvidence } };
}

function representatives(papers: GroupingPaper[], limit: number): string[] {
  return [...papers].sort((left, right) => (right.citation_count ?? 0) - (left.citation_count ?? 0) || left.recid.localeCompare(right.recid)).slice(0, limit).map(paper => paper.recid);
}

function buildKeywords(label: string, members: GroupingAssignmentDetail[], focus: GroupingFocus): string[] {
  const evidence = [...new Set(members.flatMap(member => member.provenance.evidence).map(term => term.trim()).filter(Boolean))];
  if (evidence.length > 0) {
    return evidence.slice(0, focus === 'topic' ? 3 : 4);
  }
  return [label === 'uncertain' ? 'uncertain' : 'insufficient_signal'];
}

function groupKey(recid: string, detail?: GroupingAssignmentDetail): string {
  if (detail?.provenance.mode === 'uncertain') return `uncertain:${recid}`;
  return `${detail?.provenance.mode ?? 'uncertain'}:${detail?.provenance.canonical_hint ?? detail?.label ?? 'uncertain'}`;
}

function buildGroupingSurface(
  papers: GroupingPaper[],
  details: Record<string, GroupingAssignmentDetail>,
  focus: GroupingFocus,
): {
  assignments: Record<string, string>;
  assignmentDetails: Record<string, GroupingAssignmentDetail>;
  clusters: SemanticCluster[];
} {
  const groups = new Map<string, GroupingPaper[]>();
  for (const paper of papers) {
    const key = groupKey(paper.recid, details[paper.recid]);
    groups.set(key, [...(groups.get(key) ?? []), paper]);
  }
  const assignments: Record<string, string> = {};
  const assignmentDetails: Record<string, GroupingAssignmentDetail> = {};
  let uncertainIndex = 0;
  const clusters = [...groups.entries()].sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0])).map(([key, members]) => {
    const rawLabel = key.slice(key.indexOf(':') + 1);
    const memberDetails = members.map(member => details[member.recid] ?? { label: 'uncertain', provenance: { mode: 'uncertain', used_fallback: false, reason_code: 'missing_assignment', confidence: 0, evidence: [] } });
    const provenance: GroupingProvenance = memberDetails[0]?.provenance ?? { mode: 'uncertain', used_fallback: false, reason_code: 'missing_assignment', confidence: 0, evidence: [] };
    const label = provenance.mode === 'uncertain' ? `uncertain_cluster_${++uncertainIndex}` : rawLabel;
    for (const member of members) {
      assignments[member.recid] = label;
      assignmentDetails[member.recid] = { ...(details[member.recid] ?? memberDetails[0]!), label };
    }
    return { label, keywords: buildKeywords(label, memberDetails, focus), paper_ids: members.map(member => member.recid), representative_papers: representatives(members, 5), provenance };
  });
  return { assignments, assignmentDetails, clusters };
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

function buildAssignments(papers: GroupingPaper[], focus: GroupingFocus): Record<string, GroupingAssignmentDetail> {
  const profiles = buildProfiles(papers, focus);
  return Object.fromEntries(profiles.map(profile => [profile.paper.recid, selectClusterLabel(profile, profiles, focus)]));
}

export function groupCollectionSemantics(papers: GroupingPaper[]): CollectionSemanticGrouping {
  const topicGrouping = buildGroupingSurface(papers, buildAssignments(papers, 'topic'), 'topic');
  const methodGrouping = buildGroupingSurface(papers, buildAssignments(papers, 'method'), 'method');
  const fallbackRate = (details: Record<string, GroupingAssignmentDetail>) => papers.length === 0 ? 0 : papers.filter(paper => details[paper.recid]?.provenance.used_fallback).length / papers.length;
  return {
    topic_groups: topicGrouping.clusters,
    method_groups: methodGrouping.clusters,
    topic_assignments: topicGrouping.assignments,
    method_assignments: methodGrouping.assignments,
    topic_assignment_details: topicGrouping.assignmentDetails,
    method_assignment_details: methodGrouping.assignmentDetails,
    topic_fallback_rate: fallbackRate(topicGrouping.assignmentDetails),
    method_fallback_rate: fallbackRate(methodGrouping.assignmentDetails),
  };
}
