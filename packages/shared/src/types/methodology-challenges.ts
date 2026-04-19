import { z } from 'zod';

export const MethodologyChallengeModeSchema = z.enum([
  'open_text',
  'uncertain',
  'no_challenge',
]);

export const MethodologyChallengeExtractionStatusSchema = z.enum([
  'detected',
  'no_challenge_detected',
  'uncertain',
]);

export const MethodologyChallengeExtractionProvenanceSchema = z.object({
  mode: MethodologyChallengeModeSchema,
  used_fallback: z.boolean(),
  reason_code: z.string().min(1),
  evidence_count: z.number().int().nonnegative(),
});

export const ExtractedMethodologyChallengeSchema = z.object({
  type: z.string().min(1).optional(),
  summary: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1)),
  provenance: MethodologyChallengeExtractionProvenanceSchema.pick({
    mode: true,
    used_fallback: true,
    reason_code: true,
  }),
});

export const MethodologyChallengeExtractionResultSchema = z.object({
  status: MethodologyChallengeExtractionStatusSchema,
  challenge_types: z.array(z.string().min(1)),
  challenges: z.array(ExtractedMethodologyChallengeSchema),
  provenance: MethodologyChallengeExtractionProvenanceSchema,
});

export type MethodologyChallengeMode = z.infer<
  typeof MethodologyChallengeModeSchema
>;
export type MethodologyChallengeExtractionStatus = z.infer<
  typeof MethodologyChallengeExtractionStatusSchema
>;
export type MethodologyChallengeExtractionProvenance = z.infer<
  typeof MethodologyChallengeExtractionProvenanceSchema
>;
export type ExtractedMethodologyChallenge = z.infer<
  typeof ExtractedMethodologyChallengeSchema
>;
export type MethodologyChallengeExtractionResult = z.infer<
  typeof MethodologyChallengeExtractionResultSchema
>;
