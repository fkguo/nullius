import * as fs from 'fs';
import { z } from 'zod';
import {
  HEP_RUN_READ_ARTIFACT_CHUNK,
  HEP_RUN_STAGE_CONTENT,
  HEP_RUN_WRITING_CREATE_SECTION_CANDIDATES_PACKET_V1,
  HEP_RUN_WRITING_CREATE_SECTION_JUDGE_PACKET_V1,
  HEP_RUN_WRITING_CREATE_SECTION_WRITE_PACKET_V1,
  HEP_RUN_WRITING_SUBMIT_SECTION_CANDIDATES_V1,
  invalidParams,
} from '@autoresearch/shared';

import { getRun, type RunArtifactRef } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';

import { SectionOutputSubmissionSchema } from './sectionOutputSchema.js';
import { readStagedContent } from './staging.js';
import { ensureWritingQualityPolicyV1 } from './qualityPolicy.js';
import { computeUriSha256OrThrow, writeClientLlmResponseArtifact } from './reproducibility.js';
import { WritingCandidateSetV1Schema } from './nbestJudgeSchemas.js';
import { createRunWritingSectionWritePacketV1 } from './sectionWritePacket.js';

type CandidateSubmission = {
  candidate_index: number;
  section_output_uri: string;
  client_model?: string | null;
  temperature?: number | null;
  seed?: number | string | null;
};

type SectionCandidatesPacketArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  section_index: number;
  quality_level: 'standard' | 'publication';
  n_candidates_requested: number;
  variation_strategy: string;
  temperatures: number[] | null;
  seeds: Array<number | string> | null;
  prompt_packet: { uri: string; sha256: string | null };
  prompt_text_uri: string;
  inputs: Record<string, string>;
  next_actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
};

const SectionCandidatesPacketArtifactV1Schema = z
  .object({
    version: z.literal(1),
    generated_at: z.string().min(1),
    run_id: z.string().min(1),
    project_id: z.string().min(1),
    section_index: z.number().int().positive(),
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
    prompt_text_uri: z.string().min(1),
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

function nowIso(): string {
  return new Date().toISOString();
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
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

export async function createRunWritingSectionCandidatesPacketV1(params: {
  run_id: string;
  section_index: number;
  n_candidates?: number;
  variation_strategy?: string;
  temperatures?: number[];
  seeds?: Array<number | string>;
  output_artifact_name?: string;
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
  const sectionIndex = params.section_index;
  if (!Number.isFinite(sectionIndex) || sectionIndex < 1 || Math.trunc(sectionIndex) !== sectionIndex) {
    throw invalidParams('section_index must be a positive integer', { section_index: params.section_index });
  }

  const { policy: qualityPolicy, artifact: qualityPolicyRef } = ensureWritingQualityPolicyV1({ run_id: runId });
  const requiredN = requiredCandidatesForQualityLevel(qualityPolicy.quality_level);
  const requested = params.n_candidates ?? requiredN;
  if (!Number.isFinite(requested) || requested < requiredN || Math.trunc(requested) !== requested) {
    throw invalidParams('n_candidates must meet minimum required by quality_level (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      quality_level: qualityPolicy.quality_level,
      n_candidates: params.n_candidates,
      required_min: requiredN,
      next_actions: [
        {
          tool: HEP_RUN_WRITING_CREATE_SECTION_CANDIDATES_PACKET_V1,
          args: { run_id: runId, section_index: sectionIndex, n_candidates: requiredN },
          reason: 'Regenerate candidate packet with a valid n_candidates.',
        },
      ],
    });
  }

  const variationStrategy = params.variation_strategy?.trim() ? params.variation_strategy.trim() : 'temperature_sweep';
  const temperatures = params.temperatures?.length ? [...params.temperatures] : null;
  const seeds = params.seeds?.length ? [...params.seeds] : null;

  const llmRequestName = `llm_request_writing_sections_section_${pad3(sectionIndex)}_round_01.json`;
  const promptTextName = `writing_section_prompt_section_${pad3(sectionIndex)}_v1.txt`;
  const sectionWritePacketName = `writing_section_write_packet_section_${pad3(sectionIndex)}_v1.json`;
  const evidenceContextName = `writing_section_evidence_context_section_${pad3(sectionIndex)}_v1.md`;

  const baseArtifacts: RunArtifactRef[] = [];
  if (!fs.existsSync(getRunArtifactPath(runId, llmRequestName))) {
    const res = await createRunWritingSectionWritePacketV1({ run_id: runId, section_index: sectionIndex });
    baseArtifacts.push(...res.artifacts);
  }

  if (!fs.existsSync(getRunArtifactPath(runId, llmRequestName))) {
    throw invalidParams('Missing llm_request artifact for section candidates packet (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      artifact_name: llmRequestName,
      next_actions: [
        {
          tool: HEP_RUN_WRITING_CREATE_SECTION_WRITE_PACKET_V1,
          args: { run_id: runId, section_index: sectionIndex },
          reason: 'Create section write packet first, then retry creating section candidates packet.',
        },
      ],
    });
  }

  const promptPacketUri = runArtifactUri(runId, llmRequestName);
  const promptPacketSha256 = computeUriSha256OrThrow({ run_id: runId, uri: promptPacketUri });
  const promptTextUri = fs.existsSync(getRunArtifactPath(runId, promptTextName)) ? runArtifactUri(runId, promptTextName) : promptPacketUri;

  const outName = params.output_artifact_name?.trim()
    ? params.output_artifact_name.trim()
    : `writing_section_candidates_packet_section_${pad3(sectionIndex)}_v1.json`;

  const nextActions: Array<{ tool: string; args: Record<string, unknown>; reason: string }> = [
    ...Array.from({ length: requested }, (_, idx) => ({
      tool: HEP_RUN_STAGE_CONTENT,
      args: {
        run_id: runId,
        content_type: 'section_output',
        content: '<JSON.stringify(SectionOutputSubmission for candidate) then stage>',
        artifact_suffix: `section_${pad3(sectionIndex)}_candidate_${pad2(idx)}_v1`,
      },
      reason: `Stage candidate #${idx} SectionOutputSubmission JSON (Evidence-first).`,
    })),
    {
      tool: HEP_RUN_WRITING_SUBMIT_SECTION_CANDIDATES_V1,
      args: {
        run_id: runId,
        section_index: sectionIndex,
        candidates: Array.from({ length: requested }, (_, idx) => ({
          candidate_index: idx,
          section_output_uri: `<staging_uri from hep_run_stage_content (candidate_index=${idx})>`,
          client_model: null,
          temperature: null,
          seed: 'unknown',
        })),
      },
      reason: 'Submit N-best section candidates for strict schema validation and reproducible artifacts (fail-fast).',
    },
  ];

  const inputs: Record<string, string> = {
    quality_policy_uri: qualityPolicyRef.uri,
    prompt_packet_uri: promptPacketUri,
    ...(fs.existsSync(getRunArtifactPath(runId, promptTextName)) ? { prompt_text_uri: runArtifactUri(runId, promptTextName) } : {}),
    ...(fs.existsSync(getRunArtifactPath(runId, sectionWritePacketName)) ? { section_write_packet_uri: runArtifactUri(runId, sectionWritePacketName) } : {}),
    ...(fs.existsSync(getRunArtifactPath(runId, evidenceContextName)) ? { evidence_context_uri: runArtifactUri(runId, evidenceContextName) } : {}),
  };

  const payload: SectionCandidatesPacketArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    section_index: sectionIndex,
    quality_level: qualityPolicy.quality_level,
    n_candidates_requested: requested,
    variation_strategy: variationStrategy,
    temperatures,
    seeds,
    prompt_packet: { uri: promptPacketUri, sha256: promptPacketSha256 ?? null },
    prompt_text_uri: promptTextUri,
    inputs,
    next_actions: nextActions,
  };

  const parsedPayload = SectionCandidatesPacketArtifactV1Schema.parse(payload);
  const packetRef = writeRunJsonArtifact(runId, outName, parsedPayload);

  return {
    run_id: runId,
    project_id: run.project_id,
    manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
    artifacts: [...baseArtifacts, qualityPolicyRef, packetRef],
    summary: {
      section_index: sectionIndex,
      quality_level: qualityPolicy.quality_level,
      n_candidates_requested: requested,
      prompt_packet_uri: promptPacketUri,
      prompt_packet_sha256: promptPacketSha256,
      candidates_packet_uri: packetRef.uri,
      candidates_packet_artifact: outName,
      prompt_text_uri: promptTextUri,
    },
    next_actions: nextActions,
  };
}

export async function submitRunWritingSectionCandidatesV1(params: {
  run_id: string;
  section_index: number;
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
  const sectionIndex = params.section_index;
  if (!Number.isFinite(sectionIndex) || sectionIndex < 1 || Math.trunc(sectionIndex) !== sectionIndex) {
    throw invalidParams('section_index must be a positive integer', { section_index: params.section_index });
  }

  const { policy: qualityPolicy, artifact: qualityPolicyRef } = ensureWritingQualityPolicyV1({ run_id: runId });
  const requiredN = requiredCandidatesForQualityLevel(qualityPolicy.quality_level);

  const packetName = `writing_section_candidates_packet_section_${pad3(sectionIndex)}_v1.json`;
  const packetRaw = readRunJsonArtifactOrThrow<unknown>(runId, packetName);
  const packetParsed = SectionCandidatesPacketArtifactV1Schema.safeParse(packetRaw);
  if (!packetParsed.success) {
    const ref = writeRunJsonArtifact(runId, `writing_parse_error_artifact_${packetName}.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      artifact_name: packetName,
      issues: packetParsed.error.issues,
    });
    throw invalidParams('Section candidates packet artifact does not match schema (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      artifact_name: packetName,
      parse_error_uri: ref.uri,
      parse_error_artifact: ref.name,
      next_actions: [
        {
          tool: HEP_RUN_WRITING_CREATE_SECTION_CANDIDATES_PACKET_V1,
          args: { run_id: runId, section_index: sectionIndex },
          reason: 'Recreate the section candidates packet artifact before submitting candidates.',
        },
      ],
    });
  }

  const packet = packetParsed.data;

  const submitted = params.candidates ?? [];
  if (submitted.length < requiredN) {
    throw invalidParams('Insufficient candidates for quality_level (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      quality_level: qualityPolicy.quality_level,
      candidates_submitted: submitted.length,
      required_min: requiredN,
      next_actions: packet.next_actions,
    });
  }

  if (submitted.length !== packet.n_candidates_requested) {
    throw invalidParams('Candidates count does not match n_candidates_requested (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
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
        section_index: sectionIndex,
        candidate_index: c.candidate_index,
      });
    }
    if (!expectedIndices.has(c.candidate_index)) {
      throw invalidParams('candidate_index out of expected range (fail-fast)', {
        run_id: runId,
        section_index: sectionIndex,
        candidate_index: c.candidate_index,
        expected_range: `0..${packet.n_candidates_requested - 1}`,
      });
    }
    if (seenIndices.has(c.candidate_index)) {
      throw invalidParams('Duplicate candidate_index is not allowed (fail-fast)', {
        run_id: runId,
        section_index: sectionIndex,
        candidate_index: c.candidate_index,
      });
    }
    seenIndices.add(c.candidate_index);
  }

  const failures: Array<{ candidate_index: number; section_output_uri: string; issues: unknown }> = [];
  const parsedOutputs = new Map<number, Record<string, unknown>>();
  const candidateResponseRefs: RunArtifactRef[] = [];

  for (const c of submitted) {
    const rawData = await readStagedContent(runId, c.section_output_uri, 'section_output');
    const parsed = SectionOutputSubmissionSchema.safeParse(rawData);
    if (!parsed.success) {
      failures.push({ candidate_index: c.candidate_index, section_output_uri: c.section_output_uri, issues: parsed.error.issues });
      continue;
    }
    parsedOutputs.set(c.candidate_index, parsed.data as Record<string, unknown>);
  }

  if (failures.length > 0) {
    const ref = writeRunJsonArtifact(runId, `writing_parse_error_candidates_section_${pad3(sectionIndex)}_v1.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      section_index: sectionIndex,
      prompt_packet_uri: packet.prompt_packet.uri,
      prompt_packet_sha256: packet.prompt_packet.sha256,
      failures,
      received: submitted,
    });
    throw invalidParams('One or more candidates failed SectionOutputSubmissionSchema validation (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      parse_error_uri: ref.uri,
      parse_error_artifact: ref.name,
      next_actions: packet.next_actions,
    });
  }

  for (const c of submitted) {
    const parsed = parsedOutputs.get(c.candidate_index);
    if (!parsed) {
      throw new Error(`Internal: missing parsed candidate_index=${c.candidate_index}`);
    }
    const responseRef = writeClientLlmResponseArtifact({
      run_id: runId,
      artifact_name: `writing_client_llm_response_section_candidate_section_${pad3(sectionIndex)}_${pad2(c.candidate_index)}_v1.json`,
      step: 'writing_sections',
      prompt_packet_uri: packet.prompt_packet.uri,
      prompt_packet_sha256: packet.prompt_packet.sha256 ?? undefined,
      client_raw_output_uri: c.section_output_uri,
      parsed,
      client_model: c.client_model ?? null,
      temperature: c.temperature ?? null,
      seed: c.seed ?? 'unknown',
    });
    candidateResponseRefs.push(responseRef);
  }

  const candidatesMeta = submitted
    .map(c => {
      const outputSha = computeUriSha256OrThrow({ run_id: runId, uri: c.section_output_uri });
      const responseRef = candidateResponseRefs.find(r => r.name.endsWith(`_${pad2(c.candidate_index)}_v1.json`)) ?? null;
      return {
        candidate_index: c.candidate_index,
        output_uri: c.section_output_uri,
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
    candidate_type: 'section_draft',
    n_candidates: candidatesMeta.length,
    candidate_scope: { section_index: sectionIndex },
    inputs: {
      quality_policy_uri: qualityPolicyRef.uri,
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
      section_index: sectionIndex,
      quality_level: qualityPolicy.quality_level,
      n_candidates_requested: packet.n_candidates_requested,
      variation_strategy: packet.variation_strategy,
      temperatures: packet.temperatures,
      seeds: packet.seeds,
    },
  });

  const outName = `writing_candidates_section_${pad3(sectionIndex)}_v1.json`;
  const candidateSetRef = writeRunJsonArtifact(runId, outName, candidateSetPayload);

  const nextActions: Array<{ tool: string; args: Record<string, unknown>; reason: string }> = [
    {
      tool: HEP_RUN_WRITING_CREATE_SECTION_JUDGE_PACKET_V1,
      args: { run_id: runId, section_index: sectionIndex, candidates_uri: candidateSetRef.uri },
      reason: 'Create the Judge prompt_packet for selecting the best section candidate (N-best → Judge → verifiers).',
    },
  ];

  return {
    run_id: runId,
    project_id: run.project_id,
    manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
    artifacts: [qualityPolicyRef, ...candidateResponseRefs, candidateSetRef],
    summary: {
      section_index: sectionIndex,
      candidates_uri: candidateSetRef.uri,
      candidates_artifact: outName,
      n_candidates: candidatesMeta.length,
      quality_level: qualityPolicy.quality_level,
    },
    next_actions: nextActions,
  };
}
