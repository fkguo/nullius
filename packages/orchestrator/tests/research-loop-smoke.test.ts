import { describe, expect, it } from 'vitest';

import {
  ResearchLoopRuntime,
  autonomousResearchLoopPolicy,
  createResearchWorkspace,
} from '../src/index.js';

function makeWorkspace() {
  return createResearchWorkspace({
    workspace_id: 'ws-smoke-01',
    primary_question_id: 'question-1',
    nodes: [
      { node_id: 'question-1', kind: 'question', title: 'Question' },
      { node_id: 'idea-1', kind: 'idea', title: 'Idea' },
      { node_id: 'evidence-1', kind: 'evidence_set', title: 'Evidence' },
      { node_id: 'compute-1', kind: 'compute_attempt', title: 'Compute' },
      { node_id: 'finding-1', kind: 'finding', title: 'Finding' },
      { node_id: 'draft-1', kind: 'draft_section', title: 'Draft' },
      { node_id: 'review-1', kind: 'review_issue', title: 'Review issue' },
      { node_id: 'decision-1', kind: 'decision', title: 'Decision' },
    ],
    edges: [
      { edge_id: 'edge-1', kind: 'supports', from_node_id: 'evidence-1', to_node_id: 'idea-1' },
      { edge_id: 'edge-2', kind: 'produces', from_node_id: 'compute-1', to_node_id: 'finding-1' },
      { edge_id: 'edge-3', kind: 'revises', from_node_id: 'review-1', to_node_id: 'draft-1' },
    ],
  });
}

describe('research-loop smoke paths', () => {
  it('supports a minimal nonlinear path: literature -> idea -> compute -> literature -> finding -> draft_update -> review', () => {
    const runtime = new ResearchLoopRuntime({ workspace: makeWorkspace(), policy: autonomousResearchLoopPolicy() });

    const literature = runtime.injectTask({ kind: 'literature', title: 'Survey literature', target_node_id: 'evidence-1', source: 'user', actor_id: 'pi' });
    runtime.transitionTask(literature.task_id, 'completed', { source: 'user', actor_id: 'pi' });
    const idea = runtime.spawnFollowupTask(literature.task_id, { kind: 'idea', title: 'Refine idea', target_node_id: 'idea-1', source: 'agent', actor_id: 'planner' });
    runtime.transitionTask(idea.task_id, 'completed', { source: 'agent', actor_id: 'planner' });
    const compute = runtime.spawnFollowupTask(idea.task_id, { kind: 'compute', title: 'Run compute', target_node_id: 'compute-1', source: 'agent', actor_id: 'worker' });
    runtime.transitionTask(compute.task_id, 'completed', { source: 'agent', actor_id: 'worker' });

    const literatureBacktrack = runtime.spawnFollowupTask(compute.task_id, {
      kind: 'literature',
      title: 'Backtrack for more evidence',
      target_node_id: 'evidence-1',
      source: 'system',
      actor_id: null,
    });
    runtime.transitionTask(literatureBacktrack.task_id, 'completed', { source: 'system', actor_id: null });

    const finding = runtime.spawnFollowupTask(compute.task_id, { kind: 'finding', title: 'Capture finding', target_node_id: 'finding-1', source: 'agent', actor_id: 'worker' });
    runtime.transitionTask(finding.task_id, 'completed', { source: 'agent', actor_id: 'worker' });
    const draftUpdate = runtime.spawnFollowupTask(finding.task_id, { kind: 'draft_update', title: 'Update draft', target_node_id: 'draft-1', source: 'agent', actor_id: 'writer' });
    runtime.transitionTask(draftUpdate.task_id, 'completed', { source: 'agent', actor_id: 'writer' });
    const review = runtime.spawnFollowupTask(draftUpdate.task_id, { kind: 'review', title: 'Review draft', target_node_id: 'review-1', source: 'user', actor_id: 'pi' });

    expect(review.kind).toBe('review');
    expect(runtime.getState().events.length).toBeGreaterThanOrEqual(12);
    expect(runtime.getState().packet.gate_conditions.filter((condition) => condition.condition_kind === 'handoff_registered').map((condition) => condition.handoff_kind)).toEqual(
      expect.arrayContaining(['compute', 'feedback', 'writing', 'review']),
    );
    expect(runtime.getState().packet.stop_conditions).toContainEqual({ condition_kind: 'no_active_tasks' });
  });

  it('provides compute and feedback handoff smoke paths through the delegated-task seam', () => {
    const runtime = new ResearchLoopRuntime({ workspace: makeWorkspace(), policy: autonomousResearchLoopPolicy() });

    const seedIdea = runtime.injectTask({ kind: 'idea', title: 'Seed idea', target_node_id: 'idea-1', source: 'user', actor_id: 'pi' });
    runtime.transitionTask(seedIdea.task_id, 'completed', { source: 'user', actor_id: 'pi' });

    const computeTask = runtime.appendDelegatedTask({
      handoff: {
        handoff_id: 'handoff-compute',
        handoff_kind: 'compute',
        workspace_id: 'ws-smoke-01',
        source_task_id: seedIdea.task_id,
        target_node_id: 'compute-1',
        source: 'agent',
        actor_id: 'compute-worker',
        created_at: '2026-03-07T00:00:00Z',
        payload: { hypothesis_node_ids: ['idea-1'], expected_artifacts: ['result.json'] },
      },
      task: { kind: 'compute', title: 'Delegated compute', target_node_id: 'compute-1', source: 'agent', actor_id: 'compute-worker' },
    });
    runtime.transitionTask(computeTask.task_id, 'completed', { source: 'agent', actor_id: 'compute-worker' });

    const feedbackTask = runtime.appendDelegatedTask({
      handoff: {
        handoff_id: 'handoff-feedback',
        handoff_kind: 'feedback',
        workspace_id: 'ws-smoke-01',
        source_task_id: computeTask.task_id,
        target_node_id: 'idea-1',
        source: 'agent',
        actor_id: null,
        created_at: '2026-03-07T00:00:01Z',
        payload: {
          disposition: 'refine_idea',
          feedback_signal: 'failure',
          priority_change: 'lower',
          prune_candidate: true,
          reason: 'Execution failed and the idea should be downgraded for rework.',
          backtrack_to_task_kind: 'idea',
          related_finding_node_id: 'finding-1',
        },
      },
      task: { kind: 'idea', title: 'Feedback into idea loop', target_node_id: 'idea-1', source: 'agent', actor_id: null },
    });

    expect(runtime.getState().handoffs).toHaveLength(2);
    expect(feedbackTask.kind).toBe('idea');
    expect(runtime.getState().events.filter((event) => event.event_type === 'handoff_registered')).toHaveLength(2);
  });
});
