import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import { INSPIRE_CRITICAL_ANALYSIS } from '@autoresearch/shared';
import * as api from '../../api/client.js';
import { buildToolSamplingMetadata } from '../../core/sampling-metadata.js';
import { getConfig, validateMaxDepth, validateRecid } from './config.js';
import { buildAssumptionExtractionPrompt, extractSamplingText, parseAssumptionExtractionResponse } from './semantic/assumptionSampling.js';
import type { SemanticAssessmentProvenance } from './semantic/semanticProvenance.js';
import { sha256Hex } from './semantic/semanticProvenance.js';

export type AssumptionType = 'explicit' | 'implicit';
export type AssumptionSource = 'original' | 'inherited';
export type ValidationStatus = 'tested' | 'untested' | 'challenged' | 'refuted' | 'uncertain' | 'unavailable';

export interface AssumptionNode {
  assumption: string;
  type: AssumptionType;
  source: AssumptionSource;
  inherited_from?: Array<{ recid: string; title: string }>;
  validation_status: ValidationStatus;
  challenge_papers?: Array<{ recid: string; title: string }>;
  supporting_papers?: Array<{ recid: string; title: string }>;
  category: string | null;
  provenance: SemanticAssessmentProvenance;
}

export interface AssumptionChain {
  paper_recid: string;
  paper_title: string;
  paper_year?: number;
  core_assumptions: AssumptionNode[];
  fragility_score: number;
  critical_dependencies: string[];
  summary: {
    total_assumptions: number;
    explicit_count: number;
    implicit_count: number;
    inherited_count: number;
    challenged_count: number;
    untested_count: number;
  };
  provenance: SemanticAssessmentProvenance;
}

export interface AssumptionTrackerParams {
  recid: string;
  max_depth?: number;
  check_challenges?: boolean;
}

export interface AssumptionTrackerResult {
  success: boolean;
  error?: string;
  analysis: AssumptionChain | null;
  risk_assessment?: {
    level: 'low' | 'medium' | 'high';
    description: string;
    recommendations: string[];
  };
  provenance?: SemanticAssessmentProvenance;
}

type AssumptionSamplingContext = {
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
};

async function fetchReferenceContexts(recid: string, maxDepth: number): Promise<Array<{ recid: string; title: string; abstract?: string }>> {
  if (maxDepth <= 0) return [];
  const maxRefs = getConfig().criticalResearch?.maxRefsPerLevel ?? 3;
  try {
    const refs = await api.getReferences(recid, maxRefs);
    const selected = refs.filter(ref => ref.recid).slice(0, maxRefs);
    const papers = await Promise.all(selected.map(async ref => {
      try {
        const paper = await api.getPaper(ref.recid!);
        return { recid: ref.recid!, title: ref.title, abstract: paper.abstract };
      } catch {
        return { recid: ref.recid!, title: ref.title };
      }
    }));
    return papers;
  } catch {
    return [];
  }
}

function assumptionWeight(status: ValidationStatus): number {
  switch (status) {
    case 'refuted': return 1;
    case 'challenged': return 0.85;
    case 'uncertain': return 0.65;
    case 'unavailable': return 0.6;
    case 'untested': return 0.5;
    case 'tested': return 0.2;
  }
}

function calculateFragilityScore(assumptions: AssumptionNode[]): number {
  if (assumptions.length === 0) return 0;
  const weighted = assumptions.map(item => assumptionWeight(item.validation_status) + (item.source === 'inherited' ? 0.1 : 0) + (item.type === 'implicit' ? 0.05 : 0));
  return Math.min(1, weighted.reduce((sum, value) => sum + value, 0) / assumptions.length);
}

function identifyCriticalDependencies(assumptions: AssumptionNode[]): string[] {
  return [...assumptions]
    .sort((left, right) => assumptionWeight(right.validation_status) - assumptionWeight(left.validation_status))
    .slice(0, 3)
    .map(item => item.assumption.slice(0, 100));
}

function buildRiskAssessment(fragilityScore: number, uncertainCount: number, unavailableCount: number) {
  if (fragilityScore >= 0.7 || uncertainCount >= 3) {
    return {
      level: 'high' as const,
      description: 'Key assumptions remain semantically unresolved; conclusions should be checked manually before reuse.',
      recommendations: ['Inspect each high-fragility assumption against the cited literature.', 'Prefer follow-up work with explicit robustness checks.'],
    };
  }
  if (fragilityScore >= 0.45 || unavailableCount >= 2) {
    return {
      level: 'medium' as const,
      description: 'Assumption coverage is partial; several assumptions remain uncertain or unavailable.',
      recommendations: ['Look for explicit assumption validation in later papers.', 'Document which assumptions you are carrying forward unchanged.'],
    };
  }
  return {
    level: 'low' as const,
    description: 'Assumption surface is relatively bounded, though still worth monitoring for later challenges.',
    recommendations: ['Track whether later papers revisit these assumptions explicitly.'],
  };
}

export async function trackAssumptions(
  params: AssumptionTrackerParams,
  ctx: AssumptionSamplingContext = {},
): Promise<AssumptionTrackerResult> {
  const recidError = validateRecid(params.recid);
  if (recidError) return { success: false, error: recidError, analysis: null };

  const maxDepth = validateMaxDepth(params.max_depth ?? 2, 2);
  const checkChallenges = params.check_challenges ?? true;

  try {
    const paper = await api.getPaper(params.recid);
    const references = await fetchReferenceContexts(params.recid, maxDepth);
    const promptVersion = 'sem05_assumption_tracker_v2';
    const inputHash = sha256Hex(JSON.stringify({
      recid: params.recid,
      title: paper.title,
      abstract: paper.abstract || '',
      references,
      max_depth: maxDepth,
      check_challenges: checkChallenges,
    }));
    if (!ctx.createMessage) {
      return {
        success: false,
        error: 'Semantic assumption tracking requires MCP client sampling support.',
        analysis: null,
        provenance: {
          backend: 'mcp_sampling',
          status: 'unavailable',
          reason_code: 'sampling_required',
          prompt_version: promptVersion,
          input_hash: inputHash,
        },
      };
    }

    let response: CreateMessageResult;
    try {
      response = await ctx.createMessage({
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: buildAssumptionExtractionPrompt({
              prompt_version: promptVersion,
              title: paper.title,
              abstract: paper.abstract || '',
              references,
              max_assumptions: getConfig().criticalResearch?.maxCriticalDependencies ?? 5,
            }),
          },
        }],
        maxTokens: 900,
        metadata: buildToolSamplingMetadata({
          tool: INSPIRE_CRITICAL_ANALYSIS,
          module: 'sem05_assumption_tracker',
          promptVersion,
          costClass: 'high',
        }),
      });
    } catch {
      return {
        success: false,
        error: 'Semantic assumption tracking failed because MCP sampling was unavailable.',
        analysis: null,
        provenance: {
          backend: 'mcp_sampling',
          status: 'unavailable',
          reason_code: 'sampling_error',
          prompt_version: promptVersion,
          input_hash: inputHash,
        },
      };
    }

    const parsed = parseAssumptionExtractionResponse(extractSamplingText(response.content));
    if (!parsed || parsed.abstain) {
      return {
        success: false,
        error: parsed?.abstain
          ? 'Semantic assumption tracking abstained from adjudication.'
          : 'Semantic assumption tracking returned an invalid response.',
        analysis: null,
        provenance: {
          backend: 'mcp_sampling',
          status: parsed?.abstain ? 'abstained' : 'invalid',
          reason_code: parsed?.abstain ? 'model_abstained' : 'invalid_response',
          prompt_version: promptVersion,
          input_hash: inputHash,
          model: response.model,
        },
      };
    }

    const assumptions: AssumptionNode[] = parsed.assumptions.slice(0, 6).map(item => ({
      assumption: item.assumption,
      type: item.type,
      source: item.source,
      inherited_from: item.inherited_from.length > 0 ? item.inherited_from : undefined,
      validation_status: checkChallenges ? 'uncertain' : 'unavailable',
      category: item.category_label,
      provenance: {
        backend: 'mcp_sampling',
        status: 'applied',
        reason_code: parsed.reason || 'semantic_assumption_extraction',
        prompt_version: promptVersion,
        input_hash: inputHash,
        model: response.model,
      },
    }));
    const provenance: SemanticAssessmentProvenance = assumptions[0]?.provenance ?? {
      backend: 'mcp_sampling',
      status: 'applied',
      reason_code: parsed.reason || 'semantic_assumption_extraction',
      prompt_version: promptVersion,
      input_hash: inputHash,
      model: response.model,
    };
    const fragilityScore = assumptions.length > 0
      ? calculateFragilityScore(assumptions)
      : 0.5;
    const uncertainCount = assumptions.filter(item => item.validation_status === 'uncertain').length;
    const unavailableCount = assumptions.filter(item => item.validation_status === 'unavailable').length;
    const analysis: AssumptionChain = {
      paper_recid: params.recid,
      paper_title: paper.title,
      paper_year: paper.year,
      core_assumptions: assumptions,
      fragility_score: Math.round(fragilityScore * 100) / 100,
      critical_dependencies: identifyCriticalDependencies(assumptions),
      summary: {
        total_assumptions: assumptions.length,
        explicit_count: assumptions.filter(item => item.type === 'explicit').length,
        implicit_count: assumptions.filter(item => item.type === 'implicit').length,
        inherited_count: assumptions.filter(item => item.source === 'inherited').length,
        challenged_count: assumptions.filter(item => item.validation_status === 'challenged').length,
        untested_count: assumptions.filter(item => item.validation_status === 'untested' || item.validation_status === 'uncertain' || item.validation_status === 'unavailable').length,
      },
      provenance,
    };

    return {
      success: true,
      analysis,
      risk_assessment: buildRiskAssessment(fragilityScore, uncertainCount, unavailableCount),
      provenance,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      analysis: null,
      provenance: { backend: 'diagnostic', status: 'unavailable', reason_code: 'upstream_error' },
    };
  }
}
