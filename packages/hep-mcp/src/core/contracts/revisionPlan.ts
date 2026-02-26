import { z } from 'zod';

import { FollowUpEvidenceQuerySchema } from './reviewerReport.js';

export const RevisionActionTypeSchema = z.enum([
  'rewrite_section',
  'add_evidence',
  'fix_assets',
]);
export type RevisionActionType = z.output<typeof RevisionActionTypeSchema>;

export const RevisionExpectedVerificationSchema = z.enum([
  'citations',
  'originality',
  'assets',
  'cross_references',
  'structure',
  'latex_compile',
  'quality_eval',
  'token_gate',
]);
export type RevisionExpectedVerification = z.output<typeof RevisionExpectedVerificationSchema>;

export const RevisionActionV1Schema = z
  .object({
    type: RevisionActionTypeSchema,
    target_section_index: z.number().int().positive().optional(),
    target_section_number: z.string().min(1).optional(),
    inputs: z.array(z.string().min(1)).min(1),
    evidence_queries: z.array(FollowUpEvidenceQuerySchema).optional(),
    rewrite_instructions: z.string().min(1).optional(),
    expected_verifications: z.array(RevisionExpectedVerificationSchema).min(1),
  })
  .strict()
  .superRefine((v, ctx) => {
    const needsTarget = v.type === 'rewrite_section' || v.type === 'add_evidence' || v.type === 'fix_assets';
    if (needsTarget && !v.target_section_index && !v.target_section_number) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `target_section_index or target_section_number is required for action.type=${v.type}`,
        path: ['target_section_index'],
      });
    }
    if (v.type === 'rewrite_section' && !v.rewrite_instructions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'rewrite_instructions is required for action.type=rewrite_section',
        path: ['rewrite_instructions'],
      });
    }
  });

export type RevisionActionV1 = z.output<typeof RevisionActionV1Schema>;

export const RevisionPlanV1Schema = z
  .object({
    version: z.literal(1),
    round: z.number().int().min(1),
    max_rounds: z.number().int().min(1),
    actions: z.array(RevisionActionV1Schema),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.round > v.max_rounds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'round must be <= max_rounds',
        path: ['round'],
      });
    }
  });

export type RevisionPlanV1 = z.output<typeof RevisionPlanV1Schema>;
