import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArtifactRefV1, ComputationResultV1 } from '@autoresearch/shared';
import { utcNowIso } from '../util.js';
import {
  ResearchLoopRuntime,
  createResearchWorkspace,
  interactiveResearchLoopPolicy,
} from '../research-loop/index.js';
import { assertExecutionPlanValid } from './execution-plan.js';
import type { PreparedManifest } from './types.js';

function loadExecutionPlanTitle(prepared: PreparedManifest): string {
  const planPath = path.join(prepared.workspaceDir, 'execution_plan_v1.json');
  if (!fs.existsSync(planPath)) {
    return prepared.manifest.title ?? `Approved computation for ${prepared.runId}`;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as unknown;
    return assertExecutionPlanValid(parsed).objective;
  } catch {
    return prepared.manifest.title ?? `Approved computation for ${prepared.runId}`;
  }
}

type WorkspaceFeedback = ComputationResultV1['workspace_feedback'];
type NextAction = ComputationResultV1['next_actions'][number];

export function buildLoopFeedback(params: {
  prepared: PreparedManifest;
  executionStatus: 'completed' | 'failed';
  summary: string;
  manifestRef: ArtifactRefV1;
  outcomeUri: string;
  producedArtifactRefs: ArtifactRefV1[];
  failureReason?: string;
}): { workspaceFeedback: WorkspaceFeedback; nextActions: NextAction[] } {
  const objectiveTitle = loadExecutionPlanTitle(params.prepared);
  const workspace = createResearchWorkspace({
    workspace_id: `workspace:${params.prepared.runId}`,
    primary_question_id: `question:${params.prepared.runId}`,
    nodes: [
      { node_id: `question:${params.prepared.runId}`, kind: 'question', title: objectiveTitle },
      { node_id: `idea:${params.prepared.runId}`, kind: 'idea', title: `Staged idea for ${objectiveTitle}` },
      { node_id: `evidence:${params.prepared.runId}`, kind: 'evidence_set', title: `Evidence follow-up for ${objectiveTitle}` },
      { node_id: `compute:${params.prepared.runId}`, kind: 'compute_attempt', title: params.prepared.manifest.title ?? 'Approved computation' },
      { node_id: `finding:${params.prepared.runId}`, kind: 'finding', title: `Finding from ${objectiveTitle}` },
    ],
    edges: [
      { edge_id: `edge:${params.prepared.runId}:idea-supports-question`, kind: 'supports', from_node_id: `idea:${params.prepared.runId}`, to_node_id: `question:${params.prepared.runId}` },
      { edge_id: `edge:${params.prepared.runId}:evidence-supports-idea`, kind: 'supports', from_node_id: `evidence:${params.prepared.runId}`, to_node_id: `idea:${params.prepared.runId}` },
      { edge_id: `edge:${params.prepared.runId}:compute-depends-on-idea`, kind: 'depends_on', from_node_id: `compute:${params.prepared.runId}`, to_node_id: `idea:${params.prepared.runId}` },
      { edge_id: `edge:${params.prepared.runId}:compute-produces-finding`, kind: 'produces', from_node_id: `compute:${params.prepared.runId}`, to_node_id: `finding:${params.prepared.runId}` },
    ],
  });
  const runtime = new ResearchLoopRuntime({ workspace, policy: interactiveResearchLoopPolicy() });
  const computeTask = runtime.injectTask({
    kind: 'compute',
    title: `Execute ${params.prepared.manifest.title ?? 'approved computation manifest'}`,
    target_node_id: `compute:${params.prepared.runId}`,
    source: 'system',
    actor_id: null,
    metadata: {
      run_id: params.prepared.runId,
      manifest_ref: params.manifestRef.uri,
      outcome_ref: params.outcomeUri,
      step_ids: params.prepared.stepOrder,
    },
  });
  runtime.transitionTask(computeTask.task_id, 'active', { source: 'system', actor_id: null });
  if (params.executionStatus === 'completed') {
    runtime.transitionTask(computeTask.task_id, 'completed', { source: 'system', actor_id: null });
    const findingTask = runtime.spawnFollowupTask(computeTask.task_id, {
      kind: 'finding',
      title: `Capture finding from ${objectiveTitle}`,
      target_node_id: `finding:${params.prepared.runId}`,
      source: 'system',
      actor_id: null,
      metadata: {
        outcome_ref: params.outcomeUri,
        produced_artifact_refs: params.producedArtifactRefs.map(ref => ref.uri),
      },
    });
    return {
      workspaceFeedback: {
        policy_mode: runtime.getState().policy.mode,
        workspace: runtime.getState().workspace,
        tasks: runtime.getState().tasks,
        events: runtime.getState().events,
        handoffs: runtime.getState().handoffs,
        active_task_ids: runtime.getState().active_task_ids,
      },
      nextActions: [
        {
          action_kind: 'capture_finding',
          task_kind: 'finding',
          title: findingTask.title,
          target_node_id: findingTask.target_node_id,
          reason: params.summary,
        },
      ],
    };
  }
  runtime.transitionTask(computeTask.task_id, 'blocked', { source: 'system', actor_id: null });
  const followupTask = runtime.appendDelegatedTask({
    handoff: {
      handoff_id: randomUUID(),
      handoff_kind: 'feedback',
      workspace_id: workspace.workspace_id,
      source_task_id: computeTask.task_id,
      target_node_id: `idea:${params.prepared.runId}`,
      source: 'system',
      actor_id: null,
      created_at: utcNowIso(),
      payload: { disposition: 'refine_idea' },
    },
    task: {
      kind: 'idea',
      title: `Refine idea after failed execution of ${objectiveTitle}`,
      target_node_id: `idea:${params.prepared.runId}`,
      source: 'system',
      actor_id: null,
      metadata: {
        outcome_ref: params.outcomeUri,
        failure_reason: params.failureReason ?? params.summary,
      },
    },
  });
  return {
    workspaceFeedback: {
      policy_mode: runtime.getState().policy.mode,
      workspace: runtime.getState().workspace,
      tasks: runtime.getState().tasks,
      events: runtime.getState().events,
      handoffs: runtime.getState().handoffs,
      active_task_ids: runtime.getState().active_task_ids,
    },
    nextActions: [
      {
        action_kind: 'refine_idea',
        task_kind: 'idea',
        title: followupTask.title,
        target_node_id: followupTask.target_node_id,
        reason: params.failureReason ?? params.summary,
        handoff_kind: 'feedback',
      },
    ],
  };
}
