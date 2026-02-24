import { z } from 'zod';

export const WritingCandidateTypeV1Schema = z.enum(['section_draft', 'outline_plan_v2']);
export type WritingCandidateTypeV1 = z.output<typeof WritingCandidateTypeV1Schema>;

export const WritingCandidateMetaV1Schema = z
  .object({
    candidate_index: z.number().int().nonnegative(),
    output_uri: z.string().min(1),
    output_sha256: z.string().min(1).nullable(),
    client_model: z.string().min(1).nullable(),
    temperature: z.number().nullable(),
    seed: z.union([z.number(), z.string()]).nullable(),
    client_response_uri: z.string().min(1).nullable(),
  })
  .strict();

export type WritingCandidateMetaV1 = z.output<typeof WritingCandidateMetaV1Schema>;

export const WritingCandidateSetV1Schema = z
  .object({
    version: z.literal(1),
    generated_at: z.string().min(1),
    run_id: z.string().min(1),
    candidate_type: WritingCandidateTypeV1Schema,
    n_candidates: z.number().int().min(2),
    candidate_scope: z
      .object({
        section_index: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    inputs: z.record(z.string(), z.string().min(1)).optional().default({}),
    generation_config: z
      .object({
        mode_used: z.enum(['client', 'internal', 'passthrough']),
        client_model: z.string().min(1).nullable(),
        temperature: z.number().nullable(),
        seed: z.union([z.number(), z.string()]).nullable(),
        prompt_packet_uri: z.string().min(1).nullable(),
        prompt_packet_sha256: z.string().min(1).nullable(),
      })
      .strict(),
    candidates: z.array(WritingCandidateMetaV1Schema).min(2),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type WritingCandidateSetV1 = z.output<typeof WritingCandidateSetV1Schema>;

export const WritingJudgeDecisionV1Schema = z
  .object({
    version: z.literal(1),
    generated_at: z.string().min(1),
    run_id: z.string().min(1),
    candidate_type: WritingCandidateTypeV1Schema,
    candidates_uri: z.string().min(1),
    decision: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('select'),
          selected_candidate_index: z.number().int().nonnegative(),
        })
        .strict(),
      z
        .object({
          type: z.literal('all_fail'),
          reasons: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ]),
    scores_by_candidate: z
      .array(
        z
          .object({
            candidate_index: z.number().int().nonnegative(),
            structure: z.number().min(0).max(1),
            groundedness: z.number().min(0).max(1),
            citation_discipline: z.number().min(0).max(1),
            relevance: z.number().min(0).max(1),
            cohesion: z.number().min(0).max(1),
            overall: z.number().min(0).max(1),
          })
          .strict()
      )
      .min(2),
    reasoning: z.string().min(50),
    key_differences: z.array(z.string().min(10)).min(1),
    fix_recommendations: z.array(z.string().min(1)).optional().default([]),
  })
  .strict();

export type WritingJudgeDecisionV1 = z.output<typeof WritingJudgeDecisionV1Schema>;

