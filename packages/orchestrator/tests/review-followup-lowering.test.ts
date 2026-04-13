import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComputationResultV1 } from '@autoresearch/shared';

import { executeComputationManifest } from '../src/computation/index.js';
import { assertComputationResultValid } from '../src/computation/result-schema.js';
import { lowerCompletedReviewFollowup } from '../src/computation/review-followup-lowering.js';
import { stageContentInRunDir } from '../src/computation/staged-content.js';
import { createTeamExecutionState } from '../src/team-execution-state.js';
import { createResearchTaskExecutionRefRegistry, upsertResearchTaskExecutionRef } from '../src/research-task-execution-ref.js';
import { buildResearchTaskExecutionRef } from '../src/research-loop/task-execution-ref.js';
import { createBridgeRun } from './computeLoopWritingReviewBridgeTestSupport.js';
import { initRunState, markA3Satisfied } from './executeManifestTestUtils.js';

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  while (CLEANUP_DIRS.length > 0) {
    fs.rmSync(CLEANUP_DIRS.pop()!, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-followup-lowering-'));
  CLEANUP_DIRS.push(dir);
  return dir;
}

async function prepareRun(projectRoot: string, runId: string): Promise<{
  runDir: string;
  workspaceId: string;
  reviewNodeId: string;
  evidenceNodeId: string;
}> {
  const { runDir, manifestPath } = createBridgeRun(runId, projectRoot);
  stageContentInRunDir({
    runId,
    runDir,
    contentType: 'section_output',
    artifactSuffix: 'draft-seed',
    content: '{"section_number":"1","title":"Draft seed","content":"Seed draft"}',
  });
  stageContentInRunDir({
    runId,
    runDir,
    contentType: 'reviewer_report',
    artifactSuffix: 'review-seed',
    content: '{"summary":"Seed review"}',
  });
  const manager = initRunState(projectRoot, runId);
  markA3Satisfied(manager, 'A3-0001');
  const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
  if (result.status !== 'completed') {
    throw new Error(`expected completed computation result, received ${result.status}`);
  }
  const computationResult = assertComputationResultValid(
    JSON.parse(fs.readFileSync(path.join(runDir, 'artifacts', 'computation_result_v1.json'), 'utf-8')) as ComputationResultV1,
  );
  const reviewNodeId = computationResult.workspace_feedback.workspace.nodes.find(node => node.kind === 'review_issue')?.node_id;
  const evidenceNodeId = computationResult.workspace_feedback.workspace.nodes.find(node => node.kind === 'evidence_set')?.node_id;
  if (!reviewNodeId || !evidenceNodeId) {
    throw new Error('expected computation result workspace to include review_issue and evidence_set nodes');
  }
  return {
    runDir,
    workspaceId: computationResult.workspace_feedback.workspace.workspace_id,
    reviewNodeId,
    evidenceNodeId,
  };
}

function makeReviewState(params: {
  runId: string;
  workspaceId: string;
  reviewNodeId: string;
}) {
  const state = createTeamExecutionState({
    workspace_id: params.workspaceId,
    coordination_policy: 'supervised_delegate',
    permissions: {
      delegation: [{
        from_role: 'lead',
        to_role: 'delegate',
        allowed_task_kinds: ['review', 'evidence_search'],
        allowed_handoff_kinds: ['review', 'literature'],
      }],
      interventions: [],
    },
    assignment: {
      owner_role: 'lead',
      delegate_role: 'delegate',
      delegate_id: 'delegate-1',
      task_id: 'task-review-followup',
      task_kind: 'review',
      handoff_id: 'handoff-review-1',
      handoff_kind: 'review',
      checkpoint_id: null,
    },
  }, params.runId);
  const reviewAssignment = state.delegate_assignments[0]!;
  const registry = createResearchTaskExecutionRefRegistry(params.runId);
  upsertResearchTaskExecutionRef(registry, buildResearchTaskExecutionRef({
    workspace_id: params.workspaceId,
    task_id: 'task-review-followup',
    task_kind: 'review',
    target_node_id: params.reviewNodeId,
    parent_task_id: null,
    handoff_id: 'handoff-review-1',
    handoff_kind: 'review',
    source_task_id: 'task-draft-1',
  }), { assignment_id: reviewAssignment.assignment_id });
  return { state, reviewAssignment, registry };
}

describe('review follow-up lowering', () => {
  it('lowers request_evidence_search into a pending evidence_search assignment', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-lower-review';
    const { runDir, workspaceId, reviewNodeId, evidenceNodeId } = await prepareRun(projectRoot, runId);
    const { state, reviewAssignment, registry } = makeReviewState({ runId, workspaceId, reviewNodeId });
    stageContentInRunDir({
      runId,
      runDir,
      contentType: 'judge_decision',
      artifactSuffix: 'review',
      content: JSON.stringify({
        schema_version: 1,
        disposition: 'request_evidence_search',
        reason: 'Need stronger support.',
        query: 'targeted evidence refresh',
        target_evidence_node_id: evidenceNodeId,
      }),
      taskId: 'task-review-followup',
      taskKind: 'review',
    });

    const lowered = lowerCompletedReviewFollowup({
      runId,
      runDir,
      reviewTaskId: 'task-review-followup',
      reviewAssignmentId: reviewAssignment.assignment_id,
      state,
      taskRefRegistry: registry,
    });

    expect(lowered.disposition).toBe('request_evidence_search');
    expect(lowered.spawned_task_kind).toBe('evidence_search');
    expect(state.delegate_assignments).toHaveLength(2);
    const evidenceAssignment = state.delegate_assignments.find(item => item.task_kind === 'evidence_search')!;
    expect(evidenceAssignment.status).toBe('pending');
    expect(evidenceAssignment.handoff_kind).toBe('literature');
    expect(evidenceAssignment.handoff_payload).toEqual({
      query: 'targeted evidence refresh',
      reason: 'review_followup',
    });
    expect(lowered.taskRefRegistry.refs_by_task_id[evidenceAssignment.task_id]).toMatchObject({
      task_id: evidenceAssignment.task_id,
      task_kind: 'evidence_search',
      source_task_id: 'task-review-followup',
      target_node_id: evidenceNodeId,
    });
    expect(fs.existsSync(path.join(runDir, 'artifacts', lowered.lowering_artifact_name))).toBe(true);
  });

  it('writes an accept lowering artifact without spawning a new assignment', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-lower-accept';
    const { runDir, workspaceId, reviewNodeId } = await prepareRun(projectRoot, runId);
    const { state, reviewAssignment, registry } = makeReviewState({ runId, workspaceId, reviewNodeId });
    stageContentInRunDir({
      runId,
      runDir,
      contentType: 'judge_decision',
      artifactSuffix: 'review',
      content: JSON.stringify({
        schema_version: 1,
        disposition: 'accept',
        reason: 'The current draft is sufficient.',
      }),
      taskId: 'task-review-followup',
      taskKind: 'review',
    });

    const lowered = lowerCompletedReviewFollowup({
      runId,
      runDir,
      reviewTaskId: 'task-review-followup',
      reviewAssignmentId: reviewAssignment.assignment_id,
      state,
      taskRefRegistry: registry,
    });

    expect(lowered.disposition).toBe('accept');
    expect(lowered.spawned_assignment_id).toBeUndefined();
    expect(state.delegate_assignments).toHaveLength(1);
    expect(fs.existsSync(path.join(runDir, 'artifacts', lowered.lowering_artifact_name))).toBe(true);
  });

  it('fails closed on malformed judge_decision content', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-lower-invalid';
    const { runDir, workspaceId, reviewNodeId } = await prepareRun(projectRoot, runId);
    const { state, reviewAssignment, registry } = makeReviewState({ runId, workspaceId, reviewNodeId });
    stageContentInRunDir({
      runId,
      runDir,
      contentType: 'judge_decision',
      artifactSuffix: 'review',
      content: '{"schema_version":1,"disposition":"request_evidence_search","reason":"Need more evidence."}',
      taskId: 'task-review-followup',
      taskKind: 'review',
    });

    expect(() => lowerCompletedReviewFollowup({
      runId,
      runDir,
      reviewTaskId: 'task-review-followup',
      reviewAssignmentId: reviewAssignment.assignment_id,
      state,
      taskRefRegistry: registry,
    })).toThrow(/invalid review judge_decision content/);
  });

  it('does not duplicate the lowered evidence_search assignment when re-entered for the same review task', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-lower-repeat';
    const { runDir, workspaceId, reviewNodeId, evidenceNodeId } = await prepareRun(projectRoot, runId);
    const { state, reviewAssignment, registry } = makeReviewState({ runId, workspaceId, reviewNodeId });
    stageContentInRunDir({
      runId,
      runDir,
      contentType: 'judge_decision',
      artifactSuffix: 'review',
      content: JSON.stringify({
        schema_version: 1,
        disposition: 'request_evidence_search',
        reason: 'Need stronger support.',
        query: 'targeted evidence refresh',
        target_evidence_node_id: evidenceNodeId,
      }),
      taskId: 'task-review-followup',
      taskKind: 'review',
    });

    const first = lowerCompletedReviewFollowup({
      runId,
      runDir,
      reviewTaskId: 'task-review-followup',
      reviewAssignmentId: reviewAssignment.assignment_id,
      state,
      taskRefRegistry: registry,
    });
    const second = lowerCompletedReviewFollowup({
      runId,
      runDir,
      reviewTaskId: 'task-review-followup',
      reviewAssignmentId: reviewAssignment.assignment_id,
      state,
      taskRefRegistry: first.taskRefRegistry,
    });

    expect(state.delegate_assignments.filter(item => item.task_kind === 'evidence_search')).toHaveLength(1);
    expect(second.spawned_assignment_id).toBe(first.spawned_assignment_id);
  });
});
