import { z } from 'zod';
import { DiscoveryProviderResultCountsSchema } from './provider-result-counts.js';

export const DiscoveryRiskLevelSchema = z.enum(['low', 'medium', 'high']);
export const DiscoveryQppStatusSchema = z.enum(['applied', 'unavailable', 'invalid']);
export const DiscoveryTriggerDecisionSchema = z.enum(['triggered', 'not_triggered']);
export const DiscoveryReformulationStatusSchema = z.enum([
  'applied',
  'not_triggered',
  'abstained',
  'unavailable',
  'invalid',
  'budget_exhausted',
]);

export const DiscoveryQueryProbeSchema = z.object({
  structured_identifier_detected: z.boolean(),
  author_year_hint: z.boolean(),
  acronym_hint: z.boolean(),
  verbose_query: z.boolean(),
  low_anchor_density: z.boolean(),
  provider_result_counts: DiscoveryProviderResultCountsSchema,
  candidate_count: z.number().int().nonnegative(),
  canonical_paper_count: z.number().int().nonnegative(),
  exact_identifier_hit: z.boolean(),
  top_stage1_score: z.number().min(0).max(1).nullable(),
  top_title_overlap: z.number().min(0).max(1).nullable(),
  top_provider_source_count: z.number().int().nonnegative(),
  top_stage1_canonical_keys: z.array(z.string().min(1)).max(10),
});

export const DiscoveryQppAssessmentSchema = z.object({
  status: DiscoveryQppStatusSchema,
  difficulty: DiscoveryRiskLevelSchema,
  ambiguity: DiscoveryRiskLevelSchema,
  low_recall_risk: DiscoveryRiskLevelSchema,
  trigger_decision: DiscoveryTriggerDecisionSchema,
  reason_codes: z.array(z.string()).default([]),
});

export const DiscoveryReformulationTelemetrySchema = z.object({
  sampling_calls: z.number().int().nonnegative(),
  reformulation_count: z.number().int().nonnegative(),
  extra_provider_round_trips: z.number().int().nonnegative(),
});

export const DiscoveryQueryReformulationArtifactSchema = z.object({
  version: z.literal(1),
  original_query: z.string().min(1),
  effective_query: z.string().min(1),
  normalized_effective_query: z.string().min(1),
  qpp: DiscoveryQppAssessmentSchema,
  probe: DiscoveryQueryProbeSchema,
  reformulation: z.object({
    status: DiscoveryReformulationStatusSchema,
    reason: z.string().min(1),
    reformulated_query: z.string().min(1).optional(),
    reason_codes: z.array(z.string()).default([]),
  }),
  telemetry: DiscoveryReformulationTelemetrySchema,
});

export type DiscoveryRiskLevel = z.infer<typeof DiscoveryRiskLevelSchema>;
export type DiscoveryQppStatus = z.infer<typeof DiscoveryQppStatusSchema>;
export type DiscoveryTriggerDecision = z.infer<typeof DiscoveryTriggerDecisionSchema>;
export type DiscoveryReformulationStatus = z.infer<typeof DiscoveryReformulationStatusSchema>;
export type DiscoveryQueryProbe = z.infer<typeof DiscoveryQueryProbeSchema>;
export type DiscoveryQppAssessment = z.infer<typeof DiscoveryQppAssessmentSchema>;
export type DiscoveryReformulationTelemetry = z.infer<typeof DiscoveryReformulationTelemetrySchema>;
export type DiscoveryQueryReformulationArtifact = z.infer<typeof DiscoveryQueryReformulationArtifactSchema>;
