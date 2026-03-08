import { z } from 'zod';

export const EvidenceLocalizationUnitSchema = z.enum([
  'page',
  'chunk',
  'table',
  'figure',
  'equation',
  'citation_context',
]);

export const EvidenceLocalizationStatusSchema = z.enum([
  'localized',
  'fallback_available',
  'unavailable',
  'abstained',
]);

export const EvidenceLocalizationSurfaceSchema = z.enum(['latex', 'pdf_page', 'pdf_region']);

export const EvidenceLocalizationCrossSurfaceStatusSchema = z.enum([
  'not_checked',
  'consistent',
  'latex_only',
  'pdf_only',
  'ambiguous',
  'unavailable',
]);

export const EvidenceLocalizationReasonCodeSchema = z.enum([
  'requested_unit_exact',
  'coarse_fallback',
  'implicit_unit',
  'pdf_primary_locator',
  'pdf_surface_unavailable',
  'pdf_support_missing',
  'pdf_support_ambiguous',
  'pdf_support_consistent',
  'requested_page',
  'requested_chunk',
  'requested_table',
  'requested_figure',
  'requested_equation',
  'requested_citation_context',
  'requested_unspecified',
  'exact_unit_ambiguous',
  'requested_unit_missing_from_indexed_surfaces',
  'coarse_fallback_returned',
  'localized_unit_unavailable',
]);

export const EvidenceLocalizationHitSchema = z.object({
  evidence_id: z.string().min(1),
  unit: EvidenceLocalizationUnitSchema,
  status: EvidenceLocalizationStatusSchema,
  reason_codes: z.array(EvidenceLocalizationReasonCodeSchema).default([]),
  source_surfaces: z.array(EvidenceLocalizationSurfaceSchema).default([]),
  cross_surface_status: EvidenceLocalizationCrossSurfaceStatusSchema.default('not_checked'),
  supporting_evidence_id: z.string().min(1).optional(),
});

export const EvidenceLocalizationTelemetrySchema = z.object({
  localization_passes: z.number().int().nonnegative(),
  structure_scans: z.number().int().nonnegative(),
  localized_hits: z.number().int().nonnegative(),
  fallback_hits: z.number().int().nonnegative(),
  unavailable_hits: z.number().int().nonnegative().describe('Per-hit unavailable count only; overall artifact availability is tracked separately.'),
  abstained_hits: z.number().int().nonnegative(),
});

export const EvidenceLocalizationArtifactSchema = z.object({
  version: z.literal(1),
  query: z.string().min(1),
  requested_unit: EvidenceLocalizationUnitSchema.optional(),
  availability: EvidenceLocalizationStatusSchema,
  reason_codes: z.array(EvidenceLocalizationReasonCodeSchema).default([]),
  telemetry: EvidenceLocalizationTelemetrySchema,
  hits: z.array(EvidenceLocalizationHitSchema),
});

export type EvidenceLocalizationUnit = z.infer<typeof EvidenceLocalizationUnitSchema>;
export type EvidenceLocalizationStatus = z.infer<typeof EvidenceLocalizationStatusSchema>;
export type EvidenceLocalizationSurface = z.infer<typeof EvidenceLocalizationSurfaceSchema>;
export type EvidenceLocalizationCrossSurfaceStatus = z.infer<typeof EvidenceLocalizationCrossSurfaceStatusSchema>;
export type EvidenceLocalizationReasonCode = z.infer<typeof EvidenceLocalizationReasonCodeSchema>;
export type EvidenceLocalizationHit = z.infer<typeof EvidenceLocalizationHitSchema>;
export type EvidenceLocalizationTelemetry = z.infer<typeof EvidenceLocalizationTelemetrySchema>;
export type EvidenceLocalizationArtifact = z.infer<typeof EvidenceLocalizationArtifactSchema>;
