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

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  while (CLEANUP_DIRS.length > 0) {
    fs.rmSync(CLEANUP_DIRS.pop()!, { recursive: true, force: true });
  }
});

describe('orch_run_stage_idea', () => {
  it('stages outline and hints artifacts into an existing run directory', async () => {
    const tmpDir = makeTmpDir('orch-run-stage-idea-');
    CLEANUP_DIRS.push(tmpDir);
    const runDir = path.join(tmpDir, 'domain-run-1');
    const handoffPath = path.join(tmpDir, 'idea_handoff_c2_v1.json');
    writeJson(handoffPath, {
      campaign_id: '11111111-1111-4111-8111-111111111111',
      node_id: '22222222-2222-4222-8222-222222222222',
      idea_id: '33333333-3333-4333-8333-333333333333',
      promoted_at: '2026-03-13T00:00:00Z',
      grounding_audit: {
        status: 'pass',
        folklore_risk_score: 0.1,
        failures: [],
        timestamp: '2026-03-13T00:00:00Z',
      },
      idea_card: {
        thesis_statement: 'Stage an idea into an existing run without provider-owned orchestration policy.',
        claims: [{ claim_text: 'Claim A' }],
        testable_hypotheses: ['Hypothesis A'],
        required_observables: ['observable_a'],
      },
    });

    const res = await handleToolCall('orch_run_stage_idea', {
      run_id: 'run-1',
      run_dir: runDir,
      handoff_path: handoffPath,
    }, 'full');

    const payload = extractPayload(res);
    expect(payload.status).toBe('staged');
    expect(payload.outline_seed_path).toBe('artifacts/outline_seed_v1.json');
    expect(payload.hints_snapshot_path).toBe('artifacts/idea_handoff_hints_v1.json');
    expect((payload.next_actions as Array<{ tool: string }>)[0]?.tool).toBe('orch_run_plan_computation');

    const outlineSeed = JSON.parse(fs.readFileSync(path.join(runDir, 'artifacts', 'outline_seed_v1.json'), 'utf-8')) as {
      source_handoff_uri: string;
      thesis: string;
    };
    expect(outlineSeed.source_handoff_uri).toBe(handoffPath);
    expect(outlineSeed.thesis).toContain('existing run');
  });
});
