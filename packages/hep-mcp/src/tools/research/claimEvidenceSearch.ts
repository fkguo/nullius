import * as api from '../../api/client.js';
import { DEFAULT_STANCE_DETECTION } from './config.js';
import { extractTopicWords } from '../../core/semantics/citationStanceHeuristics.js';
import type { ClaimEvidenceItem } from '../../core/semantics/claimTypes.js';

function extractAuthorIdentifier(fullName: string): string {
  const parts = fullName.split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) return fullName.trim().toLowerCase();
  const family = parts[0]?.toLowerCase() ?? '';
  const given = (parts[1] ?? '').trim();
  const initial = given ? given[0]!.toLowerCase() : '';
  return initial ? `${initial}.${family}` : family;
}

async function fetchEvidenceText(recid: string, title: string): Promise<string> {
  try {
    const paper = await api.getPaper(recid);
    return paper.abstract || title;
  } catch {
    return title;
  }
}

export async function collectClaimEvidenceCandidates(params: {
  claimText: string;
  originalRecid: string;
  originalAuthors: string[];
  maxResults: number;
  searchConfirmations: boolean;
}): Promise<{ evidenceItems: ClaimEvidenceItem[]; warnings: string[] }> {
  const warnings: string[] = [];
  const evidenceItems: ClaimEvidenceItem[] = [];
  if (!params.searchConfirmations) return { evidenceItems, warnings };

  const topicWords = extractTopicWords(params.claimText);
  if (topicWords.length === 0) return { evidenceItems, warnings };

  const originalAuthors = new Set(params.originalAuthors.map(extractAuthorIdentifier));
  const searchResult = await api.searchAll(topicWords.join(' '), {
    sort: 'mostcited',
    size: Math.min(1000, Math.max(1, params.maxResults)),
    max_results: params.maxResults,
  });
  if (searchResult.warning) warnings.push(searchResult.warning);
  if (searchResult.total > searchResult.papers.length) warnings.push('confirmation_search_truncated');

  const independentPapers = searchResult.papers.filter(paper => {
    if (!paper.recid || paper.recid === params.originalRecid) return false;
    const authorIds = new Set((paper.authors ?? []).map(extractAuthorIdentifier));
    const overlap = [...originalAuthors].filter(author => authorIds.has(author)).length;
    return overlap / Math.max(originalAuthors.size, 1) < 0.5;
  });

  const concurrentLimit = DEFAULT_STANCE_DETECTION.concurrentLimit;
  for (let index = 0; index < independentPapers.length; index += concurrentLimit) {
    const batch = independentPapers.slice(index, index + concurrentLimit);
    const resolved = await Promise.all(batch.map(async paper => ({
      paper,
      abstract: await fetchEvidenceText(paper.recid!, paper.title),
    })));
    for (const item of resolved) {
      evidenceItems.push({
        evidence_ref: `paper:${item.paper.recid}:abstract`,
        evidence_text: item.abstract,
        recid: item.paper.recid,
        title: item.paper.title,
        source: 'confirmation_search',
      });
    }
  }

  try {
    const comments = await api.searchAll(`refersto:recid:${params.originalRecid} and t:comment`, { sort: 'mostrecent', size: 1000 });
    for (const paper of comments.papers.slice(0, Math.min(3, params.maxResults))) {
      if (!paper.recid) continue;
      evidenceItems.push({
        evidence_ref: `comment:${paper.recid}:abstract`,
        evidence_text: await fetchEvidenceText(paper.recid, paper.title),
        recid: paper.recid,
        title: paper.title,
        source: 'comment_search',
      });
    }
  } catch {
    warnings.push('comment_search_skipped');
  }

  return { evidenceItems, warnings };
}
