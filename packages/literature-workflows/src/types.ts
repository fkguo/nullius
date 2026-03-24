import { z } from 'zod';
import { DiscoveryCapabilityNameSchema } from '@autoresearch/shared';

export const WorkflowProviderIdSchema = z.enum([
  'inspire',
  'openalex',
  'arxiv',
  'zotero',
  'crossref',
  'datacite',
  'github',
  'doi',
]);

export const WorkflowCapabilityIdSchema = z.enum([
  ...DiscoveryCapabilityNameSchema.options,
  'analysis.topic_evolution',
  'analysis.citation_network',
  'analysis.paper_set_connections',
  'analysis.provenance_trace',
  'analysis.paper_set_critical_review',
]);

export const WorkflowActionIdSchema = z.enum([
  'discover.seed_search',
  'analyze.topic_evolution',
  'analyze.citation_network',
  'analyze.paper_connections',
  'analyze.provenance_trace',
  'analyze.paper_set_critical_review',
  'materialize.evidence_build',
]);

export const WorkflowDegradeModeSchema = z.enum([
  'fail_closed',
  'skip_with_reason',
  'partial_result',
]);

export const WorkflowRecipeStepSchema = z.object({
  id: z.string().min(1),
  tool: z.string().min(1).optional(),
  action: WorkflowActionIdSchema.optional(),
  purpose: z.string().min(1),
  depends_on: z.array(z.string().min(1)).optional().default([]),
  params: z.record(z.string(), z.unknown()).optional().default({}),
  required_capabilities: z.array(WorkflowCapabilityIdSchema).optional().default([]),
  preferred_providers: z.array(WorkflowProviderIdSchema).optional().default([]),
  degrade_mode: WorkflowDegradeModeSchema.optional(),
  consumer_hints: z.object({
    phases: z.array(z.string().min(1)).optional(),
    artifact: z.string().min(1).optional(),
    project_required: z.boolean().optional(),
    run_required: z.boolean().optional(),
  }).optional(),
}).superRefine((value, ctx) => {
  if (!value.tool && !value.action) {
    ctx.addIssue({
      code: 'custom',
      path: ['action'],
      message: 'each workflow step requires at least one of action or tool',
    });
  }
  if (value.action && !value.degrade_mode) {
    ctx.addIssue({
      code: 'custom',
      path: ['degrade_mode'],
      message: 'action-based workflow steps must declare degrade_mode',
    });
  }
});

export const WorkflowRecipeSchema = z.object({
  recipe_id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  entry_tool: z.string().min(1),
  steps: z.array(WorkflowRecipeStepSchema).min(1),
}).strict();

export const ResolveWorkflowRequestSchema = z.object({
  recipe_id: z.string().min(1),
  phase: z.string().min(1).optional(),
  inputs: z.record(z.string(), z.unknown()).optional().default({}),
  preferred_providers: z.array(WorkflowProviderIdSchema).optional().default([]),
  allowed_providers: z.array(WorkflowProviderIdSchema).optional(),
  available_tools: z.array(z.string().min(1)).optional(),
});

export const ResolvedWorkflowStepSchema = z.object({
  id: z.string().min(1),
  action: WorkflowActionIdSchema.optional(),
  tool: z.string().min(1),
  provider: WorkflowProviderIdSchema.optional(),
  purpose: z.string().min(1),
  depends_on: z.array(z.string().min(1)),
  params: z.record(z.string(), z.unknown()),
  required_capabilities: z.array(WorkflowCapabilityIdSchema),
  degrade_mode: WorkflowDegradeModeSchema.optional(),
  consumer_hints: WorkflowRecipeStepSchema.shape.consumer_hints,
});

export const ResolvedWorkflowPlanSchema = z.object({
  recipe_id: z.string().min(1),
  name: z.string().min(1),
  entry_tool: z.string().min(1),
  phase: z.string().min(1).optional(),
  resolved_steps: z.array(ResolvedWorkflowStepSchema),
});

export type WorkflowProviderId = z.infer<typeof WorkflowProviderIdSchema>;
export type WorkflowCapabilityId = z.infer<typeof WorkflowCapabilityIdSchema>;
export type WorkflowActionId = z.infer<typeof WorkflowActionIdSchema>;
export type WorkflowRecipe = z.infer<typeof WorkflowRecipeSchema>;
export type WorkflowRecipeStep = z.infer<typeof WorkflowRecipeStepSchema>;
export type ResolveWorkflowRequest = z.infer<typeof ResolveWorkflowRequestSchema>;
export type ResolvedWorkflowPlan = z.infer<typeof ResolvedWorkflowPlanSchema>;
export type ResolvedWorkflowStep = z.infer<typeof ResolvedWorkflowStepSchema>;
