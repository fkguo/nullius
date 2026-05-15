import { z } from 'zod';
import {
  DiscoveryCapabilityNameSchema,
  WorkflowTaskKindSchema,
} from '@autoresearch/shared';

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

const AnalysisWorkflowCapabilityIdSchema = z.enum([
  'analysis.topic_evolution',
  'analysis.citation_network',
  'analysis.paper_set_connections',
  'analysis.provenance_trace',
  'analysis.paper_set_critical_review',
]);

export const WorkflowCapabilityIdSchema = z.union([
  DiscoveryCapabilityNameSchema,
  AnalysisWorkflowCapabilityIdSchema,
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

export const SearchDepthContractSchema = z.object({
  mode: z.literal('deep'),
  default_page_size: z.literal(50),
  default_page_size_semantics: z.literal('page_size_not_completion_threshold'),
  pagination_required: z.literal(true),
  cursor_or_page_tracking_required: z.literal(true),
  continuation_required: z.literal(true),
  returned_count_required: z.literal(true),
  stop_reason_required: z.literal(true),
  coverage_incomplete_status: z.literal('coverage_incomplete'),
  candidate_pool_artifact: z.string().min(1),
  selection_rationale_required: z.literal(true),
  query_expansion_expected: z.literal(true),
  citation_expansion_expected: z.literal(true),
}).strict();

export const LiteratureSaturationContractSchema = z.object({
  artifact: z.string().min(1),
  final_status_values: z.tuple([
    z.literal('saturated'),
    z.literal('coverage_incomplete'),
  ]),
  saturated_required_for_completion: z.literal(true),
  coverage_incomplete_allowed_only_as_debt: z.literal(true),
  provider_coverage_required: z.literal(true),
  providers_expected: z.array(z.enum([
    'inspire',
    'arxiv',
    'openalex',
    'web',
  ])).min(4),
  candidate_pool_required: z.literal(true),
  core_paper_references_required: z.literal(true),
  core_paper_citations_required: z.literal(true),
  metadata_only_not_evidence_ready: z.literal(true),
  page_size_not_completion_threshold: z.literal(true),
}).strict();

export const ReadingHandoffContractSchema = z.object({
  mode: z.literal('source_first'),
  source_preference: z.array(z.enum([
    'arxiv_latex_source',
    'full_text_pdf',
    'available_full_text',
    'metadata_only_not_evidence_ready',
  ])).min(4),
  note_upgrade_required: z.literal(true),
  expected_artifact: z.string().min(1),
  locators_required: z.literal(true),
  key_equations_required: z.literal(true),
  limitations_required: z.literal(true),
}).strict();

export const WorkflowRecipeStepSchema = z.object({
  id: z.string().min(1),
  task_kind: WorkflowTaskKindSchema,
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
    search_depth_contract: SearchDepthContractSchema.optional(),
    literature_saturation_contract: LiteratureSaturationContractSchema.optional(),
    reading_handoff_contract: ReadingHandoffContractSchema.optional(),
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
  task_kind: WorkflowTaskKindSchema,
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
export type WorkflowTaskKind = z.infer<typeof WorkflowTaskKindSchema>;
export type WorkflowRecipe = z.infer<typeof WorkflowRecipeSchema>;
export type WorkflowRecipeStep = z.infer<typeof WorkflowRecipeStepSchema>;
export type ResolveWorkflowRequest = z.infer<typeof ResolveWorkflowRequestSchema>;
export type ResolvedWorkflowPlan = z.infer<typeof ResolvedWorkflowPlanSchema>;
export type ResolvedWorkflowStep = z.infer<typeof ResolvedWorkflowStepSchema>;
