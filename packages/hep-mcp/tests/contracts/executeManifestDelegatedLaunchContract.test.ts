import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { StateManager } from '@autoresearch/orchestrator';
import { createFromIdea } from '../../src/tools/create-from-idea.js';
import { handleToolCall } from '../../src/tools/index.js';
import { extractPayload, makeTmpDir } from './executeManifestContractTestSupport.js';

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function makeHandoff(): Record<string, unknown> {
  return {
    campaign_id: '00000000-0000-0000-0000-000000000101',
    node_id: '00000000-0000-0000-0000-000000000102',
    idea_id: '00000000-0000-0000-0000-000000000103',
    promoted_at: '2026-03-13T00:00:00Z',
    idea_card: {
      thesis_statement: 'Computation completion should auto-launch the first pending delegated writing task.',
      testable_hypotheses: ['Hypothesis A'],
      required_observables: ['observable_a'],
      minimal_compute_plan: [
        { step: 'Execute the staged bridge task', method: 'generic execution', estimated_difficulty: 'low' },
      ],
      claims: [{ claim_text: 'Claim A', support_type: 'literature', evidence_uris: ['https://inspirehep.net/literature/1'] }],
    },
    grounding_audit: {
      status: 'pass',
      folklore_risk_score: 0.1,
      failures: [],
      timestamp: '2026-03-13T00:00:00Z',
    },
  };
}

async function stageExistingDraftAndReview(runId: string): Promise<void> {
  await handleToolCall('hep_run_stage_content', { run_id: runId, content_type: 'section_output', content: 'existing draft seed' }, 'full');
  await handleToolCall('hep_run_stage_content', { run_id: runId, content_type: 'reviewer_report', content: 'existing review seed' }, 'full');
}

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  delete process.env.HEP_DATA_DIR;
  while (CLEANUP_DIRS.length > 0) {
    fs.rmSync(CLEANUP_DIRS.pop()!, { recursive: true, force: true });
  }
});

describe('hep_run_execute_manifest delegated launch contract', () => {
  it('auto-launches the first pending draft_update assignment through the bounded team runtime', async () => {
    const hepDataDir = makeTmpDir('hep-delegated-launch-');
    const projectRoot = makeTmpDir('orch-delegated-launch-');
    CLEANUP_DIRS.push(hepDataDir, projectRoot);
    process.env.HEP_DATA_DIR = hepDataDir;
    fs.mkdirSync(path.join(hepDataDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(hepDataDir, 'runs'), { recursive: true });

    const handoffPath = path.join(hepDataDir, 'idea_handoff_c2_v1.json');
    writeJson(handoffPath, makeHandoff());
    const staged = createFromIdea({ handoff_uri: handoffPath });
    await stageExistingDraftAndReview(staged.run_id);

    const manager = new StateManager(projectRoot);
    manager.createRun(manager.readState(), staged.run_id, 'computation');
    const planPayload = extractPayload(await handleToolCall(
      'hep_run_plan_computation',
      { project_root: projectRoot, run_id: staged.run_id, dry_run: false },
      'full',
    ));
    manager.approveRun(manager.readState(), String(planPayload.approval_id), 'approve for test');

    let samplingCallCount = 0;
    const execPayload = extractPayload(await handleToolCall(
      'hep_run_execute_manifest',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: staged.run_id,
        manifest_path: String(planPayload.manifest_path),
      },
      'full',
      {
        createMessage: async () => {
          samplingCallCount += 1;
          if (samplingCallCount === 1) {
            return {
              model: 'claude-test',
              role: 'assistant',
              content: [{
                type: 'tool_use',
                id: 'tu_stage',
                name: 'hep_run_stage_content',
                input: { run_id: staged.run_id, content_type: 'section_output', content: 'delegated draft update' },
              }],
              stopReason: 'tool_use',
            };
          }
          throw new Error('interrupt after checkpoint');
        },
      },
    )) as {
      status: string;
      delegated_launch: { status: string; task_kind: string; team_state_path: string };
    };

    expect(execPayload.status).toBe('completed');
    expect(execPayload.delegated_launch.status).toBe('launched');
    expect(execPayload.delegated_launch.task_kind).toBe('draft_update');
    expect(fs.existsSync(execPayload.delegated_launch.team_state_path)).toBe(true);

    const teamState = JSON.parse(fs.readFileSync(execPayload.delegated_launch.team_state_path, 'utf-8')) as {
      delegate_assignments: Array<{ task_kind: string }>;
    };
    expect(teamState.delegate_assignments).toHaveLength(1);
    expect(teamState.delegate_assignments[0]?.task_kind).toBe('draft_update');
    expect(teamState.delegate_assignments.some(assignment => assignment.task_kind === 'review')).toBe(false);
  });

  it('keeps approved execution successful and reports a bounded skip when host sampling support is unavailable', async () => {
    const hepDataDir = makeTmpDir('hep-delegated-launch-');
    const projectRoot = makeTmpDir('orch-delegated-launch-');
    CLEANUP_DIRS.push(hepDataDir, projectRoot);
    process.env.HEP_DATA_DIR = hepDataDir;
    fs.mkdirSync(path.join(hepDataDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(hepDataDir, 'runs'), { recursive: true });

    const handoffPath = path.join(hepDataDir, 'idea_handoff_c2_v1.json');
    writeJson(handoffPath, makeHandoff());
    const staged = createFromIdea({ handoff_uri: handoffPath });
    await stageExistingDraftAndReview(staged.run_id);

    const manager = new StateManager(projectRoot);
    manager.createRun(manager.readState(), staged.run_id, 'computation');
    const planPayload = extractPayload(await handleToolCall(
      'hep_run_plan_computation',
      { project_root: projectRoot, run_id: staged.run_id, dry_run: false },
      'full',
    ));
    manager.approveRun(manager.readState(), String(planPayload.approval_id), 'approve for test');

    const execPayload = extractPayload(await handleToolCall(
      'hep_run_execute_manifest',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: staged.run_id,
        manifest_path: String(planPayload.manifest_path),
      },
      'full',
    )) as {
      status: string;
      delegated_launch: { status: string; task_kind: string };
    };

    expect(execPayload.status).toBe('completed');
    expect(execPayload.delegated_launch.status).toBe('skipped_missing_host_context');
    expect(execPayload.delegated_launch.task_kind).toBe('draft_update');
  });
});
