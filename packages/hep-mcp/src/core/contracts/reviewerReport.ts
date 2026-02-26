import { z } from 'zod';

export const ReviewerSeveritySchema = z.enum(['none', 'minor', 'major']);
export type ReviewerSeverity = z.output<typeof ReviewerSeveritySchema>;

export const ReviewerIterationEntrySchema = z.enum(['outline', 'sections']);
export type ReviewerIterationEntry = z.output<typeof ReviewerIterationEntrySchema>;

export const ReviewerIssueSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1),
    suggested_fix: z.string().min(1),
    affected_sections: z.array(z.string().min(1)).optional().default([]),
  })
  .strict();

export const NotationChangeSchema = z
  .object({
    symbol: z.string().min(1),
    reason: z.string().min(1),
    from: z.string().optional(),
    to: z.string().optional(),
    must_highlight_in_text: z.boolean().optional().default(true),
    note_to_insert: z.string().min(1),
  })
  .strict();

export const AssetPointerIssueSchema = z
  .object({
    asset: z.string().min(1),
    problem: z.string().min(1),
    fix: z.string().optional(),
  })
  .strict();

export const FollowUpEvidenceQuerySchema = z
  .object({
    section_number: z.string().min(1),
    query: z.string().min(1),
    purpose: z.string().min(1),
    expected_evidence_kinds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const StructureIssueSchema = z
  .object({
    type: z.enum(['overlap', 'missing_prereq', 'bad_order', 'weak_transition']),
    affected_sections: z.array(z.string().min(1)).min(1),
    suggestion: z.string().min(1),
  })
  .strict();

export const GroundingRiskSchema = z
  .object({
    section_number: z.string().min(1),
    claim_like_text: z.string().min(1),
    why_risky: z.string().min(1),
    suggested_fix: z.string().min(1),
  })
  .strict();

export const ReviewerReportV2Schema = z
  .object({
    version: z.literal(2),
    severity: ReviewerSeveritySchema,
    summary: z.string().min(1),
    iteration_entry: ReviewerIterationEntrySchema.optional(),
    major_issues: z.array(ReviewerIssueSchema),
    minor_issues: z.array(ReviewerIssueSchema),
    notation_changes: z.array(NotationChangeSchema),
    asset_pointer_issues: z.array(AssetPointerIssueSchema),
    follow_up_evidence_queries: z.array(FollowUpEvidenceQuerySchema),
    structure_issues: z.array(StructureIssueSchema),
    grounding_risks: z.array(GroundingRiskSchema),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.severity === 'major' && !v.iteration_entry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "iteration_entry is required when severity='major'",
        path: ['iteration_entry'],
      });
    }
  });

export type ReviewerReportV2 = z.output<typeof ReviewerReportV2Schema>;

