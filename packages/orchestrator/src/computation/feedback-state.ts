import { shortId } from '@nullius/shared';
import type { ComputationResultV1 } from '@nullius/shared';
import { utcNowIso } from '../util.js';
import {
  ResearchLoopRuntime,
  createResearchWorkspace,
  interactiveResearchLoopPolicy,
  type FeedbackHandoff,
  type ResearchEdge,
  type ResearchNode,
  type ResearchTaskInput,
} from '../research-loop/index.js';
import { makeRunArtifactUri } from './artifact-refs.js';
import {
  appendWritingFollowups,
  attachDelegatedFollowupTeamExecutionMetadata,
} from './feedback-followups.js';
import { loopNodeIdsFor } from './feedback-lowering.js';
import type { WritingFollowupWorkspaceSeed } from './followup-bridges.js';

type WorkspaceFeedback = ComputationResultV1['workspace_feedback'];
type NextAction = ComputationResultV1['next_actions'][number];
type ExecutionFeedbackInput = Pick<
  ComputationResultV1,
  'run_id' | 'objective_title' | 'manifest_ref' | 'produced_artifact_refs' | 'summary' | 'feedback_lowering' | 'executor_provenance' | 'execution_status'
> & Partial<Pick<ComputationResultV1, 'failure_reason'>>;

type FeedbackAuthorityInput = ExecutionFeedbackInput & { feedback_lowering: NonNullable<ComputationResultV1['feedback_lowering']> };

function feedbackReason(input: FeedbackAuthorityInput): string {
  return input.feedback_lowering.signal === 'failure'
    ? input.failure_reason ?? input.summary
    : input.summary;
}

function taskTitle(input: FeedbackAuthorityInput): string {
  switch (input.feedback_lowering.decision_kind) {
    case 'capture_finding':
      return `Capture finding from ${input.objective_title}`;
    case 'branch_idea':
      return `Branch idea after weak signal from ${input.objective_title}`;
    case 'downgrade_idea':
      return `Review declared negative result for ${input.objective_title}`;
    case 'literature_followup':
      return `Backtrack literature after ${input.objective_title}`;
    default:
      return `Refine idea after ${input.objective_title}`;
  }
}

function buildWorkspace(input: FeedbackAuthorityInput, writingSeed?: WritingFollowupWorkspaceSeed) {
  const ids = loopNodeIdsFor(input.run_id);
  const resultRef = makeRunArtifactUri(input.run_id, 'artifacts/computation_result_v1.json');
  const nodes: ResearchNode[] = [
    { node_id: ids.question, kind: 'question' as const, title: input.objective_title },
    { node_id: ids.idea, kind: 'idea' as const, title: `Declared feedback context for ${input.objective_title}` },
    { node_id: ids.compute, kind: 'compute_attempt' as const, title: `Approved computation for ${input.objective_title}` },
    {
      node_id: ids.decision,
      kind: 'decision' as const,
      title: `Feedback decision for ${input.objective_title}`,
      metadata: { result_ref: resultRef, manifest_ref: input.manifest_ref.uri, feedback_lowering: input.feedback_lowering },
    },
  ];
  if (input.feedback_lowering.decision_kind === 'capture_finding') {
    nodes.push({ node_id: ids.finding, kind: 'finding', title: `Declared finding to review from ${input.objective_title}`, metadata: { basis: 'producer_declaration', independently_verified: false } });
  }
  if (writingSeed) nodes.push(...writingSeed.nodes);
  if (input.feedback_lowering.target_task_kind === 'idea' && input.feedback_lowering.target_node_id !== ids.idea) {
    nodes.push({
      node_id: input.feedback_lowering.target_node_id,
      kind: 'idea',
      title: `Branch idea from ${input.objective_title}`,
      metadata: { branch_from_node_id: ids.idea },
    });
  }
  // A pending evidence target is requested work, never an accepted support assertion.
  if (writingSeed || input.feedback_lowering.target_task_kind === 'literature') {
    const evidenceTarget = input.feedback_lowering.target_task_kind === 'literature'
      ? input.feedback_lowering.target_node_id : ids.evidence;
    nodes.push({ node_id: evidenceTarget, kind: 'evidence_set', title: `Requested literature investigation for ${input.objective_title}`, metadata: { role: 'requested_work', accepted_evidence: false } });
  }
  const decisionKind = input.feedback_lowering.decision_kind === 'capture_finding'
    ? 'produces'
    : input.feedback_lowering.decision_kind === 'branch_idea'
      ? 'branches_to'
      : 'backtracks_to';
  const edges: ResearchEdge[] = [
    { edge_id: `edge:${input.run_id}:compute-depends-on-idea`, kind: 'depends_on' as const, from_node_id: ids.compute, to_node_id: ids.idea },
    { edge_id: `edge:${input.run_id}:compute-produces-decision`, kind: 'produces' as const, from_node_id: ids.compute, to_node_id: ids.decision },
    { edge_id: `edge:${input.run_id}:decision-target`, kind: decisionKind, from_node_id: ids.decision, to_node_id: input.feedback_lowering.target_node_id },
  ];
  if (writingSeed) edges.push(...writingSeed.edges);
  if (
    input.feedback_lowering.backtrack_to_node_id
    && input.feedback_lowering.backtrack_to_node_id !== input.feedback_lowering.target_node_id
  ) {
    edges.push({
      edge_id: `edge:${input.run_id}:decision-backtrack`,
      kind: 'backtracks_to',
      from_node_id: ids.decision,
      to_node_id: input.feedback_lowering.backtrack_to_node_id,
    });
  }
  return createResearchWorkspace({ workspace_id: `workspace:${input.run_id}`, primary_question_id: ids.question, nodes, edges });
}

function taskMetadata(input: FeedbackAuthorityInput): Record<string, unknown> {
  return {
    result_ref: makeRunArtifactUri(input.run_id, 'artifacts/computation_result_v1.json'),
    manifest_ref: input.manifest_ref.uri,
    feedback_signal: input.feedback_lowering.signal,
    feedback_basis: 'producer_declaration',
    priority_change: input.feedback_lowering.priority_change,
    prune_candidate: input.feedback_lowering.prune_candidate,
  };
}

function snapshot(runtime: ResearchLoopRuntime): WorkspaceFeedback {
  const state = runtime.getState();
  return { policy_mode: state.policy.mode, workspace: state.workspace, tasks: state.tasks, events: state.events, handoffs: state.handoffs, active_task_ids: state.active_task_ids };
}

function feedbackTaskInput(input: FeedbackAuthorityInput): ResearchTaskInput {
  return {
    kind: input.feedback_lowering.target_task_kind,
    title: taskTitle(input),
    target_node_id: input.feedback_lowering.target_node_id,
    source: 'system',
    actor_id: null,
    metadata: {
      ...taskMetadata(input),
      produced_artifact_refs: input.produced_artifact_refs.map(ref => ref.uri),
      reason: feedbackReason(input),
    },
  };
}

function feedbackHandoff(input: FeedbackAuthorityInput, sourceTaskId: string): FeedbackHandoff {
  return {
    handoff_id: shortId(),
    handoff_kind: 'feedback',
    workspace_id: `workspace:${input.run_id}`,
    source_task_id: sourceTaskId,
    target_node_id: input.feedback_lowering.target_node_id,
    source: 'system',
    actor_id: null,
    created_at: utcNowIso(),
    payload: {
      disposition: input.feedback_lowering.decision_kind as FeedbackHandoff['payload']['disposition'],
      feedback_signal: input.feedback_lowering.signal,
      priority_change: input.feedback_lowering.priority_change,
      prune_candidate: input.feedback_lowering.prune_candidate,
      reason: feedbackReason(input),
      ...(input.feedback_lowering.backtrack_to_task_kind ? { backtrack_to_task_kind: input.feedback_lowering.backtrack_to_task_kind } : {}),
    },
  };
}

function deriveDeclaredFeedbackState(
  input: FeedbackAuthorityInput,
  writingSeed?: WritingFollowupWorkspaceSeed,
): { workspaceFeedback: WorkspaceFeedback; nextActions: NextAction[] } {
  const ids = loopNodeIdsFor(input.run_id);
  const runtime = new ResearchLoopRuntime({ workspace: buildWorkspace(input, writingSeed), policy: interactiveResearchLoopPolicy() });
  const computeTask = runtime.injectTask({
    kind: 'compute',
    title: `Execute approved computation for ${input.objective_title}`,
    target_node_id: ids.compute,
    source: 'system',
    actor_id: null,
    metadata: { ...taskMetadata(input), step_ids: [...input.executor_provenance.step_ids] },
  });
  runtime.transitionTask(computeTask.task_id, 'active', { source: 'system', actor_id: null });
  runtime.transitionTask(computeTask.task_id, input.execution_status === 'failed' ? 'blocked' : 'completed', { source: 'system', actor_id: null });
  const taskInput = feedbackTaskInput(input);
  if (input.feedback_lowering.target_task_kind === 'idea' || input.feedback_lowering.target_task_kind === 'literature') {
    const handoff = feedbackHandoff(input, computeTask.task_id);
    const followupTask = runtime.appendDelegatedTask({ handoff, task: taskInput });
    attachDelegatedFollowupTeamExecutionMetadata(followupTask, handoff);
    return {
      workspaceFeedback: snapshot(runtime),
      nextActions: [{
        action_kind: input.feedback_lowering.decision_kind,
        task_kind: input.feedback_lowering.target_task_kind,
        title: followupTask.title,
        target_node_id: followupTask.target_node_id,
        reason: feedbackReason(input),
        handoff_kind: 'feedback',
      }],
    };
  }
  const followupTask = runtime.spawnFollowupTask(computeTask.task_id, taskInput);
  appendWritingFollowups(runtime, input.run_id, followupTask.task_id, writingSeed);
  return {
    workspaceFeedback: snapshot(runtime),
    nextActions: [{
      action_kind: input.feedback_lowering.decision_kind,
      task_kind: input.feedback_lowering.target_task_kind,
      title: followupTask.title,
      target_node_id: followupTask.target_node_id,
      reason: feedbackReason(input),
    }],
  };
}

/** Preserve execution history without inventing an idea, finding or research decision. */
export function deriveNextIdeaLoopState(
  input: ExecutionFeedbackInput,
  writingSeed?: WritingFollowupWorkspaceSeed,
): { workspaceFeedback: WorkspaceFeedback; nextActions: NextAction[] } {
  if (input.feedback_lowering) {
    return deriveDeclaredFeedbackState({ ...input, feedback_lowering: input.feedback_lowering }, writingSeed);
  }
  const ids = loopNodeIdsFor(input.run_id);
  const workspace = createResearchWorkspace({
    workspace_id: `workspace:${input.run_id}`,
    primary_question_id: ids.question,
    nodes: [
      { node_id: ids.question, kind: 'question', title: input.objective_title },
      { node_id: ids.compute, kind: 'compute_attempt', title: `Computation for ${input.objective_title}` },
    ],
    edges: [{ edge_id: `edge:${input.run_id}:compute-question`, kind: 'depends_on', from_node_id: ids.compute, to_node_id: ids.question }],
  });
  const runtime = new ResearchLoopRuntime({ workspace, policy: interactiveResearchLoopPolicy() });
  const task = runtime.injectTask({
    kind: 'compute', title: `Execute computation for ${input.objective_title}`,
    target_node_id: ids.compute, source: 'system', actor_id: null,
    metadata: {
      result_ref: makeRunArtifactUri(input.run_id, 'artifacts/computation_result_v1.json'),
      manifest_ref: input.manifest_ref.uri,
      step_ids: [...input.executor_provenance.step_ids],
      execution_status: input.execution_status,
    },
  });
  runtime.transitionTask(task.task_id, 'active', { source: 'system', actor_id: null });
  runtime.transitionTask(task.task_id, input.execution_status === 'completed' ? 'completed' : 'blocked', { source: 'system', actor_id: null });
  return { workspaceFeedback: snapshot(runtime), nextActions: [] };
}
