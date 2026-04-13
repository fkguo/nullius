import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { handleToolCall } from '../src/tooling.js';

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function extractPayload(res: unknown): Record<string, unknown> {
  const result = res as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function makeHandoff(): Record<string, unknown> {
  return {
    campaign_id: '11111111-1111-4111-8111-111111111111',
    node_id: '22222222-2222-4222-8222-222222222222',
    idea_id: '33333333-3333-4333-8333-333333333333',
    promoted_at: '2026-03-13T00:00:00Z',
    idea_card: {
      thesis_statement: 'Compile staged idea surfaces into an audited execution plan before any compute approval.',
      testable_hypotheses: ['Hypothesis A'],
      required_observables: ['observable_a'],
      minimal_compute_plan: [
        { step: 'Derive a consistency relation', method: 'structured derivation', estimated_difficulty: 'moderate' },
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

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  while (CLEANUP_DIRS.length > 0) {
    fs.rmSync(CLEANUP_DIRS.pop()!, { recursive: true, force: true });
  }
});

describe('orch_run_plan_computation', () => {
  it('stages a handoff into a run directory and plans computation through the generic orchestrator tools', async () => {
    const projectRoot = makeTmpDir('orch-plan-project-');
    const runDir = makeTmpDir('orch-plan-run-');
    const handoffDir = makeTmpDir('orch-plan-handoff-');
    const handoffPath = path.join(handoffDir, 'idea_handoff_c2_v1.json');
    CLEANUP_DIRS.push(projectRoot, runDir, handoffDir);

    writeJson(handoffPath, makeHandoff());

    const staged = extractPayload(await handleToolCall(
      'orch_run_stage_idea',
      {
        run_id: 'run-plan-001',
        run_dir: runDir,
        handoff_path: handoffPath,
      },
      'full',
    ));

    expect(staged).toMatchObject({
      status: 'staged',
      run_id: 'run-plan-001',
      outline_seed_path: 'artifacts/outline_seed_v1.json',
      hints_snapshot_path: 'artifacts/idea_handoff_hints_v1.json',
      next_actions: [
        {
          tool: 'orch_run_plan_computation',
        },
      ],
    });

    const planned = extractPayload(await handleToolCall(
      'orch_run_plan_computation',
      {
        project_root: projectRoot,
        run_id: 'run-plan-001',
        run_dir: runDir,
        dry_run: true,
      },
      'full',
    ));

    expect(planned).toMatchObject({
      status: 'dry_run',
      execution_plan_path: 'computation/execution_plan_v1.json',
      manifest_path: 'computation/manifest.json',
      task_ids: ['task_001'],
    });
  });
});
