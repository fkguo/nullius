import * as fs from 'fs';
import { z } from 'zod';
import { invalidParams } from '@autoresearch/shared';

import { getRun, type RunArtifactRef } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';

export const WritingQualityLevelSchema = z.enum(['standard', 'publication']);
export type WritingQualityLevel = z.output<typeof WritingQualityLevelSchema>;

export const WritingQualityPolicyV1Schema = z
  .object({
    version: z.literal(1),
    generated_at: z.string().min(1),
    run_id: z.string().min(1),
    project_id: z.string().min(1),
    quality_level: WritingQualityLevelSchema,
    deterministic_gates: z
      .object({
        min_paragraphs: z.number().int().min(1),
        max_single_sentence_paragraphs: z.number().int().min(0),
        require_no_unclosed_environments: z.boolean(),
      })
      .strict(),
    llm_evaluator_gate: z
      .object({
        required: z.boolean(),
        min_overall_score: z.number().min(0).max(1),
        min_structure_score: z.number().min(0).max(1),
        min_groundedness_score: z.number().min(0).max(1),
        min_relevance_score: z.number().min(0).max(1),
      })
      .strict(),
    latex_compile_gate: z
      .object({
        required: z.boolean(),
        passes: z.number().int().min(1),
        run_bibtex: z.boolean(),
        timeout_ms: z.number().int().min(1_000),
      })
      .strict(),
  })
  .strict();

export type WritingQualityPolicyV1 = z.output<typeof WritingQualityPolicyV1Schema>;

function nowIso(): string {
  return new Date().toISOString();
}

function getDefaultPolicy(level: WritingQualityLevel): Omit<WritingQualityPolicyV1, 'generated_at' | 'run_id' | 'project_id'> {
  if (level === 'publication') {
    return {
      version: 1,
      quality_level: 'publication',
      deterministic_gates: {
        min_paragraphs: 5,
        max_single_sentence_paragraphs: 0,
        require_no_unclosed_environments: true,
      },
      llm_evaluator_gate: {
        required: true,
        min_overall_score: 0.75,
        min_structure_score: 0.7,
        min_groundedness_score: 0.75,
        min_relevance_score: 0.7,
      },
      latex_compile_gate: {
        required: true,
        passes: 3,
        run_bibtex: true,
        timeout_ms: 120_000,
      },
    };
  }

  return {
    version: 1,
    quality_level: 'standard',
    deterministic_gates: {
      min_paragraphs: 3,
      max_single_sentence_paragraphs: 1,
      require_no_unclosed_environments: true,
    },
    llm_evaluator_gate: {
      required: true,
      min_overall_score: 0.65,
      min_structure_score: 0.6,
      min_groundedness_score: 0.65,
      min_relevance_score: 0.6,
    },
    latex_compile_gate: {
      required: true,
      passes: 3,
      run_bibtex: true,
      timeout_ms: 120_000,
    },
  };
}

export function readWritingQualityPolicyV1OrNull(params: { run_id: string; artifact_name?: string }): WritingQualityPolicyV1 | null {
  const runId = params.run_id;
  const name = params.artifact_name?.trim() ? params.artifact_name.trim() : 'writing_quality_policy_v1.json';
  const p = getRunArtifactPath(runId, name);
  if (!fs.existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
  } catch (err) {
    throw invalidParams('Malformed JSON in writing_quality_policy_v1.json (fail-fast)', {
      run_id: runId,
      artifact_name: name,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const parsed = WritingQualityPolicyV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw invalidParams('writing_quality_policy_v1.json does not match schema (fail-fast)', {
      run_id: runId,
      artifact_name: name,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export function ensureWritingQualityPolicyV1(params: {
  run_id: string;
  quality_level?: WritingQualityLevel;
  output_artifact_name?: string;
}): { policy: WritingQualityPolicyV1; artifact: RunArtifactRef } {
  const runId = params.run_id;
  const existing = readWritingQualityPolicyV1OrNull({ run_id: runId, artifact_name: params.output_artifact_name });
  if (existing) {
    return {
      policy: existing,
      artifact: {
        name: params.output_artifact_name?.trim() ? params.output_artifact_name.trim() : 'writing_quality_policy_v1.json',
        uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(params.output_artifact_name?.trim() ? params.output_artifact_name.trim() : 'writing_quality_policy_v1.json')}`,
        mimeType: 'application/json',
      },
    };
  }

  const run = getRun(runId);
  const level = params.quality_level ?? 'standard';
  const base = getDefaultPolicy(level);

  const payload: WritingQualityPolicyV1 = WritingQualityPolicyV1Schema.parse({
    ...base,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
  });

  const outName = params.output_artifact_name?.trim() ? params.output_artifact_name.trim() : 'writing_quality_policy_v1.json';
  const ref = writeRunJsonArtifact(runId, outName, payload);
  return { policy: payload, artifact: ref };
}
