import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractPayload,
  makeCompletedExecutionResult,
  makeTmpDir,
  writeCompletedExecutionFixture,
} from './executeManifestContractTestSupport.js';

const executeComputationManifest = vi.fn();

vi.mock('@autoresearch/orchestrator', async importOriginal => {
  const actual = await importOriginal<typeof import('@autoresearch/orchestrator')>();
  return {
    ...actual,
    executeComputationManifest,
  };
});

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  executeComputationManifest.mockReset();
  while (CLEANUP_DIRS.length > 0) {
    fs.rmSync(CLEANUP_DIRS.pop()!, { recursive: true, force: true });
  }
});

describe('hep_run_execute_manifest invalid delegated launch contract', () => {
  it('reports invalid delegated team metadata while keeping the completed execution payload intact', async () => {
    const tmpDir = makeTmpDir('execute-manifest-invalid-launch-');
    CLEANUP_DIRS.push(tmpDir);
    process.env.HEP_DATA_DIR = tmpDir;

    const runId = 'run-adapter-3';
    const runDir = path.join(tmpDir, 'runs', runId);
    const artifactPath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
    writeCompletedExecutionFixture(runDir, artifactPath, {
      tasks: [{
        task_id: 'task-bad-team',
        kind: 'draft_update',
        title: 'Revise the draft',
        target_node_id: 'finding:run-adapter-3',
        source: 'system',
        actor_id: null,
        status: 'pending',
        parent_task_id: null,
        created_at: '2026-03-12T00:00:00Z',
        updated_at: '2026-03-12T00:00:00Z',
        metadata: {
          team_execution: {
            workspace_id: 'workspace:run-adapter-3',
            owner_role: 'lead',
            delegate_role: 'delegate',
            delegate_id: 'delegate-1',
            coordination_policy: 'sequential',
            handoff_id: 'handoff-writing-1',
            handoff_kind: 'writing',
            checkpoint_id: null,
          },
        },
      }],
      handoffs: [],
    }, runId);

    executeComputationManifest.mockResolvedValue(makeCompletedExecutionResult(runId, runDir, artifactPath, 'c', 'd'));

    const { handleToolCall } = await import('../../src/tools/index.js');
    const result = await handleToolCall(
      'hep_run_execute_manifest',
      {
        _confirm: true,
        project_root: '/tmp/project-root',
        run_id: runId,
        manifest_path: 'computation/manifest.json',
      },
      'full',
    );

    const payload = extractPayload(result);
    expect(payload.status).toBe('completed');
    expect(payload.summary).toBe('completed');
    expect(payload.delegated_launch).toMatchObject({
      status: 'skipped_invalid_team_execution',
      task_id: 'task-bad-team',
      task_kind: 'draft_update',
    });
  });

  it('returns skipped_no_pending_task when the completed result has no delegated follow-up tasks', async () => {
    const tmpDir = makeTmpDir('execute-manifest-invalid-launch-');
    CLEANUP_DIRS.push(tmpDir);
    process.env.HEP_DATA_DIR = tmpDir;

    const runId = 'run-no-followup';
    const runDir = path.join(tmpDir, 'runs', runId);
    const artifactPath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
    writeCompletedExecutionFixture(runDir, artifactPath, { tasks: [], handoffs: [] }, runId);

    executeComputationManifest.mockResolvedValue(makeCompletedExecutionResult(runId, runDir, artifactPath, 'e', 'f'));

    const { handleToolCall } = await import('../../src/tools/index.js');
    const payload = extractPayload(await handleToolCall(
      'hep_run_execute_manifest',
      { _confirm: true, project_root: '/tmp/project-root', run_id: runId, manifest_path: 'computation/manifest.json' },
      'full',
    ));

    expect(payload.status).toBe('completed');
    expect(payload.delegated_launch).toEqual({ status: 'skipped_no_pending_task' });
  });

  it('returns launch_failed and preserves string tool errors from the delegated runtime path', async () => {
    const tmpDir = makeTmpDir('execute-manifest-invalid-launch-');
    CLEANUP_DIRS.push(tmpDir);
    process.env.HEP_DATA_DIR = tmpDir;

    const runId = 'run-launch-failed';
    const runDir = path.join(tmpDir, 'runs', runId);
    const artifactPath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
    writeCompletedExecutionFixture(runDir, artifactPath, {
      tasks: [{
        task_id: 'task-launch-failed',
        kind: 'draft_update',
        title: 'Revise the draft',
        target_node_id: 'finding:run-launch-failed',
        source: 'system',
        actor_id: null,
        status: 'pending',
        parent_task_id: null,
        created_at: '2026-03-12T00:00:00Z',
        updated_at: '2026-03-12T00:00:00Z',
        metadata: {
          team_execution: {
            workspace_id: 'workspace:run-launch-failed',
            owner_role: 'lead',
            delegate_role: 'delegate',
            delegate_id: 'delegate-1',
            coordination_policy: 'supervised_delegate',
            research_task_ref: {
              task_id: 'task-launch-failed',
              task_kind: 'draft_update',
              target_node_id: 'finding:run-launch-failed',
              parent_task_id: null,
              workspace_id: 'workspace:run-launch-failed',
              handoff_id: 'handoff-writing-1',
              handoff_kind: 'writing',
              source_task_id: 'task-finding',
            },
            handoff_id: 'handoff-writing-1',
            handoff_kind: 'writing',
            checkpoint_id: null,
          },
        },
      }],
      handoffs: [],
    }, runId);

    executeComputationManifest.mockResolvedValue(makeCompletedExecutionResult(runId, runDir, artifactPath, '1', '2'));

    const { executeManifest } = await import('../../src/tools/execute-manifest.js');
    const payload = await executeManifest(
      { _confirm: true, project_root: '/tmp/project-root', run_id: runId, manifest_path: 'computation/manifest.json' },
      {
        createMessage: async () => ({ model: 'unused', role: 'assistant', content: [], stopReason: 'end_turn' }),
        callTool: async () => ({
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'delegate runtime exploded' }) }],
        }),
      },
    ) as {
      status: string;
      delegated_launch: { status: string; task_id: string; task_kind: string; error: string };
    };

    expect(payload.status).toBe('completed');
    expect(payload.delegated_launch).toMatchObject({
      status: 'launch_failed',
      task_id: 'task-launch-failed',
      task_kind: 'draft_update',
      error: 'delegate runtime exploded',
    });
  });
});
