import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { handleToolCall, stageIdeaArtifactsIntoRun } from '../src/index.js';
import { StateManager } from '../src/state-manager.js';

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

function makeProviderBackedHandoff(): Record<string, unknown> {
  return {
    ...makeHandoff(),
    idea_card: {
      ...(makeHandoff().idea_card as Record<string, unknown>),
      thesis_statement: 'Provider-backed staged planning should stay on the public orch_* path.',
      method_spec: {
        files: [
          {
            path: 'scripts/write_provider_result.py',
            content: [
              'import json',
              'from pathlib import Path',
              '',
              "Path('results').mkdir(parents=True, exist_ok=True)",
              "Path('results/provider_result.json').write_text(json.dumps({'provider_backed': True}) + '\\n', encoding='utf-8')",
              '',
            ].join('\n'),
          },
        ],
        run_card: {
          schema_version: 2,
          run_id: 'provider-run-card',
          workflow_id: 'computation',
          title: 'Provider-backed execution bundle',
          phases: [
            {
              phase_id: 'provider_phase',
              backend: {
                kind: 'shell',
                argv: ['python3', 'scripts/write_provider_result.py'],
                cwd: '.',
                timeout_seconds: 30,
              },
              outputs: ['results/provider_result.json'],
            },
          ],
        },
      },
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

  it('keeps provider-backed execution on the public orch_* path and leaves the fixture runner as an internal seam', async () => {
    const projectRoot = makeTmpDir('orch-plan-project-');
    const runDir = makeTmpDir('orch-plan-run-');
    CLEANUP_DIRS.push(projectRoot, runDir);

    stageIdeaArtifactsIntoRun({
      handoffRecord: makeProviderBackedHandoff(),
      handoffUri: path.join(runDir, 'source-provider-handoff.json'),
      runDir,
    });

    const manager = new StateManager(projectRoot);
    manager.createRun(manager.readState(), 'run-provider-001', 'computation');

    const planned = extractPayload(await handleToolCall(
      'orch_run_plan_computation',
      {
        project_root: projectRoot,
        run_id: 'run-provider-001',
        run_dir: runDir,
        dry_run: false,
      },
      'full',
    ));

    expect(planned.status).toBe('requires_approval');
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, String(planned.manifest_path)), 'utf-8')) as {
      description?: string;
      entry_point: { script: string; tool: string };
    };
    expect(manifest.description).toContain('Provider-backed execution materialized from staged method_spec.run_card');
    expect(manifest.entry_point).toMatchObject({
      script: 'scripts/write_provider_result.py',
      tool: 'python',
    });
    expect(fs.existsSync(path.join(runDir, 'computation', 'scripts', 'execution_plan_runner.py'))).toBe(false);

    manager.approveRun(manager.readState(), String(planned.approval_id), 'approve provider-backed test');

    const executed = extractPayload(await handleToolCall(
      'orch_run_execute_manifest',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-provider-001',
        run_dir: runDir,
        manifest_path: String(planned.manifest_path),
      },
      'full',
    ));

    expect(executed.status).toBe('completed');
    expect(fs.existsSync(path.join(runDir, 'computation', 'results', 'provider_result.json'))).toBe(true);
  });
});
