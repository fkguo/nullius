import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import { INSPIRE_CRITICAL_RESEARCH } from '@autoresearch/shared';
import * as api from '../../api/client.js';
import { buildToolSamplingMetadata } from '../../core/sampling-metadata.js';
import { getConfig, validateRecid } from './config.js';
import { classifyContentType } from './paperClassifier.js';
import { buildCriticalQuestionPrompt, extractSamplingText, parseCriticalQuestionResponse } from './semantic/questionSampling.js';
import type { SemanticAssessmentProvenance } from './semantic/semanticProvenance.js';
import { sha256Hex } from './semantic/semanticProvenance.js';

export type PaperType = 'experimental' | 'theoretical' | 'phenomenological' | 'review' | 'lattice' | 'instrumentation' | 'mixed' | 'uncertain';
export type RedFlagType =
  | 'high_self_citation'
  | 'no_confirmation'
  | 'comment_exists'
  | 'single_author'
  | 'no_experimental_basis'
  | 'excessive_claims'
  | 'methodology_unclear'
  | 'low_citations_old_paper';

export interface RedFlag {
  type: RedFlagType;
  description: string;
  severity: 'warning' | 'concern';
  details?: string;
}

export interface CriticalQuestions {
  methodology: string[];
  assumptions: string[];
  alternatives: string[];
  reproducibility: string[];
  implications: string[];
}

export interface CriticalQuestionsParams {
  recid: string;
  check_comments?: boolean;
  check_self_citations?: boolean;
}

export interface CriticalQuestionsResult {
  paper_recid: string;
  paper_title: string;
  paper_year?: number;
  paper_type: PaperType;
  success: boolean;
  error?: string;
  questions: CriticalQuestions;
  red_flags: RedFlag[];
  reliability_score: number | null;
  metrics: {
    author_count: number;
    citation_count: number;
    self_citation_rate?: number;
    has_comments: boolean;
    paper_age_years: number;
  };
  provenance: SemanticAssessmentProvenance;
}

type QuestionSamplingContext = {
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
};

// Diagnostic scaffolding for unavailable/abstained sampling only; these prompts are not a
// semantic taxonomy and must not be treated as final paper-question authority.
const FALLBACK_QUESTIONS: CriticalQuestions = {
  methodology: ['Which design choices or approximations would most change the headline claim if they were altered?'],
  assumptions: ['Which assumptions are carrying the main conclusion, and where are they justified?'],
  alternatives: ['What plausible alternative interpretation would explain the same result?'],
  reproducibility: ['Which missing implementation detail would most block an independent reproduction?'],
  implications: ['If the core claim is correct, what follow-up observation or calculation should change next?'],
};

async function calculateSelfCitationRate(recid: string, authors: string[]): Promise<number | undefined> {
  try {
    const refs = await api.getReferences(recid);
    if (refs.length === 0) return undefined;
    const authorLastNames = new Set(authors.map(author => author.toLowerCase().split(' ').pop() || '').filter(Boolean));
    const selfCitations = refs.filter(ref => (ref.authors ?? []).some(author => authorLastNames.has(author.toLowerCase().split(' ').pop() || ''))).length;
    return selfCitations / refs.length;
  } catch {
    return undefined;
  }
}

async function checkForComments(recid: string): Promise<boolean> {
  try {
    const result = await api.search(`refersto:recid:${recid} and t:comment`, { size: 1 });
    return result.papers.length > 0;
  } catch {
    return false;
  }
}

function buildMetricRedFlags(authorCount: number, citationCount: number, selfCitationRate: number | undefined, hasComments: boolean, paperAgeYears: number): RedFlag[] {
  const config = getConfig().criticalResearch;
  const redFlags: RedFlag[] = [];
  const selfCiteWarning = config?.selfCitationWarningThreshold ?? 0.4;
  const selfCiteConcern = config?.selfCitationConcernThreshold ?? 0.6;

  if (selfCitationRate !== undefined && selfCitationRate > selfCiteWarning) {
    redFlags.push({
      type: 'high_self_citation',
      description: `High self-citation rate: ${(selfCitationRate * 100).toFixed(1)}%`,
      severity: selfCitationRate > selfCiteConcern ? 'concern' : 'warning',
      details: 'Use external citations and independent replications to cross-check the argument.',
    });
  }
  if (hasComments) redFlags.push({ type: 'comment_exists', description: 'Published comments or replies exist for this paper.', severity: 'concern' });
  if (paperAgeYears > (config?.lowCitationAgeThreshold ?? 5) && citationCount < (config?.lowCitationCountThreshold ?? 5)) {
    redFlags.push({ type: 'low_citations_old_paper', description: `Paper is ${paperAgeYears} years old with only ${citationCount} citations.`, severity: 'warning' });
  }
  if (authorCount === 1 && citationCount >= 50) {
    redFlags.push({ type: 'single_author', description: 'Single-author paper with outsized claimed impact merits extra scrutiny.', severity: 'warning' });
  }
  return redFlags;
}

function mergeRedFlags(metricFlags: RedFlag[], semanticFlags: RedFlag[]): RedFlag[] {
  const seen = new Set<string>();
  const merged: RedFlag[] = [];
  for (const flag of [...metricFlags, ...semanticFlags]) {
    const key = `${flag.type}:${flag.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(flag);
  }
  return merged.slice(0, 6);
}

export async function generateCriticalQuestions(
  params: CriticalQuestionsParams,
  ctx: QuestionSamplingContext = {},
): Promise<CriticalQuestionsResult> {
  const recidError = validateRecid(params.recid);
  if (recidError) {
    return {
      paper_recid: params.recid || '',
      paper_title: '',
      paper_type: 'uncertain',
      success: false,
      error: recidError,
      questions: FALLBACK_QUESTIONS,
      red_flags: [],
      reliability_score: null,
      metrics: { citation_count: 0, author_count: 0, has_comments: false, paper_age_years: 0 },
      provenance: { backend: 'diagnostic_fallback', status: 'unavailable', used_fallback: true, reason_code: 'invalid_recid' },
    };
  }

  try {
    const paper = await api.getPaper(params.recid);
    const currentYear = new Date().getFullYear();
    const paperYear = paper.year || currentYear;
    const paperAgeYears = currentYear - paperYear;
    const authorCount = paper.author_count ?? paper.authors?.length ?? 0;
    const citationCount = paper.citation_count || 0;
    const [selfCitationRate, hasComments] = await Promise.all([
      params.check_self_citations === false ? Promise.resolve(undefined) : calculateSelfCitationRate(params.recid, paper.authors || []),
      params.check_comments === false ? Promise.resolve(false) : checkForComments(params.recid),
    ]);
    const metricFlags = buildMetricRedFlags(authorCount, citationCount, selfCitationRate, hasComments, paperAgeYears);
    const contentHint = classifyContentType(paper);
    const promptVersion = 'sem05_critical_questions_v2';
    const inputHash = sha256Hex(JSON.stringify({
      recid: params.recid,
      title: paper.title,
      abstract: paper.abstract || '',
      publication_summary: paper.publication_summary ?? '',
      publication_type: paper.publication_type ?? [],
      document_type: paper.document_type ?? [],
      author_count: authorCount,
      citation_count: citationCount,
      paper_age_years: paperAgeYears,
      has_comments: hasComments,
      self_citation_rate: selfCitationRate ?? null,
      content_hint: contentHint.content_type,
    }));

    const fallback = (reasonCode: string, backend: 'mcp_sampling' | 'diagnostic_fallback' = 'diagnostic_fallback', model?: string): CriticalQuestionsResult => ({
      paper_recid: params.recid,
      paper_title: paper.title,
      paper_year: paper.year,
      paper_type: contentHint.content_type,
      success: true,
      questions: FALLBACK_QUESTIONS,
      red_flags: metricFlags,
      reliability_score: null,
      metrics: {
        author_count: authorCount,
        citation_count: citationCount,
        self_citation_rate: selfCitationRate,
        has_comments: hasComments,
        paper_age_years: paperAgeYears,
      },
      provenance: {
        backend,
        status: backend === 'diagnostic_fallback'
          ? 'fallback'
          : reasonCode === 'model_abstained'
            ? 'abstained'
            : reasonCode === 'sampling_error'
              ? 'unavailable'
              : 'invalid',
        used_fallback: true,
        reason_code: reasonCode,
        prompt_version: promptVersion,
        input_hash: inputHash,
        model,
      },
    });

    if (!ctx.createMessage) return fallback('sampling_unavailable');

    let response: CreateMessageResult;
    try {
      response = await ctx.createMessage({
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: buildCriticalQuestionPrompt({
              prompt_version: promptVersion,
              title: paper.title,
              abstract: paper.abstract || '',
              publication_summary: paper.publication_summary,
              publication_type: paper.publication_type,
              document_type: paper.document_type,
              author_count: authorCount,
              citation_count: citationCount,
              paper_age_years: paperAgeYears,
              has_comments: hasComments,
              self_citation_rate: selfCitationRate,
              content_hint: contentHint.content_type,
            }),
          },
        }],
        maxTokens: 900,
        metadata: buildToolSamplingMetadata({
          tool: INSPIRE_CRITICAL_RESEARCH,
          module: 'sem05_critical_questions',
          promptVersion,
          costClass: 'medium',
        }),
      });
    } catch {
      return fallback('sampling_error', 'mcp_sampling');
    }

    const parsed = parseCriticalQuestionResponse(extractSamplingText(response.content));
    if (!parsed) return fallback('invalid_response', 'mcp_sampling', response.model);
    if (parsed.abstain) return fallback('model_abstained', 'mcp_sampling', response.model);

    return {
      paper_recid: params.recid,
      paper_title: paper.title,
      paper_year: paper.year,
      paper_type: parsed.paper_type,
      success: true,
      questions: parsed.questions,
      red_flags: mergeRedFlags(metricFlags, parsed.red_flags as RedFlag[]),
      reliability_score: parsed.reliability_score,
      metrics: {
        author_count: authorCount,
        citation_count: citationCount,
        self_citation_rate: selfCitationRate,
        has_comments: hasComments,
        paper_age_years: paperAgeYears,
      },
      provenance: {
        backend: 'mcp_sampling',
        status: 'applied',
        used_fallback: false,
        reason_code: parsed.reason || 'semantic_questions',
        prompt_version: promptVersion,
        input_hash: inputHash,
        model: response.model,
      },
    };
  } catch (error) {
    return {
      paper_recid: params.recid,
      paper_title: 'Unknown',
      paper_type: 'uncertain',
      success: false,
      error: error instanceof Error ? error.message : String(error),
      questions: FALLBACK_QUESTIONS,
      red_flags: [],
      reliability_score: null,
      metrics: { author_count: 0, citation_count: 0, has_comments: false, paper_age_years: 0 },
      provenance: { backend: 'diagnostic_fallback', status: 'unavailable', used_fallback: true, reason_code: 'upstream_error' },
    };
  }
}
