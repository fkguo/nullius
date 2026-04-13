import { z } from 'zod';
import {
  ORCH_RUN_EXECUTE_AGENT,
  ORCH_RUN_EXECUTE_MANIFEST,
  ORCH_RUN_PLAN_COMPUTATION,
  ORCH_POLICY_QUERY,
  ORCH_RUN_APPROVE,
  ORCH_RUN_APPROVALS_LIST,
  ORCH_RUN_CREATE,
  ORCH_RUN_EXPORT,
  ORCH_RUN_LIST,
  ORCH_RUN_PAUSE,
  ORCH_RUN_REJECT,
  ORCH_RUN_RESUME,
  ORCH_RUN_STAGE_CONTENT,
  ORCH_RUN_STAGE_IDEA,
  ORCH_RUN_STATUS,
} from '@autoresearch/shared';
import {
  handleOrchRunApprove,
  handleOrchRunApprovalsList,
  handleOrchRunReject,
} from './approval.js';
import { handleOrchRunExecuteAgent, type AgentToolHandlerContext } from './agent-runtime.js';
import {
  handleOrchPolicyQuery,
  handleOrchRunExport,
  handleOrchRunPause,
  handleOrchRunResume,
} from './control.js';
import {
  handleOrchRunCreate,
  handleOrchRunList,
  handleOrchRunStatus,
} from './create-status-list.js';
import {
  handleOrchRunExecuteManifest,
  handleOrchRunPlanComputation,
  handleOrchRunStageContent,
  handleOrchRunStageIdea,
} from './bridge-tools.js';
import { FLEET_TOOL_SPECS } from './fleet-tool-specs.js';
import {
  OrchRunExecuteAgentSchema,
  OrchPolicyQuerySchema,
  OrchRunApproveSchema,
  OrchRunApprovalsListSchema,
  OrchRunCreateSchema,
  OrchRunExecuteManifestSchema,
  OrchRunExportSchema,
  OrchRunListSchema,
  OrchRunPlanComputationSchema,
  OrchRunPauseSchema,
  OrchRunRejectSchema,
  OrchRunResumeSchema,
  OrchRunStageContentSchema,
  OrchRunStageIdeaSchema,
  OrchRunStatusSchema,
} from './schemas.js';

type OrchestratorToolSpec<TSchema extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  tier: 'core' | 'consolidated' | 'advanced' | 'writing';
  exposure: 'standard' | 'full';
  zodSchema: TSchema;
  handler: (params: unknown, ctx?: AgentToolHandlerContext) => Promise<unknown>;
};

export const ORCH_TOOL_SPECS: OrchestratorToolSpec[] = [
  ...FLEET_TOOL_SPECS,
  {
    name: ORCH_RUN_EXECUTE_AGENT,
    tier: 'advanced',
    exposure: 'full',
    description: 'Execute an orchestrator agent runtime with run-scoped manifest checkpoints and crash/re-entry resume semantics (destructive: persists run-scoped checkpoints/state). Requires _confirm: true.',
    zodSchema: OrchRunExecuteAgentSchema,
    handler: async (params, ctx) => handleOrchRunExecuteAgent(params as z.output<typeof OrchRunExecuteAgentSchema>, ctx),
  },
  {
    name: ORCH_RUN_STAGE_IDEA,
    tier: 'advanced',
    exposure: 'full',
    description: 'Stage an IdeaHandoffC2 artifact into an existing domain-owned run directory by writing outline_seed_v1.json and idea_handoff_hints_v1.json (local-only).',
    zodSchema: OrchRunStageIdeaSchema,
    handler: async params => handleOrchRunStageIdea(params as z.output<typeof OrchRunStageIdeaSchema>),
  },
  {
    name: ORCH_RUN_STAGE_CONTENT,
    tier: 'advanced',
    exposure: 'full',
    description: 'Stage generic writing/review content into an existing run directory by writing a staged_<content_type>_<suffix>.json artifact and returning a rep://runs/... staging URI (local-only).',
    zodSchema: OrchRunStageContentSchema,
    handler: async params => handleOrchRunStageContent(params as z.output<typeof OrchRunStageContentSchema>),
  },
  {
    name: ORCH_RUN_PLAN_COMPUTATION,
    tier: 'advanced',
    exposure: 'full',
    description: 'Compile staged idea artifacts from an existing run directory into execution_plan_v1.json and computation/manifest.json, then stop at dry_run validation or A3 approval request before any execution.',
    zodSchema: OrchRunPlanComputationSchema,
    handler: async params => handleOrchRunPlanComputation(params as z.output<typeof OrchRunPlanComputationSchema>),
  },
  {
    name: ORCH_RUN_EXECUTE_MANIFEST,
    tier: 'advanced',
    exposure: 'full',
    description: 'Execute a computation_manifest_v1 plan from an existing run directory. dry_run validates only; real execution requires _confirm: true and returns an approval packet when A3 is pending.',
    zodSchema: OrchRunExecuteManifestSchema,
    handler: async params => handleOrchRunExecuteManifest(params as z.output<typeof OrchRunExecuteManifestSchema>),
  },
  {
    name: ORCH_RUN_CREATE,
    tier: 'core',
    exposure: 'full',
    description: 'Create (or idempotently replay) an autoresearch orchestrator run in a local project root. Initializes .autoresearch/ state (local-only).',
    zodSchema: OrchRunCreateSchema,
    handler: async params => handleOrchRunCreate(params as z.output<typeof OrchRunCreateSchema>),
  },
  {
    name: ORCH_RUN_STATUS,
    tier: 'core',
    exposure: 'full',
    description: 'Return the current orchestrator run status (run_id, run_status, pending_approval, gate_satisfied) from state.json (read-only, local-only).',
    zodSchema: OrchRunStatusSchema,
    handler: async params => handleOrchRunStatus(params as z.output<typeof OrchRunStatusSchema>),
  },
  {
    name: ORCH_RUN_LIST,
    tier: 'core',
    exposure: 'full',
    description: 'List runs recorded in ledger.jsonl with optional status filter and pagination (read-only, local-only).',
    zodSchema: OrchRunListSchema,
    handler: async params => handleOrchRunList(params as z.output<typeof OrchRunListSchema>),
  },
  {
    name: ORCH_RUN_APPROVE,
    tier: 'core',
    exposure: 'full',
    description: 'Approve a pending orchestrator gate (destructive: irreversible). Requires _confirm: true, approval_id, AND approval_packet_sha256 verification against the on-disk packet (local-only).',
    zodSchema: OrchRunApproveSchema,
    handler: async params => handleOrchRunApprove(params as z.output<typeof OrchRunApproveSchema>),
  },
  {
    name: ORCH_RUN_REJECT,
    tier: 'core',
    exposure: 'full',
    description: 'Reject a pending orchestrator gate (destructive: irreversible pause). Requires _confirm: true (local-only).',
    zodSchema: OrchRunRejectSchema,
    handler: async params => handleOrchRunReject(params as z.output<typeof OrchRunRejectSchema>),
  },
  {
    name: ORCH_RUN_EXPORT,
    tier: 'core',
    exposure: 'full',
    description: 'Export run summary (state + artifact listing). Requires _confirm: true. Does not copy files — returns a manifest of available outputs (local-only).',
    zodSchema: OrchRunExportSchema,
    handler: async params => handleOrchRunExport(params as z.output<typeof OrchRunExportSchema>),
  },
  {
    name: ORCH_RUN_PAUSE,
    tier: 'core',
    exposure: 'full',
    description: 'Pause the current orchestrator run by writing .pause sentinel and updating state (local-only).',
    zodSchema: OrchRunPauseSchema,
    handler: async params => handleOrchRunPause(params as z.output<typeof OrchRunPauseSchema>),
  },
  {
    name: ORCH_RUN_RESUME,
    tier: 'core',
    exposure: 'full',
    description: 'Resume a paused orchestrator run by removing .pause sentinel and updating state (local-only).',
    zodSchema: OrchRunResumeSchema,
    handler: async params => handleOrchRunResume(params as z.output<typeof OrchRunResumeSchema>),
  },
  {
    name: ORCH_RUN_APPROVALS_LIST,
    tier: 'core',
    exposure: 'full',
    description: 'List approval packets for a run (pending + optionally historical). Returns approval_id, gate_id, SHA-256, and orch:// URI (read-only, local-only).',
    zodSchema: OrchRunApprovalsListSchema,
    handler: async params => handleOrchRunApprovalsList(params as z.output<typeof OrchRunApprovalsListSchema>),
  },
  {
    name: ORCH_POLICY_QUERY,
    tier: 'core',
    exposure: 'full',
    description: 'Query the orchestrator approval policy: "does operation X require approval?" Returns policy rules and optionally historical precedents (read-only, local-only).',
    zodSchema: OrchPolicyQuerySchema,
    handler: async params => handleOrchPolicyQuery(params as z.output<typeof OrchPolicyQuerySchema>),
  },
];
