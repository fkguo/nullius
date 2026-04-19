import { z } from 'zod';

export const SemanticAssessmentBackendSchema = z.enum([
  'mcp_sampling',
  'metadata',
  'diagnostic',
]);

export const SemanticAssessmentStatusSchema = z.enum([
  'applied',
  'diagnostic',
  'abstained',
  'invalid',
  'unavailable',
]);

export const SemanticAssessmentProvenanceSchema = z.object({
  backend: SemanticAssessmentBackendSchema,
  status: SemanticAssessmentStatusSchema,
  reason_code: z.string().min(1),
  prompt_version: z.string().min(1).optional(),
  input_hash: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  signals: z.array(z.string().min(1)).optional(),
}).strict();

export type SemanticAssessmentBackend = z.infer<
  typeof SemanticAssessmentBackendSchema
>;
export type SemanticAssessmentStatus = z.infer<
  typeof SemanticAssessmentStatusSchema
>;
export type SemanticAssessmentProvenance = z.infer<
  typeof SemanticAssessmentProvenanceSchema
>;
