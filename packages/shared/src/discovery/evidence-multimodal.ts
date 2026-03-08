import { z } from 'zod';

import { EvidenceLocalizationUnitSchema } from './evidence-localization.js';

export const EvidenceMultimodalStatusSchema = z.enum([
  'applied',
  'skipped',
  'unsupported',
  'disabled',
  'abstained',
]);

export const EvidenceMultimodalReasonCodeSchema = z.enum([
  'policy_disabled',
  'query_not_page_native',
  'semantic_fallback_active',
  'pdf_visual_surface_missing',
  'visual_artifacts_missing',
  'requested_visual_label_missing',
  'visual_signal_insufficient',
  'visual_candidates_ambiguous',
  'visual_signal_applied',
]);

export const EvidenceMultimodalTelemetrySchema = z.object({
  fusion_passes: z.number().int().nonnegative(),
  visual_candidates_scanned: z.number().int().nonnegative(),
  supplemented_candidates: z.number().int().nonnegative(),
  boosted_hits: z.number().int().nonnegative(),
  latency_ms: z.number().int().nonnegative(),
});

export const EvidenceMultimodalArtifactSchema = z.object({
  version: z.literal(1),
  status: EvidenceMultimodalStatusSchema,
  requested_unit: EvidenceLocalizationUnitSchema.optional(),
  reason_codes: z.array(EvidenceMultimodalReasonCodeSchema).default([]),
  promoted_evidence_ids: z.array(z.string().min(1)).default([]),
  telemetry: EvidenceMultimodalTelemetrySchema,
});

export type EvidenceMultimodalStatus = z.infer<typeof EvidenceMultimodalStatusSchema>;
export type EvidenceMultimodalReasonCode = z.infer<typeof EvidenceMultimodalReasonCodeSchema>;
export type EvidenceMultimodalTelemetry = z.infer<typeof EvidenceMultimodalTelemetrySchema>;
export type EvidenceMultimodalArtifact = z.infer<typeof EvidenceMultimodalArtifactSchema>;
