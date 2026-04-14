import { z } from 'zod';
import { type StagedContentType } from '@autoresearch/shared';
import { type ApprovalGateFilter } from './common.js';
import { APPROVAL_GATE_FILTER_VALUES, isApprovalGateFilter } from './common.js';
import { TeamExecutionConfigSchema } from './team-schemas.js';

const ProjectRootSchema = z
  .string()
  .min(1)
  .describe('Absolute (or tilde-prefixed) path to the autoresearch project root directory (contains .autoresearch/)');
const RunDirSchema = z
  .string()
  .min(1)
  .describe('Absolute path to the domain-owned run directory whose artifacts should be staged or executed.');
const RunIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_\-]+$/, 'run_id must be alphanumeric + _ -');
const HandoffPathSchema = z
  .string()
  .min(1)
  .describe('Absolute local filesystem path to an IdeaHandoffC2 JSON artifact.');
const HandoffUriSchema = z
  .string()
  .min(1)
  .describe('Optional provenance URI preserved into staged artifacts. Defaults to handoff_path when omitted.');
const SafePathSegmentSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(s => !s.includes('/') && !s.includes('\\'), {
    message: 'must not include path separators',
  })
  .refine(s => s !== '.' && s !== '..' && !s.includes('..'), {
    message: 'contains unsafe segment',
  });
const StagedContentTypeSchema = z.custom<StagedContentType>(
  (value): value is StagedContentType =>
    value === 'section_output'
    || value === 'outline_plan'
    || value === 'paperset_curation'
    || value === 'revision_plan'
    || value === 'reviewer_report'
    || value === 'judge_decision',
  {
    message: 'content_type must be a supported staged content type',
  },
);
const AgentTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
const AgentToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});
const AgentToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  content: z.string(),
});
const AgentMessageContentSchema = z.union([
  AgentTextBlockSchema,
  AgentToolUseBlockSchema,
  AgentToolResultBlockSchema,
]);
const AgentMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(AgentMessageContentSchema).min(1)]),
});
const AgentToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()),
});
const VisibleRunStatusFilterSchema = z
  .enum(['idle', 'running', 'awaiting_approval', 'paused', 'completed', 'failed', 'all'])
  .optional()
  .default('all');
const QueueOwnerSchema = z.string().min(1).max(128);
const QueueItemIdSchema = z.string().min(1);
const QueueDispositionSchema = z.enum(['requeue', 'completed', 'failed', 'cancelled']);
const LeaseDurationSchema = z.number().int().positive();
const WorkerIdSchema = z.string().min(1).max(128);
const WorkerSlotSchema = z.number().int().positive();
const HeartbeatTimeoutSchema = z.number().int().positive();
const ApprovalGateFilterSchema = z.custom<ApprovalGateFilter>(
  (value): value is ApprovalGateFilter => typeof value === 'string' && isApprovalGateFilter(value),
  {
    message: `gate_filter must be one of ${APPROVAL_GATE_FILTER_VALUES.join(', ')}`,
  },
);

export const OrchRunCreateSchema = z.object({
  project_root: ProjectRootSchema,
  run_id: RunIdSchema.describe('Run identifier, unique within the project.'),
  workflow_id: z.string().optional().describe('Workflow identifier.'),
  idempotency_key: z
    .string()
    .optional()
    .describe('Idempotency key. If a run with matching key already exists, returns existing state without error.'),
});

export const OrchRunStageIdeaSchema = z.object({
  run_id: RunIdSchema.describe('Run identifier whose domain-owned run_dir should receive staged idea artifacts.'),
  run_dir: RunDirSchema,
  handoff_path: HandoffPathSchema,
  handoff_uri: HandoffUriSchema.optional(),
});

export const OrchRunStageContentSchema = z.object({
  run_id: RunIdSchema.describe('Run identifier whose run_dir should receive a staged writing/review artifact.'),
  run_dir: RunDirSchema,
  content_type: StagedContentTypeSchema.describe('Generic writing/review staged content type.'),
  content: z.string().min(1).describe('Opaque content payload preserved into the staged artifact.'),
  artifact_suffix: SafePathSegmentSchema.optional().describe('Optional suffix for deterministic artifact naming.'),
  task_id: RunIdSchema.optional().describe('Optional follow-up task identifier whose output is being staged.'),
  task_kind: z.enum(['draft_update', 'review']).optional().describe('Optional follow-up task kind paired with task_id.'),
});

export const OrchRunPlanComputationSchema = z.object({
  project_root: ProjectRootSchema,
  run_id: RunIdSchema.describe('Run identifier whose existing staged idea artifacts should be compiled into execution_plan_v1 and a run-local computation/manifest.json, preferring provider-backed materialization when the staged surface carries an explicit method bundle.'),
  run_dir: RunDirSchema,
  dry_run: z.boolean().optional().default(false).describe('Validate and materialize the execution plan without requesting approval or executing any computation step.'),
});

export const OrchRunExecuteManifestSchema = z.object({
  _confirm: z.literal(true).describe('Must be true to execute this destructive operation.'),
  project_root: ProjectRootSchema,
  run_id: RunIdSchema.describe('Run identifier whose approved run-local computation manifest should be executed.'),
  run_dir: RunDirSchema,
  manifest_path: z.string().min(1).describe('Path to computation manifest, relative to run_dir or absolute within run_dir/computation/.'),
  dry_run: z.boolean().optional().default(false).describe('Validate the manifest without requesting approval or executing any step.'),
});

export const OrchRunProgressFollowupsSchema = z.object({
  _confirm: z.literal(true).describe('Must be true to execute this destructive continuation operation.'),
  project_root: ProjectRootSchema,
  run_id: RunIdSchema.describe('Run identifier whose persisted computation follow-up tasks should be progressed.'),
  run_dir: RunDirSchema,
});

export const OrchRunRequestFinalConclusionsSchema = z.object({
  project_root: ProjectRootSchema,
  run_id: RunIdSchema.describe('Run identifier whose canonical computation_result_v1 should be evaluated for A5 final-conclusions readiness.'),
  note: z.string().optional().describe('Optional operator note recorded with the A5 approval request when one is created.'),
});

export const OrchRunRecordVerificationSchema = z.object({
  project_root: ProjectRootSchema,
  run_id: RunIdSchema.describe('Run identifier whose canonical computation_result_v1 should receive a decisive verification result update.'),
  status: z.enum(['passed', 'failed', 'blocked']).describe('Decisive verification result to record.'),
  summary: z.string().min(1).describe('Human-readable summary of the decisive verification outcome.'),
  evidence_paths: z.array(z.string().min(1)).min(1).describe('One or more evidence file paths, each absolute or relative within the run dir. Every path must resolve inside the current run directory.'),
  check_kind: z.string().min(1).optional().default('decisive_verification').describe('Verification check kind. Defaults to decisive_verification.'),
  confidence_level: z.enum(['low', 'medium', 'high']).optional().default('medium').describe('Operator-reported confidence level for the recorded verification result.'),
  confidence_score: z.number().min(0).max(1).optional().describe('Optional confidence score paired with confidence_level.'),
  notes: z.string().optional().describe('Optional operator note recorded into the verification check artifact.'),
});

export const OrchRunStatusSchema = z.object({
  project_root: ProjectRootSchema,
});

export const OrchRunListSchema = z.object({
  project_root: ProjectRootSchema,
  limit: z.number().int().positive().optional().default(20).describe('Max runs to return.'),
  status_filter: VisibleRunStatusFilterSchema.describe('Filter by run_status.'),
});

export const OrchRunApproveSchema = z.object({
  project_root: ProjectRootSchema,
  approval_id: z.string().min(1).describe('Approval ID, e.g. A1-0001.'),
  approval_packet_sha256: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/, 'Must be a lowercase hex SHA-256 of approval_packet_v1.json')
    .describe('SHA-256 of the approval_packet_v1.json file. Prevents approval of a tampered packet.'),
  _confirm: z.literal(true).describe('Must be true to execute this destructive operation.'),
  note: z.string().optional().describe('Optional note recorded in the ledger.'),
});

export const OrchRunRejectSchema = z.object({
  project_root: ProjectRootSchema,
  approval_id: z.string().min(1).describe('Approval ID to reject.'),
  _confirm: z.literal(true).describe('Must be true to execute this irreversible rejection.'),
  note: z.string().optional().describe('Reason for rejection, recorded in ledger.'),
});

export const OrchRunExportSchema = z.object({
  project_root: ProjectRootSchema,
  _confirm: z.literal(true).describe('Must be true to acknowledge the export (potentially destructive).'),
  include_state: z.boolean().optional().default(true).describe('Include .autoresearch/state.json in summary.'),
  include_artifacts: z.boolean().optional().default(true).describe('List artifact paths.'),
});

export const OrchRunPauseSchema = z.object({
  project_root: ProjectRootSchema,
  note: z.string().optional().describe('Reason for pausing, recorded in ledger.'),
});

export const OrchRunResumeSchema = z.object({
  project_root: ProjectRootSchema,
  note: z.string().optional().describe('Note recorded in ledger when resuming.'),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe('Allow resume from terminal states (idle/completed/failed). Intended for operator recovery, not a normal workflow path.'),
});

export const OrchRunApprovalsListSchema = z.object({
  project_root: ProjectRootSchema,
  run_id: z.string().optional().describe('Run ID to list approvals for. Defaults to current run_id in state.'),
  gate_filter: ApprovalGateFilterSchema.optional()
    .default('all')
    .describe('Filter by gate category.'),
  include_history: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include already-resolved approvals from approval_history.'),
});

export const OrchPolicyQuerySchema = z.object({
  project_root: ProjectRootSchema,
  operation: z
    .string()
    .optional()
    .describe('Operation to check (e.g. "mass_search", "code_changes", "compute_runs"). If omitted, returns full policy.'),
  include_history: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include historical approval precedents for the queried operation.'),
});

export const OrchFleetStatusSchema = z.object({
  project_roots: z.array(ProjectRootSchema).min(1).describe('Absolute or tilde-prefixed project roots to aggregate.'),
  limit_per_project: z.number().int().positive().optional().default(20).describe('Max runs returned per project root.'),
  status_filter: VisibleRunStatusFilterSchema.describe('Filter visible runs by run_status before per-project limiting.'),
  include_history: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include resolved approvals for the current run when available.'),
});

export const OrchFleetEnqueueSchema = z.object({
  project_root: ProjectRootSchema,
  run_id: RunIdSchema.describe('Run identifier to enqueue in the per-project fleet queue.'),
  requested_by: QueueOwnerSchema.describe('Operator or subsystem requesting the queue entry.'),
  priority: z.number().int().optional().default(0).describe('Higher values are claimed first.'),
  note: z.string().optional().describe('Optional operator-visible enqueue note.'),
});

export const OrchFleetClaimSchema = z.object({
  project_root: ProjectRootSchema,
  owner_id: QueueOwnerSchema.describe('Claim owner identifier.'),
  run_id: RunIdSchema.optional().describe('Optional specific run_id to claim instead of the highest-priority queued item.'),
  lease_duration_seconds: LeaseDurationSchema.optional().describe('Optional claim lease duration in seconds. If omitted, the queue claim resolves to the default lease duration.'),
});

export const OrchFleetReleaseSchema = z.object({
  project_root: ProjectRootSchema,
  queue_item_id: QueueItemIdSchema.describe('Queue item identifier returned by orch_fleet_enqueue.'),
  owner_id: QueueOwnerSchema.describe('Current claim owner id.'),
  disposition: QueueDispositionSchema.describe('How to settle the claimed queue item.'),
});

export const OrchFleetAdjudicateStaleClaimSchema = z.object({
  project_root: ProjectRootSchema,
  queue_item_id: QueueItemIdSchema.describe('Claimed queue item identifier to adjudicate.'),
  expected_claim_id: z.string().min(1).describe('Expected current claim_id. Used to fail closed on stale reads or concurrent mutation.'),
  expected_owner_id: QueueOwnerSchema.describe('Expected current claim owner id. Used to fail closed on stale reads or concurrent mutation.'),
  adjudicated_by: QueueOwnerSchema.describe('Operator or subsystem explicitly performing the stale-claim adjudication.'),
  disposition: QueueDispositionSchema.describe('How to settle the claimed queue item after manual adjudication.'),
  note: z.string().min(1).describe('Required human-readable adjudication note explaining why the existing claim was considered stale.'),
});

export const OrchFleetReassignClaimSchema = z.object({
  project_root: ProjectRootSchema,
  queue_item_id: QueueItemIdSchema.describe('Claimed queue item identifier to reassign.'),
  expected_claim_id: z.string().min(1).describe('Expected current claim_id. Used to fail closed on stale reads or concurrent mutation.'),
  expected_owner_id: WorkerIdSchema.describe('Expected current owner worker id. Used to fail closed on stale reads or concurrent mutation.'),
  target_worker_id: WorkerIdSchema.describe('Existing target worker id that should own the reassigned claim.'),
  reassigned_by: QueueOwnerSchema.describe('Operator or subsystem explicitly performing the manual reassignment.'),
  note: z.string().min(1).describe('Required human-readable note explaining why the claim is being reassigned.'),
});

export const OrchFleetWorkerPollSchema = z.object({
  project_root: ProjectRootSchema,
  worker_id: WorkerIdSchema.describe('Worker identifier used as the fleet queue claim owner.'),
  lease_duration_seconds: LeaseDurationSchema.optional().describe('Optional lease duration in seconds for a newly claimed queue item. Renewals continue to use the stored lease duration on existing claims.'),
  max_concurrent_claims: WorkerSlotSchema.optional().default(1).describe('Max simultaneous queue claims this worker may hold.'),
  heartbeat_timeout_seconds: HeartbeatTimeoutSchema.optional().default(60).describe('Heartbeat staleness threshold used only for health/read-model reporting.'),
  note: z.string().optional().describe('Optional operator-visible worker note stored in fleet_workers.json.'),
});

export const OrchFleetWorkerHeartbeatSchema = z.object({
  project_root: ProjectRootSchema,
  worker_id: WorkerIdSchema.describe('Worker identifier to register or refresh.'),
  max_concurrent_claims: WorkerSlotSchema.optional().default(1).describe('Worker slot count recorded in fleet_workers.json.'),
  heartbeat_timeout_seconds: HeartbeatTimeoutSchema.optional().default(60).describe('Heartbeat staleness threshold used only for health/read-model reporting.'),
  note: z.string().optional().describe('Optional operator-visible worker note stored in fleet_workers.json.'),
});

export const OrchFleetWorkerSetClaimAcceptanceSchema = z.object({
  project_root: ProjectRootSchema,
  worker_id: WorkerIdSchema.describe('Existing worker identifier whose new-claim acceptance gate should be updated.'),
  accepts_claims: z.boolean().describe('Whether the worker may claim new queue items when polling.'),
  updated_by: QueueOwnerSchema.describe('Operator or subsystem explicitly changing the worker claim-acceptance gate.'),
  note: z.string().min(1).describe('Required human-readable note explaining why claim acceptance changed.'),
});

export const OrchFleetWorkerUnregisterSchema = z.object({
  project_root: ProjectRootSchema,
  worker_id: WorkerIdSchema.describe('Existing worker identifier to remove from fleet_workers.json after drain completes.'),
  unregistered_by: QueueOwnerSchema.describe('Operator or subsystem explicitly unregistering the drained worker.'),
  note: z.string().min(1).describe('Required human-readable note explaining why the drained worker is being unregistered.'),
});

export const OrchRunExecuteAgentSchema = z.object({
  _confirm: z.literal(true).describe('Must be true to execute this destructive operation.'),
  project_root: ProjectRootSchema,
  run_id: RunIdSchema.describe('Run identifier whose manifest/checkpoints should be persisted under artifacts/runs/<run_id>/.'),
  model: z.string().min(1).describe('Preferred model hint for sampling/createMessage.'),
  messages: z.array(AgentMessageSchema).min(1).describe('Initial agent transcript. The recovery path can start from a pending assistant tool_use message.'),
  tools: z.array(AgentToolSchema).describe('Tool definitions exposed to the model during sampling.'),
  resume_from: z.string().optional().describe('Optional step id to resume from explicitly. Defaults to persisted last_completed_step.'),
  max_turns: z.number().int().positive().max(100).optional().describe('Maximum assistant turns before the runtime stops.'),
  team: TeamExecutionConfigSchema.optional().describe('Optional bounded EVO-13 team-local execution bridge. References workspace/task/handoff/checkpoint ids without replacing substrate state.'),
});
