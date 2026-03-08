import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import { normalizeDiscoveryQuery, type DiscoveryQppAssessment } from '@autoresearch/shared';
import { buildToolSamplingMetadata } from '../../../core/sampling-metadata.js';
import { extractSamplingText } from '../../../core/semantics/quantitySampling.js';
import { buildQueryReformulationPrompt } from './queryReformulationPrompt.js';

type SamplingFn = (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;

type ParsedResponse = {
  abstain: boolean;
  reason: string;
  reformulated_query?: string;
};

export type QueryReformulationResult = {
  effective_query: string;
  normalized_effective_query: string;
  reformulation: {
    status: 'applied' | 'not_triggered' | 'abstained' | 'unavailable' | 'invalid' | 'budget_exhausted';
    reason: string;
    reformulated_query?: string;
    reason_codes: string[];
  };
  telemetry: {
    sampling_calls: number;
    reformulation_count: number;
    extra_provider_round_trips: number;
  };
};

function parseResponse(input: string): ParsedResponse | null {
  if (!input.trim()) return null;
  try {
    const parsed = JSON.parse(input) as ParsedResponse;
    if (typeof parsed.abstain !== 'boolean' || typeof parsed.reason !== 'string') return null;
    if (!parsed.abstain && (!parsed.reformulated_query || typeof parsed.reformulated_query !== 'string')) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function runDiscoveryQueryReformulation(params: {
  query: string;
  qpp: DiscoveryQppAssessment;
  createMessage?: SamplingFn;
  maxSamplingCalls: number;
}): Promise<QueryReformulationResult> {
  if (params.qpp.trigger_decision === 'not_triggered') {
    return {
      effective_query: params.query,
      normalized_effective_query: normalizeDiscoveryQuery(params.query),
      reformulation: { status: 'not_triggered', reason: 'trigger_not_recommended', reason_codes: params.qpp.reason_codes },
      telemetry: { sampling_calls: 0, reformulation_count: 0, extra_provider_round_trips: 0 },
    };
  }
  if (params.maxSamplingCalls < 1) {
    return {
      effective_query: params.query,
      normalized_effective_query: normalizeDiscoveryQuery(params.query),
      reformulation: { status: 'budget_exhausted', reason: 'sampling_budget_exhausted', reason_codes: ['sampling_budget_exhausted'] },
      telemetry: { sampling_calls: 0, reformulation_count: 0, extra_provider_round_trips: 0 },
    };
  }
  if (!params.createMessage) {
    return {
      effective_query: params.query,
      normalized_effective_query: normalizeDiscoveryQuery(params.query),
      reformulation: { status: 'unavailable', reason: 'sampling_unavailable', reason_codes: ['sampling_unavailable'] },
      telemetry: { sampling_calls: 0, reformulation_count: 0, extra_provider_round_trips: 0 },
    };
  }

  try {
    const response = await params.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: buildQueryReformulationPrompt({
        promptVersion: 'new-sem06d-r1',
        query: params.query,
        difficulty: params.qpp.difficulty,
        ambiguity: params.qpp.ambiguity,
        lowRecallRisk: params.qpp.low_recall_risk,
        reasonCodes: params.qpp.reason_codes,
      }) } }],
      maxTokens: 400,
      metadata: buildToolSamplingMetadata({
        tool: 'federated_discovery',
        module: 'sem06d_query_reformulator',
        promptVersion: 'new-sem06d-r1',
        costClass: 'medium',
        context: { query_length: params.query.length },
      }),
    });
    const parsed = parseResponse(extractSamplingText(response.content));
    if (!parsed) {
      return {
        effective_query: params.query,
        normalized_effective_query: normalizeDiscoveryQuery(params.query),
        reformulation: { status: 'invalid', reason: 'invalid_response', reason_codes: ['invalid_response'] },
        telemetry: { sampling_calls: 1, reformulation_count: 0, extra_provider_round_trips: 0 },
      };
    }
    if (parsed.abstain) {
      return {
        effective_query: params.query,
        normalized_effective_query: normalizeDiscoveryQuery(params.query),
        reformulation: { status: 'abstained', reason: parsed.reason, reason_codes: ['model_abstained'] },
        telemetry: { sampling_calls: 1, reformulation_count: 0, extra_provider_round_trips: 0 },
      };
    }
    const effective = parsed.reformulated_query!.trim();
    return {
      effective_query: effective,
      normalized_effective_query: normalizeDiscoveryQuery(effective),
      reformulation: {
        status: 'applied',
        reason: parsed.reason,
        reformulated_query: effective,
        reason_codes: ['single_turn_rewrite'],
      },
      telemetry: { sampling_calls: 1, reformulation_count: 1, extra_provider_round_trips: 1 },
    };
  } catch (error) {
    return {
      effective_query: params.query,
      normalized_effective_query: normalizeDiscoveryQuery(params.query),
      reformulation: {
        status: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
        reason_codes: ['sampling_unavailable'],
      },
      telemetry: { sampling_calls: 0, reformulation_count: 0, extra_provider_round_trips: 0 },
    };
  }
}
