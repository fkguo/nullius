import * as fs from 'fs';

import {
  HEP_RUN_WRITING_BUILD_EVIDENCE_PACKET_SECTION_V2,
  HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1,
  invalidParams,
} from '@autoresearch/shared';

import { getRun, type RunArtifactRef } from '../runs.js';
import { getRunArtifactPath, assertSafePathSegment } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';

import { estimateTokens } from '../../tools/writing/rag/hepTokenizer.js';
import { PromptPacketSchema, type PromptPacket } from '../contracts/promptPacket.js';
import { readWritingTokenBudgetPlanV1OrThrow, type WritingTokenBudgetPlanStepV1 } from './tokenBudgetPlan.js';

type TokenGateStepV1 = WritingTokenBudgetPlanStepV1 | 'custom';

type TokenGateContributorV1 =
  | {
      kind: 'prompt_field';
      field: 'system_prompt' | 'user_prompt';
      tokens_estimate: number;
    }
  | {
      kind: 'evidence_chunk';
      chunk_id?: string;
      paper_id?: string;
      section_path?: string[];
      tokens_estimate: number;
      source_uri?: string;
    }
  | {
      kind: 'candidate';
      candidate_index?: number;
      chunk_id?: string;
      tokens_estimate: number;
      source_uri?: string;
    }
  | {
      kind: 'unknown';
      label: string;
      tokens_estimate: number;
      source_uri?: string;
    };

type TokenGatePassArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  step: TokenGateStepV1;
  tokenizer_model: string;
  budget: {
    model_context_tokens: number;
    safety_margin_tokens: number;
    reserved_output_tokens: number;
    budget_input_tokens: number;
  };
  estimates: {
    estimated_prompt_tokens: number;
    estimated_context_tokens: number;
    estimated_total_input_tokens: number;
  };
  prompt_packet_uri?: string;
  evidence_packet_uri?: string;
  largest_contributors: TokenGateContributorV1[];
};

type TokenOverflowArtifactV1 = TokenGatePassArtifactV1 & {
  overflow: true;
  next_actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.trunc(value)
      : typeof value === 'string'
        ? Math.trunc(Number.parseInt(value, 10))
        : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseRunArtifactUri(uri: string): { runId: string; artifactName: string } {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw invalidParams('Invalid artifact URI', { uri });
  }

  if (url.protocol !== 'hep:') throw invalidParams('Invalid artifact URI protocol', { uri, protocol: url.protocol });
  if (url.host !== 'runs') throw invalidParams('Invalid artifact URI host', { uri, host: url.host });

  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
  } catch (err) {
    throw invalidParams('Invalid artifact URI encoding', { uri, error: err instanceof Error ? err.message : String(err) });
  }
  if (segments.length !== 3 || segments[1] !== 'artifact') {
    throw invalidParams('Invalid artifact URI path (expected hep://runs/<run_id>/artifact/<artifact_name>)', { uri });
  }

  const runId = segments[0]!;
  const artifactName = segments[2]!;
  assertSafePathSegment(runId, 'run_id');
  assertSafePathSegment(artifactName, 'artifact_name');
  return { runId, artifactName };
}

function readRunArtifactJsonOrThrow<T>(runId: string, uri: string): T {
  const parsed = parseRunArtifactUri(uri);
  if (parsed.runId !== runId) {
    throw invalidParams('Cross-run artifact reference is not allowed', { run_id: runId, uri });
  }

  const artifactPath = getRunArtifactPath(runId, parsed.artifactName);
  if (!fs.existsSync(artifactPath)) {
    throw invalidParams('Run artifact not found', { run_id: runId, artifact_name: parsed.artifactName, uri });
  }

  try {
    return JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as T;
  } catch (err) {
    throw invalidParams('Malformed JSON in run artifact', { run_id: runId, artifact_name: parsed.artifactName, uri, error: String(err) });
  }
}

function normalizePromptPacketOrThrow(raw: unknown): PromptPacket {
  const parsed = PromptPacketSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalidParams('prompt_packet does not match PromptPacketSchema', { issues: parsed.error.issues });
  }
  return parsed.data;
}

function estimatePromptPacketTokens(packet: PromptPacket): { tokens: number; contributors: TokenGateContributorV1[] } {
  const systemTokens = estimateTokens(packet.system_prompt);
  const userTokens = estimateTokens(packet.user_prompt);
  return {
    tokens: systemTokens + userTokens,
    contributors: [
      { kind: 'prompt_field', field: 'system_prompt', tokens_estimate: systemTokens },
      { kind: 'prompt_field', field: 'user_prompt', tokens_estimate: userTokens },
    ],
  };
}

function extractEvidenceContributors(raw: unknown, sourceUri?: string): { tokens: number; contributors: TokenGateContributorV1[] } {
  if (!raw || typeof raw !== 'object') {
    const tokens = estimateTokens(JSON.stringify(raw ?? null));
    return { tokens, contributors: [{ kind: 'unknown', label: 'evidence_packet', tokens_estimate: tokens, ...(sourceUri ? { source_uri: sourceUri } : {}) }] };
  }

  const obj = raw as Record<string, unknown>;
  const candidates = Array.isArray(obj.candidates) ? (obj.candidates as unknown[]) : null;
  const chunks = Array.isArray(obj.chunks) ? (obj.chunks as unknown[]) : null;
  const contextChunks = Array.isArray(obj.context_chunks) ? (obj.context_chunks as unknown[]) : null;

  const contributors: TokenGateContributorV1[] = [];
  let total = 0;

  const pushChunk = (chunk: any, kind: 'evidence_chunk'): void => {
    const text = typeof chunk?.text === 'string' ? chunk.text : '';
    const est = Number(chunk?.metadata?.token_estimate);
    const tokens = Number.isFinite(est) && est > 0 ? Math.trunc(est) : estimateTokens(text);
    total += tokens;

    contributors.push({
      kind,
      chunk_id: typeof chunk?.id === 'string' ? chunk.id : undefined,
      paper_id: typeof chunk?.locator?.paper_id === 'string' ? chunk.locator.paper_id : undefined,
      section_path: Array.isArray(chunk?.locator?.section_path) ? chunk.locator.section_path.map((s: any) => String(s)) : undefined,
      tokens_estimate: tokens,
      ...(sourceUri ? { source_uri: sourceUri } : {}),
    });
  };

  const pushCandidate = (cand: any, idx: number): void => {
    const content = typeof cand?.content === 'string' ? cand.content : typeof cand?.text === 'string' ? cand.text : '';
    const tokens = estimateTokens(content);
    total += tokens;
    contributors.push({
      kind: 'candidate',
      candidate_index: Number.isFinite(idx) ? idx : undefined,
      chunk_id: typeof cand?.chunk_id === 'string' ? cand.chunk_id : undefined,
      tokens_estimate: tokens,
      ...(sourceUri ? { source_uri: sourceUri } : {}),
    });
  };

  if (chunks) {
    for (const c of chunks) pushChunk(c as any, 'evidence_chunk');
  }
  if (contextChunks) {
    for (const c of contextChunks) pushChunk(c as any, 'evidence_chunk');
  }
  if (candidates) {
    for (let i = 0; i < candidates.length; i++) pushCandidate(candidates[i] as any, i);
  }

  if (contributors.length === 0) {
    const tokens = estimateTokens(JSON.stringify(raw));
    return { tokens, contributors: [{ kind: 'unknown', label: 'evidence_packet', tokens_estimate: tokens, ...(sourceUri ? { source_uri: sourceUri } : {}) }] };
  }

  return { tokens: total, contributors };
}

function topContributors(contributors: TokenGateContributorV1[], limit = 20): TokenGateContributorV1[] {
  return [...contributors]
    .sort((a, b) => b.tokens_estimate - a.tokens_estimate)
    .slice(0, Math.max(1, limit));
}

export async function runWritingTokenGateV1(params: {
  run_id: string;
  step: TokenGateStepV1;
  prompt_packet?: unknown;
  prompt_packet_uri?: string;
  evidence_packet_uri?: string;
  max_context_tokens?: number;
  safety_margin_tokens?: number;
  reserved_output_tokens?: number;
  token_budget_plan_artifact_name?: string;
  section_index?: number;
  output_pass_artifact_name?: string;
  output_overflow_artifact_name?: string;
  tokenizer_model?: string;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
  next_actions?: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
}> {
  const runId = params.run_id;
  const run = getRun(runId);
  const manifestUri = `hep://runs/${encodeURIComponent(runId)}/manifest`;

  const step = params.step;
  const sectionIndex = typeof params.section_index === 'number' && Number.isFinite(params.section_index)
    ? Math.max(0, Math.trunc(params.section_index))
    : undefined;

  const plan = (() => {
    const name = params.token_budget_plan_artifact_name?.trim()
      ? params.token_budget_plan_artifact_name.trim()
      : 'writing_token_budget_plan_v1.json';
    const p = getRunArtifactPath(runId, name);
    if (!fs.existsSync(p)) return null;
    return readWritingTokenBudgetPlanV1OrThrow({ run_id: runId, artifact_name: name });
  })();

  const modelContextTokens = clampInt(
    params.max_context_tokens ?? plan?.model_context_hint?.max_context_tokens,
    0,
    1_024,
    2_000_000
  );
  if (modelContextTokens <= 0) {
    throw invalidParams('TokenGate requires max_context_tokens (or a writing_token_budget_plan_v1.json artifact).', {
      run_id: runId,
      step,
      manifest_uri: manifestUri,
      next_actions: [
        {
          tool: HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1,
          args: { run_id: runId, model_context_tokens: 32_000 },
          reason: 'Create a token budget plan (includes model context hint + reserved output budgets).',
        },
      ],
    });
  }

  const safetyMarginTokens = clampInt(params.safety_margin_tokens ?? plan?.safety_margin_tokens, 512, 0, modelContextTokens);
  const reservedOutputTokens = clampInt(
    params.reserved_output_tokens ?? (step !== 'custom' ? (plan?.per_step_budgets as any)?.[step]?.reserved_output_tokens : undefined),
    0,
    0,
    modelContextTokens
  );
  if (step !== 'custom' && reservedOutputTokens === 0) {
    throw invalidParams('TokenGate requires reserved_output_tokens (or a token budget plan with per_step_budgets).', {
      run_id: runId,
      step,
      manifest_uri: manifestUri,
      next_actions: [
        {
          tool: HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1,
          args: { run_id: runId, model_context_tokens: modelContextTokens },
          reason: 'Create/update token budget plan with per-step reserved output budgets.',
        },
      ],
    });
  }

  const budgetInputTokens = modelContextTokens - safetyMarginTokens - reservedOutputTokens;
  if (budgetInputTokens <= 0) {
    throw invalidParams('No input budget remains after safety_margin_tokens + reserved_output_tokens (fail-fast).', {
      run_id: runId,
      step,
      manifest_uri: manifestUri,
      model_context_tokens: modelContextTokens,
      safety_margin_tokens: safetyMarginTokens,
      reserved_output_tokens: reservedOutputTokens,
      budget_input_tokens: budgetInputTokens,
      next_actions: [
        {
          tool: HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1,
          args: { run_id: runId, model_context_tokens: Math.max(modelContextTokens, safetyMarginTokens + reservedOutputTokens + 1024) },
          reason: 'Increase model_context_tokens so there is room for prompt+context+output.',
        },
      ],
    });
  }

  const promptPacket = (() => {
    if (params.prompt_packet_uri) {
      const raw = readRunArtifactJsonOrThrow<unknown>(runId, params.prompt_packet_uri);
      return normalizePromptPacketOrThrow(raw);
    }
    if (params.prompt_packet !== undefined) {
      return normalizePromptPacketOrThrow(params.prompt_packet);
    }
    return null;
  })();

  const promptEstimate = promptPacket ? estimatePromptPacketTokens(promptPacket) : { tokens: 0, contributors: [] };

  const evidenceEstimate = (() => {
    if (!params.evidence_packet_uri) return { tokens: 0, contributors: [] as TokenGateContributorV1[] };
    const raw = readRunArtifactJsonOrThrow<unknown>(runId, params.evidence_packet_uri);
    return extractEvidenceContributors(raw, params.evidence_packet_uri);
  })();

  const estimatedTotalInputTokens = promptEstimate.tokens + evidenceEstimate.tokens;
  const largest = topContributors([...promptEstimate.contributors, ...evidenceEstimate.contributors], 20);

  const passArtifactName = params.output_pass_artifact_name?.trim()
    ? params.output_pass_artifact_name.trim()
    : `token_gate_pass_${step}${sectionIndex ? `_section_${pad3(sectionIndex)}` : ''}_v1.json`;
  const overflowArtifactName = params.output_overflow_artifact_name?.trim()
    ? params.output_overflow_artifact_name.trim()
    : `writing_token_overflow_${step}${sectionIndex ? `_section_${pad3(sectionIndex)}` : ''}_v1.json`;

  const tokenizerModel = params.tokenizer_model?.trim()
    ? params.tokenizer_model.trim()
    : plan?.tokenizer_model?.trim()
      ? plan.tokenizer_model.trim()
      : 'claude-opus-4-6';

  const base: TokenGatePassArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    step,
    tokenizer_model: tokenizerModel,
    budget: {
      model_context_tokens: modelContextTokens,
      safety_margin_tokens: safetyMarginTokens,
      reserved_output_tokens: reservedOutputTokens,
      budget_input_tokens: budgetInputTokens,
    },
    estimates: {
      estimated_prompt_tokens: promptEstimate.tokens,
      estimated_context_tokens: evidenceEstimate.tokens,
      estimated_total_input_tokens: estimatedTotalInputTokens,
    },
    ...(params.prompt_packet_uri ? { prompt_packet_uri: params.prompt_packet_uri } : {}),
    ...(params.evidence_packet_uri ? { evidence_packet_uri: params.evidence_packet_uri } : {}),
    largest_contributors: largest,
  };

  if (estimatedTotalInputTokens <= budgetInputTokens) {
    const ref = writeRunJsonArtifact(runId, passArtifactName, base);
    return {
      run_id: runId,
      project_id: run.project_id,
      manifest_uri: manifestUri,
      artifacts: [ref],
      summary: {
        gate: 'pass',
        token_gate_pass_uri: ref.uri,
        token_gate_pass_artifact: passArtifactName,
        estimated_total_input_tokens: estimatedTotalInputTokens,
        budget_input_tokens: budgetInputTokens,
      },
    };
  }

  const nextActions: TokenOverflowArtifactV1['next_actions'] = [
    {
      tool: HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1,
      args: { run_id: runId, model_context_tokens: Math.max(modelContextTokens, estimatedTotalInputTokens + safetyMarginTokens + reservedOutputTokens) },
      reason: 'Increase model_context_tokens (use a larger-context model) so prompt+context fits without trimming.',
    },
    ...(step === 'evidence_rerank'
      ? ([
          {
            tool: HEP_RUN_WRITING_BUILD_EVIDENCE_PACKET_SECTION_V2,
            args: {
              section_index: sectionIndex ?? 1,
              max_candidates: 100,
              max_chunk_chars: 300,
            },
            reason: 'Reduce rerank prompt size by lowering max_candidates and max_chunk_chars (fail-fast; no silent trim).',
          },
        ] as const)
      : []),
  ];

  const overflowPayload: TokenOverflowArtifactV1 = {
    ...base,
    overflow: true,
    next_actions: nextActions,
  };

  const ref = writeRunJsonArtifact(runId, overflowArtifactName, overflowPayload);
  const overflowTokens = estimatedTotalInputTokens - budgetInputTokens;
  throw invalidParams(
    `TokenGate overflow: exceeds token budget by ${overflowTokens} tokens. See overflow artifact at ${ref.uri} for guidance.`,
    {
      run_id: runId,
      step,
      manifest_uri: manifestUri,
      artifacts: [ref],
      token_overflow_uri: ref.uri,
      token_overflow_artifact: overflowArtifactName,
      overflow_tokens: overflowTokens,
      estimated_total_input_tokens: estimatedTotalInputTokens,
      budget_input_tokens: budgetInputTokens,
      next_actions: nextActions,
    }
  );
}
