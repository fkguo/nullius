import * as fs from 'fs';
import { z } from 'zod';
import {
  HEP_RUN_READ_ARTIFACT_CHUNK,
  HEP_RUN_STAGE_CONTENT,
  HEP_RUN_WRITING_CREATE_OUTLINE_CANDIDATES_PACKET_V1,
  HEP_RUN_WRITING_CREATE_OUTLINE_JUDGE_PACKET_V1,
  HEP_RUN_WRITING_SUBMIT_OUTLINE_CANDIDATES_V1,
  invalidParams,
} from '@autoresearch/shared';

import { getRun, type RunArtifactRef } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';

import { readStagedContent } from './staging.js';
import { ensureWritingQualityPolicyV1 } from './qualityPolicy.js';
import { computeUriSha256OrThrow, writeClientLlmResponseArtifact } from './reproducibility.js';
import { WritingCandidateSetV1Schema } from './nbestJudgeSchemas.js';
import { createRunWritingOutlinePlanPacket } from './outlinePlanPacket.js';
import { OutlinePlanV2Schema, validateOutlinePlanV2OrThrow, type OutlinePlanRequest, type OutlinePlan } from './outlinePlanner.js';

type CandidateSubmission = {
  candidate_index: number;
  outline_plan_uri: string;
  client_model?: string | null;
  temperature?: number | null;
  seed?: number | string | null;
};

type OutlineCandidatesPacketArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  quality_level: 'standard' | 'publication';
  n_candidates_requested: number;
  variation_strategy: string;
  temperatures: number[] | null;
  seeds: Array<number | string> | null;
  prompt_packet: { uri: string; sha256: string | null };
  inputs: Record<string, string>;
  next_actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
};

const OutlineCandidatesPacketArtifactV1Schema = z
  .object({
    version: z.literal(1),
    generated_at: z.string().min(1),
    run_id: z.string().min(1),
    project_id: z.string().min(1),
    quality_level: z.enum(['standard', 'publication']),
    n_candidates_requested: z.number().int().min(2),
    variation_strategy: z.string().min(1),
    temperatures: z.array(z.number()).nullable(),
    seeds: z.array(z.union([z.number(), z.string()])).nullable(),
    prompt_packet: z
      .object({
        uri: z.string().min(1),
        sha256: z.string().min(1).nullable(),
      })
      .strict(),
    inputs: z.record(z.string(), z.string().min(1)),
    next_actions: z.array(
      z
        .object({
          tool: z.string().min(1),
          args: z.record(z.string(), z.unknown()),
          reason: z.string().min(1),
        })
        .strict()
    ),
  })
  .strict();

type OutlinePlanPacketArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  request: {
    language: OutlinePlanRequest['language'];
    target_length: OutlinePlanRequest['target_length'];
    title: string;
    topic?: string;
    structure_hints?: string;
    user_outline?: string;
    claims_artifact_name: string;
    claims_count?: number;
    papers_count?: number;
  };
  prompt_packet: Record<string, unknown>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function runArtifactUri(runId: string, artifactName: string): string {
  return `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactName)}`;
}

function requiredCandidatesForQualityLevel(level: 'standard' | 'publication'): number {
  return level === 'publication' ? 3 : 2;
}

function readRunJsonArtifactOrThrow<T>(runId: string, artifactName: string): T {
  const p = getRunArtifactPath(runId, artifactName);
  if (!fs.existsSync(p)) {
    throw invalidParams(`Missing required run artifact: ${artifactName}`, { run_id: runId, artifact_name: artifactName });
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch (err) {
    const ref = writeRunJsonArtifact(runId, `writing_parse_error_artifact_${artifactName}.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      artifact_name: artifactName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw invalidParams('Malformed JSON in required run artifact (fail-fast)', {
      run_id: runId,
      artifact_name: artifactName,
      parse_error_uri: ref.uri,
      parse_error_artifact: ref.name,
      next_actions: [
        {
          tool: HEP_RUN_READ_ARTIFACT_CHUNK,
          args: { run_id: runId, artifact_name: artifactName, offset: 0, length: 1024 },
          reason: 'Inspect the corrupted artifact and re-generate it.',
        },
      ],
    });
  }
}

function readOutlinePlanRequestOrThrow(runId: string): OutlinePlanPacketArtifactV1['request'] {
  const packet = readRunJsonArtifactOrThrow<OutlinePlanPacketArtifactV1>(runId, 'writing_outline_plan_packet.json');
  const request = packet?.request;
  if (!request || typeof request !== 'object') {
    throw invalidParams('Invalid writing_outline_plan_packet.json: missing request', { run_id: runId });
  }
  const targetLength = request.target_length;
  const language = request.language;
  if (targetLength !== 'short' && targetLength !== 'medium' && targetLength !== 'long') {
    throw invalidParams('Invalid outline plan request: missing target_length', { run_id: runId });
  }
  if (language !== 'en' && language !== 'zh' && language !== 'auto') {
    throw invalidParams('Invalid outline plan request: missing language', { run_id: runId });
  }
  if (!request.title || typeof request.title !== 'string') {
    throw invalidParams('Invalid outline plan request: missing title', { run_id: runId });
  }
  if (!request.claims_artifact_name || typeof request.claims_artifact_name !== 'string') {
    throw invalidParams('Invalid outline plan request: missing claims_artifact_name', { run_id: runId });
  }
  return request;
}

export async function createRunWritingOutlineCandidatesPacketV1(params: {
  run_id: string;
  language?: 'en' | 'zh' | 'auto';
  target_length: 'short' | 'medium' | 'long';
  title: string;
  topic?: string;
  structure_hints?: string;
  user_outline?: string;
  claims_table_artifact_name?: string;
  n_candidates?: number;
  variation_strategy?: string;
  temperatures?: number[];
  seeds?: Array<number | string>;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
  next_actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
}> {
  const runId = params.run_id;
  const run = getRun(runId);

  const { policy: qualityPolicy, artifact: qualityPolicyRef } = ensureWritingQualityPolicyV1({ run_id: runId });
  const requiredN = requiredCandidatesForQualityLevel(qualityPolicy.quality_level);
  const requested = params.n_candidates ?? requiredN;
  if (!Number.isFinite(requested) || requested < requiredN || Math.trunc(requested) !== requested) {
    throw invalidParams('n_candidates must meet minimum required by quality_level (fail-fast)', {
      run_id: runId,
      quality_level: qualityPolicy.quality_level,
      n_candidates: params.n_candidates,
      required_min: requiredN,
    });
  }

  const variationStrategy = params.variation_strategy?.trim() ? params.variation_strategy.trim() : 'temperature_sweep';
  const temperatures = params.temperatures?.length ? [...params.temperatures] : null;
  const seeds = params.seeds?.length ? [...params.seeds] : null;

  const llmRequestName = 'llm_request_writing_outline_round_01.json';
  const baseArtifacts: RunArtifactRef[] = [];
  if (!fs.existsSync(getRunArtifactPath(runId, llmRequestName))) {
    const res = await createRunWritingOutlinePlanPacket({
      run_id: runId,
      language: params.language ?? 'auto',
      target_length: params.target_length,
      title: params.title,
      topic: params.topic,
      structure_hints: params.structure_hints,
      user_outline: params.user_outline,
      claims_table_artifact_name: params.claims_table_artifact_name,
    });
    baseArtifacts.push(...res.artifacts);
  }

  if (!fs.existsSync(getRunArtifactPath(runId, llmRequestName))) {
    throw invalidParams('Missing llm_request artifact for outline candidates packet (fail-fast)', {
      run_id: runId,
      artifact_name: llmRequestName,
      next_actions: [
        {
          tool: HEP_RUN_WRITING_CREATE_OUTLINE_CANDIDATES_PACKET_V1,
          args: { run_id: runId, target_length: params.target_length, title: params.title },
          reason: 'Create outline candidates packet first, then retry.',
        },
      ],
    });
  }

  const promptPacketUri = runArtifactUri(runId, llmRequestName);
  const promptPacketSha256 = computeUriSha256OrThrow({ run_id: runId, uri: promptPacketUri });

  const outName = 'writing_outline_candidates_packet_v1.json';

  const nextActions: Array<{ tool: string; args: Record<string, unknown>; reason: string }> = [
    ...Array.from({ length: requested }, (_, idx) => ({
      tool: HEP_RUN_STAGE_CONTENT,
      args: {
        run_id: runId,
        content_type: 'outline_plan',
        content: '<JSON.stringify(OutlinePlanV2) then stage>',
        artifact_suffix: `outline_candidate_${pad2(idx)}_v1`,
      },
      reason: `Stage outline candidate #${idx} OutlinePlanV2 JSON (Evidence-first).`,
    })),
    {
      tool: HEP_RUN_WRITING_SUBMIT_OUTLINE_CANDIDATES_V1,
      args: {
        run_id: runId,
        candidates: Array.from({ length: requested }, (_, idx) => ({
          candidate_index: idx,
          outline_plan_uri: `<staging_uri from hep_run_stage_content (candidate_index=${idx})>`,
          client_model: null,
          temperature: null,
          seed: 'unknown',
        })),
      },
      reason: 'Submit N-best outline candidates for strict schema validation and reproducible artifacts (fail-fast).',
    },
  ];

  const inputs: Record<string, string> = {
    quality_policy_uri: qualityPolicyRef.uri,
    prompt_packet_uri: promptPacketUri,
    outline_plan_packet_uri: runArtifactUri(runId, 'writing_outline_plan_packet.json'),
  };

  const payload: OutlineCandidatesPacketArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    quality_level: qualityPolicy.quality_level,
    n_candidates_requested: requested,
    variation_strategy: variationStrategy,
    temperatures,
    seeds,
    prompt_packet: { uri: promptPacketUri, sha256: promptPacketSha256 ?? null },
    inputs,
    next_actions: nextActions,
  };

  const parsedPayload = OutlineCandidatesPacketArtifactV1Schema.parse(payload);
  const packetRef = writeRunJsonArtifact(runId, outName, parsedPayload);

  return {
    run_id: runId,
    project_id: run.project_id,
    manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
    artifacts: [...baseArtifacts, qualityPolicyRef, packetRef],
    summary: {
      quality_level: qualityPolicy.quality_level,
      n_candidates_requested: requested,
      prompt_packet_uri: promptPacketUri,
      prompt_packet_sha256: promptPacketSha256,
      candidates_packet_uri: packetRef.uri,
      candidates_packet_artifact: outName,
    },
    next_actions: nextActions,
  };
}

export async function submitRunWritingOutlineCandidatesV1(params: {
  run_id: string;
  candidates: CandidateSubmission[];
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
  next_actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
}> {
  const runId = params.run_id;
  const run = getRun(runId);

  const { policy: qualityPolicy, artifact: qualityPolicyRef } = ensureWritingQualityPolicyV1({ run_id: runId });
  const requiredN = requiredCandidatesForQualityLevel(qualityPolicy.quality_level);

  const packetName = 'writing_outline_candidates_packet_v1.json';
  const packetRaw = readRunJsonArtifactOrThrow<unknown>(runId, packetName);
  const packetParsed = OutlineCandidatesPacketArtifactV1Schema.safeParse(packetRaw);
  if (!packetParsed.success) {
    const ref = writeRunJsonArtifact(runId, `writing_parse_error_artifact_${packetName}.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      artifact_name: packetName,
      issues: packetParsed.error.issues,
    });
    throw invalidParams('Outline candidates packet artifact does not match schema (fail-fast)', {
      run_id: runId,
      artifact_name: packetName,
      parse_error_uri: ref.uri,
      parse_error_artifact: ref.name,
      next_actions: [
        {
          tool: HEP_RUN_WRITING_CREATE_OUTLINE_CANDIDATES_PACKET_V1,
          args: { run_id: runId, target_length: '<short|medium|long>', title: '<paper title>' },
          reason: 'Recreate the outline candidates packet artifact before submitting candidates.',
        },
      ],
    });
  }
  const packet = packetParsed.data;

  const submitted = params.candidates ?? [];
  if (submitted.length < requiredN) {
    throw invalidParams('Insufficient candidates for quality_level (fail-fast)', {
      run_id: runId,
      quality_level: qualityPolicy.quality_level,
      candidates_submitted: submitted.length,
      required_min: requiredN,
      next_actions: packet.next_actions,
    });
  }

  if (submitted.length !== packet.n_candidates_requested) {
    throw invalidParams('Candidates count does not match n_candidates_requested (fail-fast)', {
      run_id: runId,
      n_candidates_requested: packet.n_candidates_requested,
      candidates_submitted: submitted.length,
      next_actions: packet.next_actions,
    });
  }

  const expectedIndices = new Set(Array.from({ length: packet.n_candidates_requested }, (_, idx) => idx));
  const seenIndices = new Set<number>();
  for (const c of submitted) {
    if (!Number.isFinite(c.candidate_index) || Math.trunc(c.candidate_index) !== c.candidate_index || c.candidate_index < 0) {
      throw invalidParams('candidate_index must be a non-negative integer', {
        run_id: runId,
        candidate_index: c.candidate_index,
      });
    }
    if (!expectedIndices.has(c.candidate_index)) {
      throw invalidParams('candidate_index out of expected range (fail-fast)', {
        run_id: runId,
        candidate_index: c.candidate_index,
        expected_range: `0..${packet.n_candidates_requested - 1}`,
      });
    }
    if (seenIndices.has(c.candidate_index)) {
      throw invalidParams('Duplicate candidate_index is not allowed (fail-fast)', {
        run_id: runId,
        candidate_index: c.candidate_index,
      });
    }
    seenIndices.add(c.candidate_index);
  }

  const outlineRequest = readOutlinePlanRequestOrThrow(runId);
  const claimsArtifact = readRunJsonArtifactOrThrow<any>(runId, outlineRequest.claims_artifact_name);
  const claimsTable = claimsArtifact?.claims_table;
  const claims = Array.isArray(claimsTable?.claims) ? claimsTable.claims : [];

  const failures: Array<{ candidate_index: number; outline_plan_uri: string; issues: unknown }> = [];
  const parsedPlans = new Map<number, OutlinePlan>();
  const candidateResponseRefs: RunArtifactRef[] = [];

  for (const c of submitted) {
    const rawData = await readStagedContent(runId, c.outline_plan_uri, 'outline_plan');
    const parsed = OutlinePlanV2Schema.safeParse(rawData);
    if (!parsed.success) {
      failures.push({ candidate_index: c.candidate_index, outline_plan_uri: c.outline_plan_uri, issues: parsed.error.issues });
      continue;
    }
    try {
      validateOutlinePlanV2OrThrow({ plan: parsed.data, claims, target_length: outlineRequest.target_length });
      parsedPlans.set(c.candidate_index, parsed.data);
    } catch (err) {
      const anyErr = err as any;
      const code = anyErr?.code ?? anyErr?.error?.code ?? anyErr?.data?.code;
      const message = typeof anyErr?.message === 'string' ? anyErr.message : typeof anyErr?.error?.message === 'string' ? anyErr.error.message : null;
      const data = (typeof anyErr?.data === 'object' && anyErr.data) ? anyErr.data : (typeof anyErr?.error?.data === 'object' && anyErr.error.data) ? anyErr.error.data : null;
      const details = code === 'INVALID_PARAMS'
        ? { code, message, data }
        : { message: message ?? 'Outline candidate validation failed', error: err instanceof Error ? err.message : String(err) };
      failures.push({
        candidate_index: c.candidate_index,
        outline_plan_uri: c.outline_plan_uri,
        issues: details,
      });
    }
  }

  if (failures.length > 0) {
    const ref = writeRunJsonArtifact(runId, 'writing_parse_error_candidates_outline_v1.json', {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      prompt_packet_uri: packet.prompt_packet.uri,
      prompt_packet_sha256: packet.prompt_packet.sha256,
      failures,
      received: submitted,
    });
    throw invalidParams('One or more outline candidates failed validation (fail-fast)', {
      run_id: runId,
      parse_error_uri: ref.uri,
      parse_error_artifact: ref.name,
      next_actions: packet.next_actions,
    });
  }

  for (const c of submitted) {
    const plan = parsedPlans.get(c.candidate_index);
    if (!plan) throw new Error(`Internal: missing parsed candidate_index=${c.candidate_index}`);
    const responseRef = writeClientLlmResponseArtifact({
      run_id: runId,
      artifact_name: `writing_client_llm_response_outline_candidate_${pad2(c.candidate_index)}_v1.json`,
      step: 'writing_outline',
      prompt_packet_uri: packet.prompt_packet.uri,
      prompt_packet_sha256: packet.prompt_packet.sha256 ?? undefined,
      client_raw_output_uri: c.outline_plan_uri,
      parsed: plan,
      client_model: c.client_model ?? null,
      temperature: c.temperature ?? null,
      seed: c.seed ?? 'unknown',
    });
    candidateResponseRefs.push(responseRef);
  }

  const candidatesMeta = submitted
    .map(c => {
      const outputSha = computeUriSha256OrThrow({ run_id: runId, uri: c.outline_plan_uri });
      const responseRef = candidateResponseRefs.find(r => r.name.endsWith(`_${pad2(c.candidate_index)}_v1.json`)) ?? null;
      return {
        candidate_index: c.candidate_index,
        output_uri: c.outline_plan_uri,
        output_sha256: outputSha ?? null,
        client_model: c.client_model ?? null,
        temperature: c.temperature ?? null,
        seed: (c.seed ?? 'unknown') as any,
        client_response_uri: responseRef?.uri ?? null,
      };
    })
    .sort((a, b) => a.candidate_index - b.candidate_index);

  const candidateSetPayload = WritingCandidateSetV1Schema.parse({
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    candidate_type: 'outline_plan_v2',
    n_candidates: candidatesMeta.length,
    inputs: {
      quality_policy_uri: qualityPolicyRef.uri,
      outline_plan_packet_uri: runArtifactUri(runId, 'writing_outline_plan_packet.json'),
      prompt_packet_uri: packet.prompt_packet.uri,
    },
    generation_config: {
      mode_used: 'client',
      client_model: null,
      temperature: null,
      seed: 'unknown',
      prompt_packet_uri: packet.prompt_packet.uri,
      prompt_packet_sha256: packet.prompt_packet.sha256,
    },
    candidates: candidatesMeta,
    meta: {
      quality_level: qualityPolicy.quality_level,
      n_candidates_requested: packet.n_candidates_requested,
      variation_strategy: packet.variation_strategy,
      temperatures: packet.temperatures,
      seeds: packet.seeds,
    },
  });

  const outName = 'writing_candidates_outline_v1.json';
  const candidateSetRef = writeRunJsonArtifact(runId, outName, candidateSetPayload);

  const nextActions: Array<{ tool: string; args: Record<string, unknown>; reason: string }> = [
    {
      tool: HEP_RUN_WRITING_CREATE_OUTLINE_JUDGE_PACKET_V1,
      args: { run_id: runId, candidates_uri: candidateSetRef.uri },
      reason: 'Create the Judge prompt_packet for selecting the best outline candidate (N-best → Judge → outline_contract_gate).',
    },
  ];

  return {
    run_id: runId,
    project_id: run.project_id,
    manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
    artifacts: [qualityPolicyRef, ...candidateResponseRefs, candidateSetRef],
    summary: {
      candidates_uri: candidateSetRef.uri,
      candidates_artifact: outName,
      n_candidates: candidatesMeta.length,
      quality_level: qualityPolicy.quality_level,
    },
    next_actions: nextActions,
  };
}
