import { z } from 'zod';

export const WorkflowTaskKindSchema = z.enum([
  'literature',
  'idea',
  'compute',
  'evidence_search',
  'finding',
  'draft_update',
  'review',
]);

export type WorkflowTaskKind = z.infer<typeof WorkflowTaskKindSchema>;

/**
 * Provider-neutral task authority persisted alongside a workflow step.
 *
 * This contract intentionally excludes execution-local fields such as tool,
 * provider, params, degrade_mode, and consumer_hints.
 */
export const WorkflowStepTaskProjectionSchema = z.object({
  task_id: z.string().min(1),
  task_kind: WorkflowTaskKindSchema,
  task_intent: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  depends_on_task_ids: z.array(z.string().min(1)),
  required_capabilities: z.array(z.string().min(1)),
  expected_artifacts: z.array(z.string().min(1)),
  preconditions: z.array(z.string().min(1)),
}).strict();

export type WorkflowStepTaskProjection = z.infer<typeof WorkflowStepTaskProjectionSchema>;
