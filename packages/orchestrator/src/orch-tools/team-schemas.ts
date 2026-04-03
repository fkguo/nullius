import { z } from 'zod';

const TaskKindSchema = z.enum(['literature', 'idea', 'compute', 'evidence_search', 'finding', 'draft_update', 'review']);
const HandoffKindSchema = z.enum(['compute', 'feedback', 'literature', 'review', 'writing']);
const TeamScopeSchema = z.enum(['task', 'team', 'project']);
const TeamKindSchema = z.enum(['pause', 'resume', 'redirect', 'inject_task', 'approve', 'cancel', 'cascade_stop']);

const TeamExecutionPermissionEntrySchema = z.object({
  from_role: z.string().min(1),
  to_role: z.string().min(1),
  allowed_task_kinds: z.array(TaskKindSchema).min(1),
  allowed_handoff_kinds: z.array(HandoffKindSchema).min(1),
  allowed_tool_names: z.array(z.string().min(1)).optional(),
});

const TeamInterventionPermissionSchema = z.object({
  actor_role: z.string().min(1),
  allowed_scopes: z.array(TeamScopeSchema).min(1),
  allowed_kinds: z.array(TeamKindSchema).min(1),
});

const BaseInterventionSchema = z.object({
  actor_role: z.string().min(1),
  actor_id: z.string().optional().nullable(),
  target_assignment_id: z.string().optional().nullable(),
  task_id: z.string().optional().nullable(),
  checkpoint_id: z.string().optional().nullable(),
  note: z.string().optional(),
});

const RedirectInterventionSchema = BaseInterventionSchema.extend({
  kind: z.literal('redirect'),
  scope: z.literal('task'),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const ApproveInterventionSchema = BaseInterventionSchema.extend({
  kind: z.literal('approve'),
  scope: z.literal('task'),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const InjectTaskPayloadSchema = z.object({
  stage: z.number().int().nonnegative().optional(),
  owner_role: z.string().min(1).optional(),
  delegate_role: z.string().min(1),
  delegate_id: z.string().min(1),
  task_id: z.string().min(1),
  task_kind: TaskKindSchema,
  handoff_id: z.string().optional().nullable(),
  handoff_kind: HandoffKindSchema.optional().nullable(),
  checkpoint_id: z.string().optional().nullable(),
  timeout_at: z.string().datetime().optional().nullable(),
});

const InjectTaskInterventionSchema = BaseInterventionSchema.extend({
  kind: z.literal('inject_task'),
  scope: z.literal('task'),
  payload: InjectTaskPayloadSchema,
});

const GenericInterventionSchema = BaseInterventionSchema.extend({
  kind: z.enum(['pause', 'resume', 'cancel', 'cascade_stop']),
  scope: z.enum(['task', 'team']),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const TeamInterventionCommandSchema = z.union([
  GenericInterventionSchema,
  RedirectInterventionSchema,
  InjectTaskInterventionSchema,
  ApproveInterventionSchema,
]);

const TeamAssignmentConfigSchema = z.object({
  stage: z.number().int().nonnegative().optional(),
  task_id: z.string().min(1),
  task_kind: TaskKindSchema.optional(),
  owner_role: z.string().min(1).optional(),
  delegate_role: z.string().min(1).optional(),
  delegate_id: z.string().min(1).optional(),
  handoff_id: z.string().optional().nullable(),
  handoff_kind: HandoffKindSchema.optional().nullable(),
  checkpoint_id: z.string().optional().nullable(),
  timeout_at: z.string().datetime().optional().nullable(),
});

export const TeamExecutionConfigSchema = z.object({
  workspace_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  task_kind: TaskKindSchema.optional(),
  owner_role: z.string().min(1).optional(),
  delegate_role: z.string().min(1).optional(),
  delegate_id: z.string().min(1).optional(),
  coordination_policy: z.enum(['sequential', 'parallel', 'stage_gated', 'supervised_delegate']).optional(),
  handoff_id: z.string().optional().nullable(),
  handoff_kind: HandoffKindSchema.optional().nullable(),
  checkpoint_id: z.string().optional().nullable(),
  timeout_at: z.string().datetime().optional().nullable(),
  assignments: z.array(TeamAssignmentConfigSchema).min(1).optional(),
  permissions: z.object({
    delegation: z.array(TeamExecutionPermissionEntrySchema).min(1),
    interventions: z.array(TeamInterventionPermissionSchema).min(1),
  }).optional(),
  interventions: z.array(TeamInterventionCommandSchema).optional(),
});
