import * as fs from 'node:fs';
import { parseScopedArtifactUri, type ComputationResultV1 } from '@autoresearch/shared';
import {
  buildTeamConfigForDelegatedFollowupTask,
  primeDelegatedFollowupTeamState,
  type DelegatedFollowupTeamConfig,
  type ExecuteComputationManifestResult,
} from '@autoresearch/orchestrator';
import { ORCH_RUN_EXECUTE_AGENT } from '../tool-names.js';
import { getRun } from '../core/runs.js';
import { buildFollowupPrompt, DEFAULT_DELEGATE_MODEL, FOLLOWUP_RUNTIME_TOOLS } from './computation-followup-runtime.js';
import type { ToolHandlerContext } from './registry/types.js';

type CompletedExecutionResult = Extract<ExecuteComputationManifestResult, { status: 'completed' }>;
type FollowupTask = ComputationResultV1['workspace_feedback']['tasks'][number];
type DelegatedFollowupTask = Omit<FollowupTask, 'kind'> & { kind: 'draft_update' | 'review' };
type LaunchStatus =
  | 'launched'
  | 'skipped_no_pending_task'
  | 'skipped_missing_host_context'
  | 'skipped_invalid_team_execution'
  | 'launch_failed';

type DelegatedLaunchResult = {
  status: LaunchStatus;
  task_id?: string;
  task_kind?: 'draft_update' | 'review';
  assignment_id?: string;
  team_state_path?: string;
  error?: string;
};

function hasTeamExecutionKey(task: FollowupTask): boolean {
  return Boolean(task.metadata && typeof task.metadata === 'object' && Object.prototype.hasOwnProperty.call(task.metadata, 'team_execution'));
}

function isDelegatedLaunchCandidate(
  task: FollowupTask,
  kind: DelegatedFollowupTask['kind'],
): task is DelegatedFollowupTask {
  return task.kind === kind && task.status === 'pending' && hasTeamExecutionKey(task);
}

function selectPendingDelegatedTask(computationResult: ComputationResultV1): DelegatedFollowupTask | null {
  const tasks = computationResult.workspace_feedback.tasks;
  for (const kind of ['draft_update', 'review'] as const) {
    const match = tasks.find(task => isDelegatedLaunchCandidate(task, kind));
    if (match) return match;
  }
  return null;
}

function findBridgeUri(result: CompletedExecutionResult, team: DelegatedFollowupTeamConfig): string | null {
  const artifactName = team.handoff_kind === 'writing' ? 'writing_followup_bridge_v1.json' : 'review_followup_bridge_v1.json';
  for (const ref of result.followup_bridge_refs) {
    const parts = parseScopedArtifactUri(ref.uri, { scheme: 'hep', scope: 'runs' });
    if (parts?.artifactName === artifactName) return ref.uri;
  }
  return null;
}

function parseToolPayload(result: {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): Record<string, unknown> | null {
  const rawText = result.content
    .filter(part => part.type === 'text')
    .map(part => part.text ?? '')
    .join('\n')
    .trim();
  if (!rawText) return null;
  try {
    const parsed = JSON.parse(rawText) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function launchedResult(payload: Record<string, unknown>, task: DelegatedFollowupTask): DelegatedLaunchResult {
  const teamState = payload.team_state;
  const assignments = teamState && typeof teamState === 'object' && Array.isArray((teamState as { delegate_assignments?: unknown[] }).delegate_assignments)
    ? (teamState as { delegate_assignments: Array<Record<string, unknown>> }).delegate_assignments
    : [];
  const assignment = assignments.find(candidate => candidate.task_id === task.task_id) ?? assignments[0];
  return {
    status: 'launched',
    task_id: task.task_id,
    task_kind: task.kind,
    assignment_id: typeof assignment?.assignment_id === 'string' ? assignment.assignment_id : undefined,
    team_state_path: typeof payload.team_state_path === 'string' ? payload.team_state_path : undefined,
  };
}

export async function maybeLaunchDelegatedComputationFollowup(params: {
  ctx: ToolHandlerContext;
  result: CompletedExecutionResult;
  projectRoot: string;
  runId: string;
}): Promise<DelegatedLaunchResult> {
  const computationResult = JSON.parse(
    fs.readFileSync(params.result.artifact_paths.computation_result, 'utf-8'),
  ) as ComputationResultV1;
  const task = selectPendingDelegatedTask(computationResult);
  if (!task) {
    return { status: 'skipped_no_pending_task' };
  }

  let team: DelegatedFollowupTeamConfig;
  try {
    team = buildTeamConfigForDelegatedFollowupTask(task);
  } catch (error) {
    return {
      status: 'skipped_invalid_team_execution',
      task_id: task.task_id,
      task_kind: task.kind,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!params.ctx.createMessage || !params.ctx.callTool) {
    return { status: 'skipped_missing_host_context', task_id: task.task_id, task_kind: task.kind };
  }

  primeDelegatedFollowupTeamState({
    projectRoot: params.projectRoot,
    runId: params.runId,
    team,
  });
  const { research_task_ref: _researchTaskRef, ...launchTeam } = team;
  const run = getRun(params.runId);
  const launched = await params.ctx.callTool(ORCH_RUN_EXECUTE_AGENT, {
    _confirm: true,
    project_root: params.projectRoot,
    run_id: params.runId,
    model: DEFAULT_DELEGATE_MODEL,
    messages: [{
      role: 'user',
      content: buildFollowupPrompt({
        bridgeUri: findBridgeUri(params.result, team),
        computationResultUri: params.result.outcome_ref.uri,
        projectId: run.project_id,
        runId: params.runId,
        taskId: task.task_id,
        taskKind: task.kind,
        taskTitle: task.title,
        handoffId: team.handoff_id,
        handoffKind: team.handoff_kind,
      }),
    }],
    tools: FOLLOWUP_RUNTIME_TOOLS,
    team: launchTeam,
  });
  const payload = parseToolPayload(launched);
  if (launched.isError || !payload) {
    const error = payload?.error;
    return {
      status: 'launch_failed',
      task_id: task.task_id,
      task_kind: task.kind,
      error: typeof error === 'string'
        ? error
        : error && typeof error === 'object'
          ? JSON.stringify(error)
          : 'delegated runtime launch failed',
    };
  }
  return launchedResult(payload, task);
}
