import { describe, expect, it } from 'vitest';

import {
  createResearchWorkspace,
  type ComputeHandoff,
  type FeedbackHandoff,
  type LiteratureHandoff,
  type ResearchWorkspace,
  type ReviewHandoff,
  type WritingHandoff,
} from '../src/index.js';

function makeWorkspace(): ResearchWorkspace {
  return createResearchWorkspace({
    workspace_id: 'ws-loop-01',
    primary_question_id: 'question-1',
    nodes: [
      { node_id: 'question-1', kind: 'question', title: 'Primary question' },
      { node_id: 'idea-1', kind: 'idea', title: 'Candidate idea' },
      { node_id: 'evidence-1', kind: 'evidence_set', title: 'Evidence set' },
      { node_id: 'compute-1', kind: 'compute_attempt', title: 'Compute attempt' },
      { node_id: 'finding-1', kind: 'finding', title: 'Finding' },
      { node_id: 'draft-1', kind: 'draft_section', title: 'Draft section' },
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

describe('research-loop workspace types', () => {
  it('builds a valid workspace graph with the documented node kinds', () => {
    const workspace = makeWorkspace();
    expect(workspace.primary_question_id).toBe('question-1');
    expect(workspace.nodes.map((node) => node.kind)).toEqual([
      'question',
      'idea',
      'evidence_set',
      'compute_attempt',
      'finding',
      'draft_section',
      'review_issue',
      'decision',
    ]);
  });

  it('fails closed on missing node references and invalid primary question', () => {
    expect(() =>
      createResearchWorkspace({
        workspace_id: 'broken',
        primary_question_id: 'missing-question',
        nodes: [{ node_id: 'idea-1', kind: 'idea', title: 'Idea only' }],
        edges: [],
      }),
    ).toThrow(/primary_question_id/i);

    expect(() =>
      createResearchWorkspace({
        workspace_id: 'broken-edge',
        primary_question_id: 'question-1',
        nodes: [{ node_id: 'question-1', kind: 'question', title: 'Question' }],
        edges: [{ edge_id: 'edge-1', kind: 'supports', from_node_id: 'question-1', to_node_id: 'missing' }],
      }),
    ).toThrow(/missing node reference/i);
  });

  it('keeps typed handoff stubs aligned for compute, feedback, literature, review, and writing seams', () => {
    const computeHandoff: ComputeHandoff = {
      handoff_id: 'handoff-compute',
      handoff_kind: 'compute',
      workspace_id: 'ws-loop-01',
      source_task_id: 'task-idea',
      target_node_id: 'compute-1',
      source: 'agent',
      actor_id: 'compute-worker',
      created_at: '2026-03-07T00:00:00Z',
      payload: { hypothesis_node_ids: ['idea-1'], expected_artifacts: ['amplitude.json'] },
    };
    const feedbackHandoff: FeedbackHandoff = {
      handoff_id: 'handoff-feedback',
      handoff_kind: 'feedback',
      workspace_id: 'ws-loop-01',
      source_task_id: 'task-compute',
      target_node_id: 'idea-1',
      source: 'agent',
      actor_id: null,
      created_at: '2026-03-07T00:00:01Z',
      payload: {
        disposition: 'branch_idea',
        feedback_signal: 'weak_signal',
        priority_change: 'keep',
        prune_candidate: false,
        reason: 'Completed execution produced only weak support and should branch the idea.',
        backtrack_to_task_kind: 'idea',
        related_finding_node_id: 'finding-1',
      },
    };
    const literatureHandoff: LiteratureHandoff = {
      handoff_id: 'handoff-literature',
      handoff_kind: 'literature',
      workspace_id: 'ws-loop-01',
      source_task_id: 'task-review',
      target_node_id: 'evidence-1',
      source: 'system',
      actor_id: null,
      created_at: '2026-03-07T00:00:02Z',
      payload: { query: 'targeted evidence refresh', reason: 'review_followup' },
    };
    const reviewHandoff: ReviewHandoff = {
      handoff_id: 'handoff-review',
      handoff_kind: 'review',
      workspace_id: 'ws-loop-01',
      source_task_id: 'task-draft',
      target_node_id: 'review-1',
      source: 'user',
      actor_id: 'pi',
      created_at: '2026-03-07T00:00:03Z',
      payload: { issue_node_id: 'review-1', target_draft_node_id: 'draft-1' },
    };
    const writingHandoff: WritingHandoff = {
      handoff_id: 'handoff-writing',
      handoff_kind: 'writing',
      workspace_id: 'ws-loop-01',
      source_task_id: 'task-finding',
      target_node_id: 'draft-1',
      source: 'agent',
      actor_id: 'writer',
      created_at: '2026-03-07T00:00:04Z',
      payload: { draft_node_id: 'draft-1', finding_node_ids: ['finding-1'] },
    };

    expect(computeHandoff.payload.expected_artifacts).toContain('amplitude.json');
    expect(feedbackHandoff.payload.disposition).toBe('branch_idea');
    expect(feedbackHandoff.payload.feedback_signal).toBe('weak_signal');
    expect(feedbackHandoff.payload.priority_change).toBe('keep');
    expect(literatureHandoff.payload.reason).toBe('review_followup');
    expect(reviewHandoff.source).toBe('user');
    expect(writingHandoff.actor_id).toBe('writer');
  });
});
