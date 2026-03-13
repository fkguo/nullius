import type { ComputationResultV1 } from '@autoresearch/shared';

export type FeedbackLowering = ComputationResultV1['feedback_lowering'];

export function loopNodeIdsFor(runId: string) {
  return {
    question: `question:${runId}`,
    idea: `idea:${runId}`,
    evidence: `evidence:${runId}`,
    compute: `compute:${runId}`,
    finding: `finding:${runId}`,
    decision: `decision:${runId}`,
  };
}

export function deriveFeedbackLowering(params: {
  runId: string;
  executionStatus: ComputationResultV1['execution_status'];
  signal: FeedbackLowering['signal'];
}): FeedbackLowering {
  const ids = loopNodeIdsFor(params.runId);
  if (params.executionStatus === 'failed') {
    return {
      signal: params.signal,
      decision_kind: 'downgrade_idea',
      priority_change: 'lower',
      prune_candidate: true,
      target_task_kind: 'idea',
      target_node_id: ids.idea,
      handoff_kind: 'feedback',
      backtrack_to_task_kind: 'idea',
      backtrack_to_node_id: ids.idea,
    };
  }
  if (params.signal === 'weak_signal') {
    return {
      signal: params.signal,
      decision_kind: 'branch_idea',
      priority_change: 'keep',
      prune_candidate: false,
      target_task_kind: 'idea',
      target_node_id: `idea-branch:${params.runId}`,
      handoff_kind: 'feedback',
      backtrack_to_task_kind: 'idea',
      backtrack_to_node_id: ids.idea,
    };
  }
  return {
    signal: params.signal,
    decision_kind: 'capture_finding',
    priority_change: 'raise',
    prune_candidate: false,
    target_task_kind: 'finding',
    target_node_id: ids.finding,
  };
}
