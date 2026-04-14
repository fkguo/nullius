import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputationResultV1 } from '@autoresearch/shared';
import {
  progressDelegatedComputationFollowups,
  type DelegatedComputationFollowupLaunchResult,
  type DelegatedComputationFollowupTask,
  stageContentInRunDir,
} from '../src/computation/index.js';
import { makeRunArtifactUri } from '../src/computation/artifact-refs.js';
import { cleanupRegisteredDirs, makeTmpDir, registerCleanup } from './executeManifestTestUtils.js';

afterEach(() => {
  cleanupRegisteredDirs();
});

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function delegatedFollowupTask(params: {
  taskId: string;
  kind: 'draft_update' | 'review';
  sourceTaskId?: string | null;
}): Record<string, unknown> {
  return {
    task_id: params.taskId,
    kind: params.kind,
    status: 'pending',
    title: `${params.kind}-${params.taskId}`,
    target_node_id: null,
    parent_task_id: null,
    metadata: {
      team_execution: {
        workspace_id: 'workspace:test',
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        coordination_policy: 'supervised_delegate',
        handoff_id: `${params.taskId}-handoff`,
        handoff_kind: params.kind === 'draft_update' ? 'writing' : 'review',
        checkpoint_id: null,
        research_task_ref: {
          task_id: params.taskId,
          task_kind: params.kind,
          target_node_id: null,
          parent_task_id: null,
          workspace_id: 'workspace:test',
          handoff_id: `${params.taskId}-handoff`,
          handoff_kind: params.kind === 'draft_update' ? 'writing' : 'review',
          source_task_id: params.sourceTaskId ?? null,
        },
      },
    },
  };
}

function delegatedComputationResult(
  runId: string,
  tasks: Record<string, unknown>[],
  followupBridgeRefs: Array<{ uri: string; sha256: string; kind?: string }> = [],
): ComputationResultV1 {
  return {
    schema_version: 'computation_result_v1',
    manifest_sha256: 'sha256-test',
    run_id: runId,
    project_id: 'proj-test',
    status: 'completed',
    started_at: '2026-03-13T00:00:00Z',
    completed_at: '2026-03-13T00:00:01Z',
    steps: [],
    outputs: [],
    followup_bridge_refs: followupBridgeRefs,
    workspace_feedback: {
      notes: [],
      tasks: tasks as ComputationResultV1['workspace_feedback']['tasks'],
      handoffs: [],
    },
  };
}

describe('delegated followup progression', () => {
  it('keeps review blocked when draft is already active and no delegated task is selectable', async () => {
    const projectRoot = makeTmpDir('orch-followup-progression-');
    registerCleanup(projectRoot);
    const runId = 'run-active-draft';
    writeJson(path.join(projectRoot, 'artifacts', 'runs', runId, 'team-execution-state.json'), {
      delegate_assignments: [
        { assignment_id: 'assign-draft-1', task_id: 'draft-1', status: 'running' },
      ],
      active_assignment_ids: ['assign-draft-1'],
    });

    const launchTask = vi.fn();
    const launched = await progressDelegatedComputationFollowups({
      computationResult: delegatedComputationResult(runId, [
        delegatedFollowupTask({ taskId: 'draft-1', kind: 'draft_update' }),
        delegatedFollowupTask({ taskId: 'review-1', kind: 'review', sourceTaskId: 'draft-1' }),
      ]),
      projectRoot,
      runId,
      runDir: path.join(projectRoot, 'run-active-draft'),
      launchTask: launchTask as never,
    });

    expect(launched).toEqual({ status: 'skipped_no_pending_task' });
    expect(launchTask).not.toHaveBeenCalled();
  });

  it('keeps review blocked when upstream draft linkage is missing', async () => {
    const projectRoot = makeTmpDir('orch-followup-progression-');
    registerCleanup(projectRoot);

    const launchTask = vi.fn();
    const launched = await progressDelegatedComputationFollowups({
      computationResult: delegatedComputationResult('run-review-missing-link', [
        delegatedFollowupTask({ taskId: 'review-1', kind: 'review', sourceTaskId: null }),
      ]),
      projectRoot,
      runId: 'run-review-missing-link',
      runDir: path.join(projectRoot, 'run-review-missing-link'),
      launchTask: launchTask as never,
    });

    expect(launched).toEqual({ status: 'skipped_no_pending_task' });
    expect(launchTask).not.toHaveBeenCalled();
  });

  it('performs one bounded reselection and launches review after a just-completed draft_update', async () => {
    const projectRoot = makeTmpDir('orch-followup-progression-');
    registerCleanup(projectRoot);
    const runId = 'run-review-reselection';
    const runDir = path.join(projectRoot, runId);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    const reviewBridgeUri = makeRunArtifactUri(runId, 'artifacts/review_followup_bridge_v1.json');
    writeJson(path.join(runDir, 'artifacts', 'review_followup_bridge_v1.json'), {
      schema_version: 1,
      bridge_kind: 'review',
      run_id: runId,
      objective_title: 'Review reselection bridge',
      feedback_signal: 'success',
      decision_kind: 'capture_finding',
      summary: 'summary',
      computation_result_uri: makeRunArtifactUri(runId, 'artifacts/computation_result_v1.json'),
      manifest_ref: { uri: makeRunArtifactUri(runId, 'computation/manifest.json'), sha256: 'manifest-sha' },
      produced_artifact_refs: [],
      target: {
        task_kind: 'review',
        title: 'Review refreshed draft',
        target_node_id: 'review-node',
        suggested_content_type: 'reviewer_report',
        seed_payload: {
          computation_result_uri: makeRunArtifactUri(runId, 'artifacts/computation_result_v1.json'),
          manifest_uri: makeRunArtifactUri(runId, 'computation/manifest.json'),
          summary: 'summary',
          produced_artifact_uris: [],
          issue_node_id: 'review-node',
          target_draft_node_id: 'draft-node',
          source_artifact_name: 'staged_reviewer_report_mid.json',
          source_content_type: 'reviewer_report',
        },
      },
      handoff: {
        handoff_kind: 'review',
        target_node_id: 'review-node',
        payload: {
          issue_node_id: 'review-node',
          target_draft_node_id: 'draft-node',
        },
      },
      context: {
        draft_context_mode: 'existing_draft',
        draft_source_artifact_name: 'staged_section_output_old.json',
        draft_source_content_type: 'section_output',
        review_source_artifact_name: 'staged_reviewer_report_mid.json',
        review_source_content_type: 'reviewer_report',
      },
    });

    let callCount = 0;
    const launchTask = vi.fn(async ({ task }): Promise<{
      launchResult: DelegatedComputationFollowupLaunchResult;
      teamState: { delegate_assignments: Array<Record<string, unknown>> } | null;
    }> => {
      callCount += 1;
      if (callCount === 1) {
        expect((task as DelegatedComputationFollowupTask).kind).toBe('draft_update');
        writeJson(path.join(runDir, 'artifacts', 'staged_section_output_draft-1.json'), {
          version: 1,
          staged_at: '2026-03-13T00:00:10Z',
          content_type: 'section_output',
          content: '{"title":"draft 1"}',
          task_ref: {
            task_id: 'draft-1',
            task_kind: 'draft_update',
          },
        });
        return {
          launchResult: {
            status: 'launched',
            task_id: 'draft-1',
            task_kind: 'draft_update',
            assignment_id: 'assign-draft-1',
          },
          teamState: {
            delegate_assignments: [
              { assignment_id: 'assign-draft-1', task_id: 'draft-1', task_kind: 'draft_update', status: 'completed' },
            ],
          },
        };
      }
      expect((task as DelegatedComputationFollowupTask).kind).toBe('review');
      return {
        launchResult: {
          status: 'launched',
          task_id: 'review-1',
          task_kind: 'review',
          assignment_id: 'assign-review-1',
        },
        teamState: {
          delegate_assignments: [
            { assignment_id: 'assign-draft-1', task_id: 'draft-1', task_kind: 'draft_update', status: 'completed' },
            { assignment_id: 'assign-review-1', task_id: 'review-1', task_kind: 'review', status: 'running' },
          ],
        },
      };
    });

    const launched = await progressDelegatedComputationFollowups({
      computationResult: delegatedComputationResult(runId, [
        delegatedFollowupTask({ taskId: 'draft-1', kind: 'draft_update' }),
        delegatedFollowupTask({ taskId: 'review-1', kind: 'review', sourceTaskId: 'draft-1' }),
      ], [
        { uri: reviewBridgeUri, sha256: 'old-review-bridge', kind: 'writing_review_bridge' },
      ]),
      projectRoot,
      runId,
      runDir,
      launchTask,
    });

    expect(callCount).toBe(2);
    expect(launched).toMatchObject({
      status: 'launched',
      task_id: 'review-1',
      task_kind: 'review',
      assignment_id: 'assign-review-1',
    });
  });

  it('refreshes the review bridge to the newest staged draft while preserving persisted node linkage', async () => {
    const projectRoot = makeTmpDir('orch-followup-progression-');
    registerCleanup(projectRoot);
    const runId = 'run-review-refresh';
    const runDir = path.join(projectRoot, runId);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });

    writeJson(path.join(runDir, 'artifacts', 'staged_section_output_zzz-old.json'), {
      version: 1,
      staged_at: '2026-03-13T00:00:00Z',
      content_type: 'section_output',
      content: '{"title":"old draft"}',
      task_ref: {
        task_id: 'draft-1',
        task_kind: 'draft_update',
      },
    });
    writeJson(path.join(runDir, 'artifacts', 'staged_reviewer_report_mid.json'), {
      version: 1,
      staged_at: '2026-03-13T00:00:01Z',
      content_type: 'reviewer_report',
      content: '{"title":"old review"}',
    });
    const reviewBridgeUri = makeRunArtifactUri(runId, 'artifacts/review_followup_bridge_v1.json');
    writeJson(path.join(runDir, 'artifacts', 'review_followup_bridge_v1.json'), {
      schema_version: 1,
      bridge_kind: 'review',
      run_id: runId,
      objective_title: 'Refresh review bridge',
      feedback_signal: 'success',
      decision_kind: 'capture_finding',
      summary: 'summary',
      computation_result_uri: makeRunArtifactUri(runId, 'artifacts/computation_result_v1.json'),
      manifest_ref: { uri: makeRunArtifactUri(runId, 'computation/manifest.json'), sha256: 'manifest-sha' },
      produced_artifact_refs: [],
      target: {
        task_kind: 'review',
        title: 'Review refreshed draft',
        target_node_id: 'review-node',
        suggested_content_type: 'reviewer_report',
        seed_payload: {
          computation_result_uri: makeRunArtifactUri(runId, 'artifacts/computation_result_v1.json'),
          manifest_uri: makeRunArtifactUri(runId, 'computation/manifest.json'),
          summary: 'summary',
          produced_artifact_uris: [],
          issue_node_id: 'review-node',
          target_draft_node_id: 'draft-node',
          source_artifact_name: 'staged_reviewer_report_mid.json',
          source_content_type: 'reviewer_report',
        },
      },
      handoff: {
        handoff_kind: 'review',
        target_node_id: 'review-node',
        payload: {
          issue_node_id: 'review-node',
          target_draft_node_id: 'draft-node',
        },
      },
      context: {
        draft_context_mode: 'existing_draft',
        draft_source_artifact_name: 'staged_section_output_zzz-old.json',
        draft_source_content_type: 'section_output',
        review_source_artifact_name: 'staged_reviewer_report_mid.json',
        review_source_content_type: 'reviewer_report',
      },
    });

    const computationResult = delegatedComputationResult(runId, [
      {
        ...delegatedFollowupTask({ taskId: 'draft-1', kind: 'draft_update' }),
        target_node_id: 'draft-node',
      },
      {
        ...delegatedFollowupTask({ taskId: 'review-1', kind: 'review', sourceTaskId: 'draft-1' }),
        target_node_id: 'review-node',
      },
    ], [
      { uri: reviewBridgeUri, sha256: 'old-review-bridge', kind: 'writing_review_bridge' },
    ]);
    writeJson(path.join(runDir, 'artifacts', 'computation_result_v1.json'), computationResult);

    let callCount = 0;
    const launchTask = vi.fn(async ({ task }): Promise<{
      launchResult: DelegatedComputationFollowupLaunchResult;
      teamState: { delegate_assignments: Array<Record<string, unknown>> } | null;
    }> => {
      callCount += 1;
      if (callCount === 1) {
        writeJson(path.join(runDir, 'artifacts', 'staged_section_output_aaa-new.json'), {
          version: 1,
          staged_at: '2026-03-13T00:00:10Z',
          content_type: 'section_output',
          content: '{"title":"new draft"}',
          task_ref: {
            task_id: 'draft-1',
            task_kind: 'draft_update',
          },
        });
        writeJson(path.join(runDir, 'artifacts', 'staged_section_output_other-task.json'), {
          version: 1,
          staged_at: '2026-03-13T00:00:20Z',
          content_type: 'section_output',
          content: '{"title":"other draft"}',
          task_ref: {
            task_id: 'draft-2',
            task_kind: 'draft_update',
          },
        });
        return {
          launchResult: {
            status: 'launched',
            task_id: 'draft-1',
            task_kind: 'draft_update',
            assignment_id: 'assign-draft-1',
          },
          teamState: {
            delegate_assignments: [
              { assignment_id: 'assign-draft-1', task_id: 'draft-1', task_kind: 'draft_update', status: 'completed' },
            ],
          },
        };
      }
      return {
        launchResult: {
          status: 'launched',
          task_id: 'review-1',
          task_kind: 'review',
          assignment_id: 'assign-review-1',
        },
        teamState: {
          delegate_assignments: [
            { assignment_id: 'assign-draft-1', task_id: 'draft-1', task_kind: 'draft_update', status: 'completed' },
            { assignment_id: 'assign-review-1', task_id: 'review-1', task_kind: 'review', status: 'running' },
          ],
        },
      };
    });

    const launched = await progressDelegatedComputationFollowups({
      computationResult,
      projectRoot,
      runId,
      runDir,
      launchTask,
    });

    expect(launched).toMatchObject({
      status: 'launched',
      task_id: 'review-1',
      task_kind: 'review',
    });
    const refreshedBridge = JSON.parse(
      fs.readFileSync(path.join(runDir, 'artifacts', 'review_followup_bridge_v1.json'), 'utf-8'),
    ) as {
      target: {
        target_node_id: string;
        seed_payload: {
          source_artifact_name?: string;
          source_content_type?: string;
          target_draft_node_id?: string;
        };
      };
      handoff: { target_node_id: string; payload: { issue_node_id?: string; target_draft_node_id?: string } };
      context: { draft_source_artifact_name?: string };
    };
    expect(refreshedBridge.context.draft_source_artifact_name).toBe('staged_section_output_aaa-new.json');
    expect(refreshedBridge.target.seed_payload.source_artifact_name).toBe('staged_section_output_aaa-new.json');
    expect(refreshedBridge.target.seed_payload.source_content_type).toBe('section_output');
    expect(refreshedBridge.target.target_node_id).toBe('review-node');
    expect(refreshedBridge.handoff.target_node_id).toBe('review-node');
    expect(refreshedBridge.handoff.payload.issue_node_id).toBe('review-node');
    expect(refreshedBridge.handoff.payload.target_draft_node_id).toBe('draft-node');
    expect(computationResult.followup_bridge_refs[0]?.sha256).not.toBe('old-review-bridge');
  });

  it('fails closed when the upstream draft completes without a matching task-scoped staged output', async () => {
    const projectRoot = makeTmpDir('orch-followup-progression-');
    registerCleanup(projectRoot);
    const runId = 'run-review-missing-task-output';
    const runDir = path.join(projectRoot, runId);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });

    const launchTask = vi.fn(async ({ task }): Promise<{
      launchResult: DelegatedComputationFollowupLaunchResult;
      teamState: { delegate_assignments: Array<Record<string, unknown>> } | null;
    }> => {
      if ((task as DelegatedComputationFollowupTask).kind === 'draft_update') {
        writeJson(path.join(runDir, 'artifacts', 'staged_section_output_other-task.json'), {
          version: 1,
          staged_at: '2026-03-13T00:00:20Z',
          content_type: 'section_output',
          content: '{"title":"other draft"}',
          task_ref: {
            task_id: 'draft-other',
            task_kind: 'draft_update',
          },
        });
        return {
          launchResult: {
            status: 'launched',
            task_id: 'draft-1',
            task_kind: 'draft_update',
            assignment_id: 'assign-draft-1',
          },
          teamState: {
            delegate_assignments: [
              { assignment_id: 'assign-draft-1', task_id: 'draft-1', task_kind: 'draft_update', status: 'completed' },
            ],
          },
        };
      }
      throw new Error('review should not launch without a matching task-scoped output');
    });

    const launched = await progressDelegatedComputationFollowups({
      computationResult: delegatedComputationResult(runId, [
        delegatedFollowupTask({ taskId: 'draft-1', kind: 'draft_update' }),
        delegatedFollowupTask({ taskId: 'review-1', kind: 'review', sourceTaskId: 'draft-1' }),
      ]),
      projectRoot,
      runId,
      runDir,
      launchTask,
    });

    expect(launchTask).toHaveBeenCalledTimes(1);
    expect(launched).toMatchObject({
      status: 'skipped_missing_task_scoped_output',
      task_id: 'review-1',
      task_kind: 'review',
    });
  });

  it('blocks review launch when refreshed review verification truth is decisively failed', async () => {
    const projectRoot = makeTmpDir('orch-followup-progression-');
    registerCleanup(projectRoot);
    const runId = 'run-review-gate-blocked';
    const runDir = path.join(projectRoot, runId);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });

    const reviewBridgeUri = makeRunArtifactUri(runId, 'artifacts/review_followup_bridge_v1.json');
    const subjectUri = makeRunArtifactUri(runId, 'artifacts/verification_subject_computation_result_v1.json');
    const verdictUri = makeRunArtifactUri(runId, 'artifacts/verification_subject_verdict_computation_result_v1.json');
    const coverageUri = makeRunArtifactUri(runId, 'artifacts/verification_coverage_v1.json');

    writeJson(path.join(runDir, 'artifacts', 'verification_subject_computation_result_v1.json'), {
      schema_version: 1,
      subject_id: `result:${runId}:computation_result`,
      subject_kind: 'result',
      run_id: runId,
      title: 'Blocked result',
      source_refs: [{ uri: makeRunArtifactUri(runId, 'artifacts/computation_result_v1.json'), sha256: 'a'.repeat(64) }],
    });
    writeJson(path.join(runDir, 'artifacts', 'verification_subject_verdict_computation_result_v1.json'), {
      schema_version: 1,
      verdict_id: `verdict:${runId}:computation_result`,
      run_id: runId,
      subject_id: `result:${runId}:computation_result`,
      subject_ref: { uri: subjectUri, sha256: 'b'.repeat(64) },
      status: 'failed',
      summary: 'Decisive verification found a mismatch.',
      check_run_refs: [{ uri: makeRunArtifactUri(runId, 'artifacts/verification_check_run_result.json'), sha256: 'c'.repeat(64) }],
      missing_decisive_checks: [],
    });
    writeJson(path.join(runDir, 'artifacts', 'verification_coverage_v1.json'), {
      schema_version: 1,
      coverage_id: `coverage:${runId}:computation_result`,
      run_id: runId,
      generated_at: '2026-03-13T00:00:20Z',
      subject_refs: [{ uri: subjectUri, sha256: 'b'.repeat(64) }],
      subject_verdict_refs: [{ uri: verdictUri, sha256: 'd'.repeat(64) }],
      summary: {
        subjects_total: 1,
        subjects_verified: 0,
        subjects_partial: 0,
        subjects_failed: 1,
        subjects_blocked: 0,
        subjects_not_attempted: 0,
      },
      missing_decisive_checks: [],
    });
    writeJson(path.join(runDir, 'artifacts', 'review_followup_bridge_v1.json'), {
      schema_version: 1,
      bridge_kind: 'review',
      run_id: runId,
      objective_title: 'Review gate block',
      feedback_signal: 'success',
      decision_kind: 'capture_finding',
      summary: 'Review should be blocked by verification truth.',
      computation_result_uri: makeRunArtifactUri(runId, 'artifacts/computation_result_v1.json'),
      manifest_ref: { uri: makeRunArtifactUri(runId, 'computation/manifest.json'), sha256: 'e'.repeat(64) },
      produced_artifact_refs: [{ uri: makeRunArtifactUri(runId, 'artifacts/out.json'), sha256: 'f'.repeat(64) }],
      verification_refs: {
        subject_refs: [{ uri: subjectUri, sha256: 'b'.repeat(64) }],
        subject_verdict_refs: [{ uri: verdictUri, sha256: 'd'.repeat(64) }],
        coverage_refs: [{ uri: coverageUri, sha256: 'g'.repeat(64) }],
      },
      target: {
        task_kind: 'review',
        title: 'Review draft',
        target_node_id: 'review-node',
        suggested_content_type: 'reviewer_report',
        seed_payload: {
          computation_result_uri: makeRunArtifactUri(runId, 'artifacts/computation_result_v1.json'),
          manifest_uri: makeRunArtifactUri(runId, 'computation/manifest.json'),
          summary: 'Review should be blocked by verification truth.',
          produced_artifact_uris: [makeRunArtifactUri(runId, 'artifacts/out.json')],
          issue_node_id: 'review-node',
          target_draft_node_id: 'draft-node',
          source_artifact_name: 'staged_section_output_draft-1.json',
          source_content_type: 'section_output',
        },
      },
      handoff: {
        handoff_kind: 'review',
        target_node_id: 'review-node',
        payload: {
          issue_node_id: 'review-node',
          target_draft_node_id: 'draft-node',
        },
      },
      context: {
        draft_context_mode: 'existing_draft',
        draft_source_artifact_name: 'staged_section_output_draft-1.json',
        draft_source_content_type: 'section_output',
      },
    });

    const launchTask = vi.fn(async ({ task }): Promise<{
      launchResult: DelegatedComputationFollowupLaunchResult;
      teamState: { delegate_assignments: Array<Record<string, unknown>> } | null;
    }> => {
      if ((task as DelegatedComputationFollowupTask).kind === 'draft_update') {
        stageContentInRunDir({
          runId,
          runDir,
          contentType: 'section_output',
          content: '{"title":"draft"}',
          artifactSuffix: 'draft-1',
          taskId: 'draft-1',
          taskKind: 'draft_update',
        });
        return {
          launchResult: {
            status: 'launched',
            task_id: 'draft-1',
            task_kind: 'draft_update',
            assignment_id: 'assign-draft-1',
          },
          teamState: {
            delegate_assignments: [
              { assignment_id: 'assign-draft-1', task_id: 'draft-1', task_kind: 'draft_update', status: 'completed' },
            ],
          },
        };
      }
      throw new Error('review should be blocked by gate');
    });

    const launched = await progressDelegatedComputationFollowups({
      computationResult: delegatedComputationResult(runId, [
        delegatedFollowupTask({ taskId: 'draft-1', kind: 'draft_update' }),
        delegatedFollowupTask({ taskId: 'review-1', kind: 'review', sourceTaskId: 'draft-1' }),
      ], [
        { uri: reviewBridgeUri, sha256: 'old-review-bridge', kind: 'writing_review_bridge' },
      ]),
      projectRoot,
      runId,
      runDir,
      launchTask,
    });

    expect(launchTask).toHaveBeenCalledTimes(1);
    expect(launched).toMatchObject({
      status: 'blocked_by_gate',
      task_id: 'review-1',
      task_kind: 'review',
    });
    expect(String(launched.error)).toContain('Decisive verification found a mismatch');
  });
});
