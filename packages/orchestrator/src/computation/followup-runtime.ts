import { ORCH_RUN_STAGE_CONTENT } from '@autoresearch/shared';

export const DEFAULT_FOLLOWUP_RUNTIME_MODEL = 'claude-opus-4-6';

export const WRITING_REVIEW_FOLLOWUP_RUNTIME_TOOLS = [{
  name: ORCH_RUN_STAGE_CONTENT,
  description: 'Stage generic writing/review content into an existing run directory.',
  input_schema: { type: 'object', properties: {} },
}] as const;

export const FEEDBACK_FOLLOWUP_RUNTIME_TOOLS: Array<{
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}> = [];

export function followupRuntimeToolsForTaskKind(taskKind: 'idea' | 'draft_update' | 'review') {
  return taskKind === 'idea'
    ? [...FEEDBACK_FOLLOWUP_RUNTIME_TOOLS]
    : [...WRITING_REVIEW_FOLLOWUP_RUNTIME_TOOLS];
}

export function buildFollowupRuntimePrompt(params: {
  runId: string;
  taskId: string;
  taskKind: 'idea' | 'draft_update' | 'review';
  taskTitle: string;
  computationResultUri: string;
  handoffId: string;
  handoffKind: 'feedback' | 'writing' | 'review';
  bridgeUri?: string | null;
  handoffPayload?: Record<string, unknown> | null;
  taskMetadata?: Record<string, unknown> | null;
}): string {
  const lines = [
    'Continue exactly one computation-generated delegated follow-up.',
    `run_id: ${params.runId}`,
    `task_id: ${params.taskId}`,
    `task_kind: ${params.taskKind}`,
    `task_title: ${params.taskTitle}`,
    `computation_result_uri: ${params.computationResultUri}`,
    `handoff_id: ${params.handoffId}`,
    `handoff_kind: ${params.handoffKind}`,
  ];
  if (params.bridgeUri) {
    lines.push(`bridge_uri: ${params.bridgeUri}`);
  }
  if (params.handoffPayload && Object.keys(params.handoffPayload).length > 0) {
    lines.push(`handoff_payload_json: ${JSON.stringify(params.handoffPayload)}`);
  }
  if (params.taskMetadata && Object.keys(params.taskMetadata).length > 0) {
    lines.push(`task_metadata_json: ${JSON.stringify(params.taskMetadata)}`);
  }
  lines.push('Use the current ResearchWorkspace, tasks, handoffs, and follow-up artifacts as the sole source of truth.');
  lines.push('Stay inside this single supervised_delegate assignment. Do not launch schedulers, second shells, or parallel follow-ups.');
  lines.push('Do not guess or synthesize literature-search queries. If the continuation would require a literature_followup, leave that for the host-level deferred path.');
  return lines.join('\n');
}
