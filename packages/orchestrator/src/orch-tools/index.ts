import { z } from 'zod';
import {
  ORCH_RUN_EXECUTE_AGENT,
  ORCH_POLICY_QUERY,
  ORCH_RUN_APPROVE,
  ORCH_RUN_APPROVALS_LIST,
  ORCH_RUN_CREATE,
  ORCH_RUN_EXPORT,
  ORCH_RUN_LIST,
  ORCH_RUN_PAUSE,
  ORCH_RUN_REJECT,
  ORCH_RUN_RESUME,
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
import { FLEET_TOOL_SPECS } from './fleet-tool-specs.js';
import {
  OrchRunExecuteAgentSchema,
  OrchPolicyQuerySchema,
  OrchRunApproveSchema,
  OrchRunApprovalsListSchema,
  OrchRunCreateSchema,
  OrchRunExportSchema,
  OrchRunListSchema,
  OrchRunPauseSchema,
  OrchRunRejectSchema,
  OrchRunResumeSchema,
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
    name: ORCH_RUN_CREATE,
    tier: 'core',
    exposure: 'full',
    description: 'Create (or idempotently replay) a hepar orchestrator run in a local project root. Initializes .autoresearch/ state (local-only).',
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
