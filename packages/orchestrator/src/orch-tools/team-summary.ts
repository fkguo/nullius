import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunState } from '../types.js';
import { TeamExecutionStateManager } from '../team-execution-storage.js';
import { buildTeamLiveStatusView } from '../team-execution-view.js';

function expectsTeamState(projectRoot: string, runId: string): boolean {
  const resultPath = path.join(projectRoot, runId, 'artifacts', 'computation_result_v1.json');
  if (!fs.existsSync(resultPath)) {
    return false;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as Record<string, unknown>;
    const workspaceFeedback = parsed.workspace_feedback as Record<string, unknown> | undefined;
    const tasks = workspaceFeedback?.tasks;
    return Array.isArray(tasks) && tasks.some((task) => {
      const metadata = task && typeof task === 'object' ? (task as Record<string, unknown>).metadata : null;
      return Boolean(metadata && typeof metadata === 'object' && 'team_execution' in metadata);
    });
  } catch {
    return false;
  }
}

export function readTeamSummaryView(projectRoot: string, state: RunState): {
  team_summary: Record<string, unknown> | null;
  team_summary_error: Record<string, unknown> | null;
} {
  if (!state.run_id) {
    return { team_summary: null, team_summary_error: null };
  }
  const manager = new TeamExecutionStateManager(projectRoot);
  const filePath = manager.pathFor(state.run_id);
  const expected = fs.existsSync(filePath) || expectsTeamState(projectRoot, state.run_id);
  if (!expected) {
    return { team_summary: null, team_summary_error: null };
  }
  if (!fs.existsSync(filePath)) {
    return {
      team_summary: null,
      team_summary_error: {
        code: 'TEAM_SUMMARY_MISSING',
        message: `expected team state is missing at ${path.relative(projectRoot, filePath).split(path.sep).join('/')}.`,
      },
    };
  }
  try {
    const loaded = manager.load(state.run_id);
    if (!loaded) {
      return {
        team_summary: null,
        team_summary_error: {
          code: 'TEAM_SUMMARY_MISSING',
          message: `expected team state is missing at ${path.relative(projectRoot, filePath).split(path.sep).join('/')}.`,
        },
      };
    }
    const live = buildTeamLiveStatusView(loaded);
    return {
      team_summary: {
        workspace_id: live.workspace_id,
        coordination_policy: live.coordination_policy,
        blocked_stage: live.blocked_stage,
        active_assignment_count: live.active_assignments.length,
        pending_approval_count: live.pending_approvals.length,
        checkpoint_count: loaded.checkpoints.length,
        active_assignments: live.active_assignments.map(item => ({
          assignment_id: item.assignment_id,
          task_id: item.task_id,
          task_kind: item.task_kind,
          status: item.status,
          delegate_id: item.agent_id,
          handoff_kind: item.handoff_kind,
          resume_from: item.resume_from,
          approval_id: item.approval_id,
        })),
        terminal_assignments: live.terminal_assignments.map(item => ({
          assignment_id: item.assignment_id,
          task_id: item.task_id,
          task_kind: item.task_kind,
          status: item.status,
          delegate_id: item.agent_id,
          handoff_kind: item.handoff_kind,
          resume_from: item.resume_from,
          approval_id: item.approval_id,
        })),
      },
      team_summary_error: null,
    };
  } catch (error) {
    return {
      team_summary: null,
      team_summary_error: {
        code: 'TEAM_SUMMARY_INVALID',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
