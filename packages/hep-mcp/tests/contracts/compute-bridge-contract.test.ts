import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { StateManager } from '@autoresearch/orchestrator';
import { createFromIdea } from '../../src/tools/create-from-idea.js';
import { handleToolCall } from '../../src/tools/index.js';

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
    campaign_id: '00000000-0000-0000-0000-000000000001',
    node_id: '00000000-0000-0000-0000-000000000002',
    idea_id: '00000000-0000-0000-0000-000000000003',
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
  delete process.env.HEP_DATA_DIR;
  while (CLEANUP_DIRS.length > 0) {
    fs.rmSync(CLEANUP_DIRS.pop()!, { recursive: true, force: true });
  }
});

describe('compute bridge contract', () => {
  it('surfaces hep_run_plan_computation as the explicit next step after create_from_idea and returns dry_run artifacts', async () => {
    const hepDataDir = makeTmpDir('hep-compute-bridge-');
    const projectRoot = makeTmpDir('orch-compute-bridge-');
    CLEANUP_DIRS.push(hepDataDir, projectRoot);
    process.env.HEP_DATA_DIR = hepDataDir;
    fs.mkdirSync(path.join(hepDataDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(hepDataDir, 'runs'), { recursive: true });

    const handoffPath = path.join(hepDataDir, 'idea_handoff_c2_v1.json');
    writeJson(handoffPath, makeHandoff());

    const staged = createFromIdea({ handoff_uri: handoffPath });
    expect(staged.next_actions.map(action => action.tool)).toContain('hep_run_plan_computation');

    const result = await handleToolCall(
      'hep_run_plan_computation',
      {
        project_root: projectRoot,
        run_id: staged.run_id,
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

  it('returns requires_approval with an A3 packet enriched from execution_plan_v1', async () => {
    const hepDataDir = makeTmpDir('hep-compute-bridge-');
    const projectRoot = makeTmpDir('orch-compute-bridge-');
    CLEANUP_DIRS.push(hepDataDir, projectRoot);
    process.env.HEP_DATA_DIR = hepDataDir;
    fs.mkdirSync(path.join(hepDataDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(hepDataDir, 'runs'), { recursive: true });

    const handoffPath = path.join(hepDataDir, 'idea_handoff_c2_v1.json');
    writeJson(handoffPath, makeHandoff());

    const staged = createFromIdea({ handoff_uri: handoffPath });
    const manager = new StateManager(projectRoot);
    const state = manager.readState();
    manager.createRun(state, staged.run_id, 'computation');

    const result = await handleToolCall(
      'hep_run_plan_computation',
      {
        project_root: projectRoot,
        run_id: staged.run_id,
        dry_run: false,
      },
      'full',
    );

    const payload = extractPayload(result);
    expect(payload.status).toBe('requires_approval');
    expect(payload.gate_id).toBe('A3');

    const packetJsonPath = path.join(projectRoot, String(payload.packet_json_path));
    const packet = JSON.parse(fs.readFileSync(packetJsonPath, 'utf-8')) as { details_md: string };
    expect(packet.details_md).toContain('Bridge objective');
    expect(packet.details_md).toContain('Execution plan tasks:');
  });
});
