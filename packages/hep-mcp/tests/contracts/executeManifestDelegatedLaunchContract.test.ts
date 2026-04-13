import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { StateManager, handleToolCall as handleOrchToolCall } from '@autoresearch/orchestrator';
import { createFromIdea } from '../../src/tools/create-from-idea.js';
import { handleToolCall } from '../../src/tools/index.js';
import { extractPayload, makeTmpDir } from './executeManifestContractTestSupport.js';

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function makeHandoff(): Record<string, unknown> {
  return {
    campaign_id: '11111111-1111-4111-8111-111111111111',
    node_id: '22222222-2222-4222-8222-222222222222',
    idea_id: '33333333-3333-4333-8333-333333333333',
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
  const runDir = path.join(process.env.HEP_DATA_DIR!, 'runs', runId);
  await handleOrchToolCall('orch_run_stage_content', {
    run_id: runId,
    run_dir: runDir,
    content_type: 'section_output',
    content: 'existing draft seed',
  }, 'full');
  await handleOrchToolCall('orch_run_stage_content', {
    run_id: runId,
    run_dir: runDir,
    content_type: 'reviewer_report',
    content: 'existing review seed',
  }, 'full');
}

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  delete process.env.HEP_DATA_DIR;
  while (CLEANUP_DIRS.length > 0) {
    fs.rmSync(CLEANUP_DIRS.pop()!, { recursive: true, force: true });
  }
});

describe('generic execute-manifest surface after hep-mcp migration', () => {
  it('keeps approved execution successful without appending delegated launch policy from hep-mcp', async () => {
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
    const runDir = path.join(hepDataDir, 'runs', staged.run_id);
    const planPayload = extractPayload(await handleOrchToolCall(
      'orch_run_plan_computation',
      { project_root: projectRoot, run_id: staged.run_id, run_dir: runDir, dry_run: false },
      'full',
    ));
    manager.approveRun(manager.readState(), String(planPayload.approval_id), 'approve for test');

    const execPayload = extractPayload(await handleOrchToolCall(
      'orch_run_execute_manifest',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: staged.run_id,
        run_dir: runDir,
        manifest_path: String(planPayload.manifest_path),
      },
      'full',
    )) as {
      status: string;
      next_actions: Array<{ action_kind: string; task_kind: string }>;
      followup_bridge_refs: Array<{ uri: string }>;
    };

    expect(execPayload.status).toBe('completed');
    expect(execPayload.next_actions[0]).toMatchObject({
      action_kind: 'capture_finding',
      task_kind: 'finding',
    });
    expect(execPayload.followup_bridge_refs).toHaveLength(2);
    expect(execPayload).not.toHaveProperty('delegated_launch');
  });
});
