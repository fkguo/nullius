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

export const WorkflowTaskPreconditionSchema = z.enum([
  'project_required',
  'run_required',
]);

export type WorkflowTaskPrecondition = z.infer<typeof WorkflowTaskPreconditionSchema>;

export const WorkflowTaskArtifactRefSchema = z.string().min(1);

export type WorkflowTaskArtifactRef = z.infer<typeof WorkflowTaskArtifactRefSchema>;

export const WorkflowTaskProjectionInputSchema = z.object({
  task_id: z.string().min(1),
  task_kind: WorkflowTaskKindSchema,
  action: z.string().min(1).optional(),
  task_intent: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  description: z.string().min(1),
  depends_on_task_ids: z.array(z.string().min(1)).optional().default([]),
  required_capabilities: z.array(z.string().min(1)).optional().default([]),
  expected_artifacts: z.array(WorkflowTaskArtifactRefSchema).optional().default([]),
  preconditions: z.array(WorkflowTaskPreconditionSchema).optional().default([]),
}).strict();

export type WorkflowTaskProjectionInput = z.infer<typeof WorkflowTaskProjectionInputSchema>;

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
  expected_artifacts: z.array(WorkflowTaskArtifactRefSchema),
  preconditions: z.array(WorkflowTaskPreconditionSchema),
}).strict();

export type WorkflowStepTaskProjection = z.infer<typeof WorkflowStepTaskProjectionSchema>;

function normalizeStringList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function humanizeTaskId(taskId: string): string {
  const title = taskId
    .split(/[_.-]+/)
    .filter(Boolean)
    .map(token => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
  return title || taskId;
}

export function deriveWorkflowTaskIntent(input: WorkflowTaskProjectionInput): string {
  const explicit = input.task_intent?.trim();
  if (explicit) return explicit;

  const action = input.action?.trim();
  if (action) return action;

  return `workflow_step.${input.task_id}`;
}

export function buildWorkflowStepTaskProjection(
  input: WorkflowTaskProjectionInput,
): WorkflowStepTaskProjection {
  const parsed = WorkflowTaskProjectionInputSchema.parse(input);

  return WorkflowStepTaskProjectionSchema.parse({
    task_id: parsed.task_id,
    task_kind: parsed.task_kind,
    task_intent: deriveWorkflowTaskIntent(parsed),
    title: parsed.title?.trim() || humanizeTaskId(parsed.task_id),
    description: parsed.description.trim(),
    depends_on_task_ids: normalizeStringList(parsed.depends_on_task_ids),
    required_capabilities: normalizeStringList(parsed.required_capabilities),
    expected_artifacts: normalizeStringList(parsed.expected_artifacts),
    preconditions: [...new Set(parsed.preconditions)],
  });
}
