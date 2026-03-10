import { z } from 'zod';

export const GroupingProvenanceModeSchema = z.enum([
  'open_cluster',
  'heuristic_fallback',
  'uncertain',
]);

export const GroupingProvenanceSchema = z.object({
  mode: GroupingProvenanceModeSchema,
  used_fallback: z.boolean(),
  reason_code: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1)),
  canonical_hint: z.string().min(1).optional(),
});

export const GroupingAssignmentDetailSchema = z.object({
  label: z.string().min(1),
  provenance: GroupingProvenanceSchema,
});

export const SemanticClusterSchema = z.object({
  label: z.string().min(1),
  keywords: z.array(z.string().min(1)),
  paper_ids: z.array(z.string().min(1)),
  representative_papers: z.array(z.string().min(1)),
  provenance: GroupingProvenanceSchema,
});

export const CollectionSemanticGroupingSchema = z.object({
  topic_groups: z.array(SemanticClusterSchema),
  method_groups: z.array(SemanticClusterSchema),
  topic_assignments: z.record(z.string(), z.string()),
  method_assignments: z.record(z.string(), z.string()),
  topic_assignment_details: z.record(z.string(), GroupingAssignmentDetailSchema),
  method_assignment_details: z.record(
    z.string(),
    GroupingAssignmentDetailSchema,
  ),
  topic_fallback_rate: z.number().min(0).max(1),
  method_fallback_rate: z.number().min(0).max(1),
});

export type GroupingProvenanceMode = z.infer<typeof GroupingProvenanceModeSchema>;
export type GroupingProvenance = z.infer<typeof GroupingProvenanceSchema>;
export type GroupingAssignmentDetail = z.infer<
  typeof GroupingAssignmentDetailSchema
>;
export type SemanticCluster = z.infer<typeof SemanticClusterSchema>;
export type CollectionSemanticGrouping = z.infer<
  typeof CollectionSemanticGroupingSchema
>;
