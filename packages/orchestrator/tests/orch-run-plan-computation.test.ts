import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { handleToolCall, stageIdeaArtifactsIntoRun } from '../src/index.js';

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
      thesis_statement: 'Generic staged planning should compile a domain-owned run directory through orch_run_plan_computation.',
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

describe('orch_run_plan_computation tool', () => {
  it('compiles staged idea artifacts from a domain-owned run directory', async () => {
    const projectRoot = makeTmpDir('orch-plan-project-');
    const runDir = makeTmpDir('orch-plan-run-');
    CLEANUP_DIRS.push(projectRoot, runDir);

    stageIdeaArtifactsIntoRun({
      handoffRecord: makeHandoff(),
      handoffUri: path.join(runDir, 'source-handoff.json'),
      runDir,
    });

    const result = await handleToolCall(
      'orch_run_plan_computation',
      {
        project_root: projectRoot,
        run_id: 'run-001',
        run_dir: runDir,
        dry_run: true,
      },
      'full',
    );

    const payload = extractPayload(result);
    expect(payload.status).toBe('dry_run');
    expect(payload.execution_plan_path).toBe('computation/execution_plan_v1.json');
    expect(payload.manifest_path).toBe('computation/manifest.json');
    expect(payload.task_ids).toEqual(['task_001']);
  });
});
