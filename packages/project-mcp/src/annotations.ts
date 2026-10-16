/**
 * Risk levels, behaviour hints and titles behind the tools/list entries
 * (annotation rules in @nullius/shared tool-annotations.ts).
 *
 * Orchestrator tools take their risk from the orchestrator's
 * execution_policy.mutation_class: read_only is a read, and every stateful
 * tool exposed here can replace project state (a run reset, rewritten run
 * status, replaced staged or computation files), so stateful is destructive.
 * Background tools are keyed by delivery_id, whose replay returns the
 * original response; the two sampling tools have no replay key.
 */

import type { ToolBehaviourHintTable, ToolRiskLevel, ToolRiskTable } from '@nullius/shared';

type ExecutionPolicy = { mutation_class: 'read_only' | 'stateful' };

export function riskFromExecutionPolicy(policy: ExecutionPolicy): ToolRiskLevel {
  return policy.mutation_class === 'read_only' ? 'read' : 'destructive';
}

export const PROJECT_LOCAL_TOOL_RISK_LEVELS: ToolRiskTable = {
  project_capabilities: 'read',
  project_file_read: 'read',
  // Replaces a file when expected_sha256 matches its current hash.
  project_file_write: 'destructive',
  project_delivery_read: 'read',
  // Mutating actions include result_set_current, which replaces a row.
  project_cli: 'destructive',
};

const LOCAL_READ = 'Reads the bound project only.';
const DELIVERY =
  'Runs on the bound project as a background delivery keyed by delivery_id; a replay of the same delivery_id returns the original response.';
const RUNS_PROJECT_CODE =
  'Runs the project\'s own scripts, which are not network-isolated, as a background delivery keyed by delivery_id; a replay returns the original response.';
const SAMPLING =
  'Asks the client model via sampling and runs the project tools it chooses, which can execute project scripts; no replay key.';

export const PROJECT_TOOL_HINTS: ToolBehaviourHintTable = {
  project_capabilities: { openWorld: false, reason: 'Reports the bound project and transport capabilities.' },
  project_file_read: { openWorld: false, reason: LOCAL_READ },
  project_file_write: {
    idempotent: true,
    openWorld: false,
    reason: 'Writes one project file by compare-and-swap on expected_sha256, so a repeat is refused or rewrites the same bytes.',
  },
  project_delivery_read: { openWorld: false, reason: 'Reads a stored delivery response of the bound project.' },
  project_cli: {
    idempotent: true,
    openWorld: false,
    reason: 'Read actions run inline; mutating actions are background deliveries keyed by delivery_id whose replay returns the original response.',
  },
  orch_run_create: { idempotent: true, openWorld: false, reason: DELIVERY },
  orch_run_status: { openWorld: false, reason: 'Reads run state; refreshes only the harness invocation marker.' },
  orch_run_list: { openWorld: false, reason: LOCAL_READ },
  orch_run_pause: { idempotent: true, openWorld: false, reason: DELIVERY },
  orch_run_resume: { idempotent: true, openWorld: false, reason: DELIVERY },
  orch_run_export: { openWorld: false, reason: 'Builds an export summary of the bound project; copies no files.' },
  orch_policy_query: { openWorld: false, reason: LOCAL_READ },
  orch_run_approvals_list: { openWorld: false, reason: LOCAL_READ },
  orch_run_stage_idea: { idempotent: true, openWorld: false, reason: DELIVERY },
  orch_run_stage_content: { idempotent: true, openWorld: false, reason: DELIVERY },
  orch_run_plan_computation: { idempotent: true, openWorld: false, reason: DELIVERY },
  orch_run_execute_manifest: { idempotent: true, openWorld: true, reason: RUNS_PROJECT_CODE },
  orch_run_record_verification: { idempotent: true, openWorld: true, reason: RUNS_PROJECT_CODE },
  orch_run_request_final_conclusions: { idempotent: true, openWorld: false, reason: DELIVERY },
  orch_run_execute_agent: { openWorld: true, reason: SAMPLING },
  orch_run_progress_followups: { openWorld: true, reason: SAMPLING },
};

export const PROJECT_TOOL_TITLES: Readonly<Record<string, string>> = {
  project_capabilities: 'Project capabilities',
  project_file_read: 'Read project file',
  project_file_write: 'Upload project file',
  project_delivery_read: 'Read delivery response',
  project_cli: 'Run nullius CLI action',
  orch_run_create: 'Create run',
  orch_run_status: 'Run status',
  orch_run_list: 'List runs',
  orch_run_pause: 'Pause run',
  orch_run_resume: 'Resume run',
  orch_run_export: 'Export run summary',
  orch_policy_query: 'Query run policy',
  orch_run_approvals_list: 'List run approvals',
  orch_run_stage_idea: 'Stage idea for run',
  orch_run_stage_content: 'Stage run content',
  orch_run_plan_computation: 'Plan computation',
  orch_run_execute_manifest: 'Execute computation manifest',
  orch_run_record_verification: 'Record verification',
  orch_run_request_final_conclusions: 'Request final conclusions',
  orch_run_execute_agent: 'Execute delegated agent',
  orch_run_progress_followups: 'Progress follow-up tasks',
};
