import {
  DiscoveryQppAssessmentSchema,
  DiscoveryQueryProbeSchema,
  normalizeDiscoveryQuery,
  normalizeDiscoveryTitle,
  type CanonicalPaper,
  type DiscoveryCandidateGenerationArtifact,
  type DiscoveryQppAssessment,
  type DiscoveryQueryProbe,
  type DiscoveryRerankedPaper,
  type DiscoveryRiskLevel,
} from '@autoresearch/shared';
import { extractQueryIdentifiers, hasStructuredIdentifier } from './queryIdentifiers.js';

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over', 'under', 'about']);

function overlapFraction(query: string, title: string): number {
  const queryTokens = new Set(normalizeDiscoveryQuery(query).split(' ').filter(Boolean));
  const titleTokens = normalizeDiscoveryTitle(title).split(' ').filter(Boolean);
  if (titleTokens.length === 0) return 0;
  return titleTokens.filter(token => queryTokens.has(token)).length / titleTokens.length;
}

function level(score: number): DiscoveryRiskLevel {
  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

export function buildDiscoveryQueryProbe(params: {
  query: string;
  candidateGeneration: DiscoveryCandidateGenerationArtifact;
  papers: CanonicalPaper[];
  preranked: DiscoveryRerankedPaper[];
}): DiscoveryQueryProbe {
  const normalized = normalizeDiscoveryQuery(params.query);
  const tokens = normalized.split(' ').filter(Boolean);
  const meaningful = tokens.filter(token => token.length > 2 && !STOPWORDS.has(token));
  const ids = extractQueryIdentifiers(params.query);
  const topPaper = params.papers.find(paper => paper.canonical_key === params.preranked[0]?.canonical_key) ?? null;
  const counts = params.candidateGeneration.batches.reduce((acc, batch) => {
    acc[batch.provider] += batch.result_count;
    return acc;
  }, { inspire: 0, openalex: 0, arxiv: 0 });

  return DiscoveryQueryProbeSchema.parse({
    structured_identifier_detected: hasStructuredIdentifier(ids),
    author_year_hint: /\b(?:19|20)\d{2}\b/.test(params.query) && /\b[A-Z][a-z]+\b/.test(params.query),
    acronym_hint: /\b[A-Z]{2,6}s?\b/.test(params.query),
    verbose_query: tokens.length >= 8,
    low_anchor_density: meaningful.length <= 3,
    provider_result_counts: counts,
    candidate_count: params.candidateGeneration.batches.reduce((sum, batch) => sum + batch.result_count, 0),
    canonical_paper_count: params.papers.length,
    exact_identifier_hit: params.papers.some(paper => paper.match_reasons.some(reason => reason.startsWith('exact_'))),
    top_stage1_score: params.preranked[0]?.stage1_score ?? null,
    top_title_overlap: topPaper ? overlapFraction(params.query, topPaper.title) : null,
    top_provider_source_count: topPaper?.provider_sources.length ?? 0,
    top_stage1_canonical_keys: params.preranked.slice(0, 10).map(item => item.canonical_key),
  });
}

export function defaultAssessDiscoveryQuery(params: { query: string; probe: DiscoveryQueryProbe }): DiscoveryQppAssessment {
  const { probe } = params;
  const reasonCodes: string[] = [];
  if (probe.structured_identifier_detected) {
    return DiscoveryQppAssessmentSchema.parse({
      status: 'applied',
      difficulty: 'low',
      ambiguity: 'low',
      low_recall_risk: 'low',
      trigger_decision: 'not_triggered',
      reason_codes: ['structured_identifier_detected', 'exact_lookup_preferred'],
    });
  }

  const broadTopicHint = /\b(review|overview|survey|status|commissioning)\b/.test(normalizeDiscoveryQuery(params.query));
  const strongTitleMatch = !broadTopicHint && ((probe.top_title_overlap ?? 0) >= 0.85 || (probe.exact_identifier_hit && probe.top_provider_source_count >= 2 && !probe.author_year_hint));
  if (strongTitleMatch) reasonCodes.push('strong_title_match');
  if (probe.author_year_hint) reasonCodes.push('author_year_fragment');
  if (probe.acronym_hint) reasonCodes.push('acronym_query');
  if (broadTopicHint) reasonCodes.push('broad_topic_query');
  if (probe.verbose_query) reasonCodes.push('verbose_query');
  if (probe.low_anchor_density) reasonCodes.push('low_anchor_density');
  if (!probe.exact_identifier_hit) reasonCodes.push('no_exact_identifier_match');
  if (probe.top_provider_source_count < 2) reasonCodes.push('weak_cross_provider_agreement');
  if ((probe.top_title_overlap ?? 0) < 0.55) reasonCodes.push('weak_title_alignment');
  if (probe.canonical_paper_count <= 2) reasonCodes.push('sparse_canonical_set');

  const ambiguity = level(
    Number(probe.author_year_hint)
    + Number(probe.acronym_hint)
    + Number(probe.low_anchor_density),
  );
  const lowRecallRisk = level(
    Number(!probe.exact_identifier_hit)
    + Number((probe.top_title_overlap ?? 0) < 0.55)
    + Number(probe.top_provider_source_count < 2)
    + Number(probe.canonical_paper_count <= 2),
  );
  const difficulty = level(
    Number(probe.verbose_query)
    + Number(ambiguity === 'medium')
    + Number(ambiguity === 'high') * 2
    + Number(lowRecallRisk === 'medium')
    + Number(lowRecallRisk === 'high') * 2,
  );

  const trigger = !strongTitleMatch && (
    ambiguity === 'high'
    || lowRecallRisk === 'high'
    || (difficulty === 'high' && (probe.top_title_overlap ?? 0) < 0.75)
    || (probe.author_year_hint && ((probe.top_title_overlap ?? 0) < 0.6 || probe.top_provider_source_count < 2))
    || (probe.acronym_hint && (probe.top_title_overlap ?? 0) < 0.7)
    || (broadTopicHint && probe.top_provider_source_count < 2)
  );
  reasonCodes.push(trigger ? 'reformulation_recommended' : 'baseline_path_sufficient');

  return DiscoveryQppAssessmentSchema.parse({
    status: 'applied',
    difficulty,
    ambiguity,
    low_recall_risk: lowRecallRisk,
    trigger_decision: trigger ? 'triggered' : 'not_triggered',
    reason_codes: reasonCodes,
  });
}
