import { describe, expect, it } from 'vitest';

import {
  ResearchLoopRuntime,
  createResearchWorkspace,
  interactiveResearchLoopPolicy,
  autonomousResearchLoopPolicy,
} from '../src/index.js';

function makeWorkspace() {
  return createResearchWorkspace({
    workspace_id: 'ws-runtime-01',
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
    ],
  });
}

describe('research-loop runtime', () => {
  it('tracks active tasks via event-driven transitions and rejects illegal status changes', () => {
    const runtime = new ResearchLoopRuntime({ workspace: makeWorkspace(), policy: interactiveResearchLoopPolicy() });
    const task = runtime.createTask({ kind: 'literature', title: 'Read papers', target_node_id: 'evidence-1', source: 'user', actor_id: 'pi' });

    expect(runtime.getState().active_task_ids).toEqual([]);
    runtime.transitionTask(task.task_id, 'active', { source: 'user', actor_id: 'pi' });
    expect(runtime.getState().active_task_ids).toEqual([task.task_id]);

    runtime.transitionTask(task.task_id, 'completed', { source: 'user', actor_id: 'pi' });
    expect(runtime.getState().active_task_ids).toEqual([]);
    expect(runtime.getState().events.at(-1)?.event_type).toBe('task_status_changed');

    expect(() => runtime.transitionTask(task.task_id, 'active', { source: 'user', actor_id: 'pi' })).toThrow(/invalid task transition/i);
  });

  it('models valid backtracks and rejects illegal follow-up task kinds', () => {
    const runtime = new ResearchLoopRuntime({ workspace: makeWorkspace(), policy: interactiveResearchLoopPolicy() });
    const computeTask = runtime.createTask({ kind: 'compute', title: 'Run compute', target_node_id: 'compute-1', source: 'agent', actor_id: 'worker' });
    runtime.transitionTask(computeTask.task_id, 'active', { source: 'agent', actor_id: 'worker' });
    runtime.transitionTask(computeTask.task_id, 'completed', { source: 'agent', actor_id: 'worker' });

    const literatureBacktrack = runtime.spawnFollowupTask(computeTask.task_id, {
      kind: 'literature',
      title: 'Backtrack to literature',
      target_node_id: 'evidence-1',
      source: 'system',
      actor_id: null,
    });
    const ideaBacktrack = runtime.spawnFollowupTask(computeTask.task_id, {
      kind: 'idea',
      title: 'Backtrack to idea',
      target_node_id: 'idea-1',
      source: 'system',
      actor_id: null,
    });

    expect(literatureBacktrack.parent_task_id).toBe(computeTask.task_id);
    expect(ideaBacktrack.parent_task_id).toBe(computeTask.task_id);

    const reviewTask = runtime.createTask({ kind: 'review', title: 'Review draft', target_node_id: 'review-1', source: 'user', actor_id: 'pi' });
    runtime.transitionTask(reviewTask.task_id, 'active', { source: 'user', actor_id: 'pi' });
    runtime.transitionTask(reviewTask.task_id, 'completed', { source: 'user', actor_id: 'pi' });
    const evidenceSearch = runtime.spawnFollowupTask(reviewTask.task_id, {
      kind: 'evidence_search',
      title: 'Search evidence for review issue',
      target_node_id: 'evidence-1',
      source: 'system',
      actor_id: null,
    });
    expect(evidenceSearch.kind).toBe('evidence_search');

    expect(() => runtime.spawnFollowupTask(reviewTask.task_id, {
      kind: 'compute',
      title: 'Illegal compute retry from review',
      target_node_id: 'compute-1',
      source: 'system',
      actor_id: null,
    })).toThrow(/invalid follow-up/i);
  });

  it('shares one substrate across interactive and autonomous modes; policy alone changes injection behavior', () => {
    const workspace = makeWorkspace();
    const interactive = new ResearchLoopRuntime({ workspace, policy: interactiveResearchLoopPolicy() });
    const autonomous = new ResearchLoopRuntime({ workspace, policy: autonomousResearchLoopPolicy() });

    const interactiveTask = interactive.injectTask({ kind: 'idea', title: 'Manual idea refinement', target_node_id: 'idea-1', source: 'user', actor_id: 'pi' });
    const autonomousTask = autonomous.injectTask({ kind: 'idea', title: 'Auto idea refinement', target_node_id: 'idea-1', source: 'system', actor_id: null });

    expect(interactiveTask.status).toBe('pending');
    expect(autonomousTask.status).toBe('active');
    expect(Object.keys(interactive.getState()).sort()).toEqual(Object.keys(autonomous.getState()).sort());
    expect(interactive.getState().workspace.workspace_id).toBe(autonomous.getState().workspace.workspace_id);
  });

  it('creates and restores checkpoints without forking the event-log state format', () => {
    const runtime = new ResearchLoopRuntime({ workspace: makeWorkspace(), policy: autonomousResearchLoopPolicy() });
    const task = runtime.injectTask({ kind: 'idea', title: 'Auto idea refinement', target_node_id: 'idea-1', source: 'system', actor_id: null });
    const checkpoint = runtime.createCheckpoint({ source: 'system', actor_id: null, label: 'before-complete' });

    runtime.transitionTask(task.task_id, 'completed', { source: 'system', actor_id: null });
    expect(runtime.getState().active_task_ids).toEqual([]);

    runtime.restoreCheckpoint(checkpoint.checkpoint_id, { source: 'system', actor_id: null });
    expect(runtime.getState().active_task_ids).toEqual([task.task_id]);
    expect(runtime.getState().events.at(-1)?.event_type).toBe('checkpoint_restored');
  });

  it('records delegated injection without mutating the workspace graph', () => {
    const runtime = new ResearchLoopRuntime({ workspace: makeWorkspace(), policy: interactiveResearchLoopPolicy() });
    const nodeCount = runtime.getState().workspace.nodes.length;
    runtime.appendDelegatedTask({
      task: { kind: 'draft_update', title: 'Patch the draft', target_node_id: 'draft-1', source: 'agent', actor_id: 'writer' },
    });

    expect(runtime.getState().workspace.nodes).toHaveLength(nodeCount);
    expect(runtime.getState().events.at(-1)?.event_type).toBe('task_injected');
  });

  it('records interventions as structured substrate events', () => {
    const runtime = new ResearchLoopRuntime({ workspace: makeWorkspace(), policy: interactiveResearchLoopPolicy() });
    const intervention = runtime.recordIntervention({
      intervention_kind: 'inject_task',
      source: 'user',
      actor_id: 'pi',
      payload: { reason: 'manual override' },
    });

    expect(runtime.getState().interventions).toHaveLength(1);
    expect(intervention.intervention_kind).toBe('inject_task');
    expect(runtime.getState().events.at(-1)?.event_type).toBe('intervention_recorded');
  });
});
