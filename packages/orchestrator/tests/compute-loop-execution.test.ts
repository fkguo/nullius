import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { executeComputationManifest } from '../src/computation/index.js';
import { compileExecutionPlan } from '../src/computation/execution-plan.js';
import { executionPlanArtifactPath, materializeExecutionPlan } from '../src/computation/materialize-execution-plan.js';
import {
  cleanupRegisteredDirs,
  initRunState,
  makeTmpDir,
  markA3Satisfied,
  registerCleanup,
  writeJson,
} from './executeManifestTestUtils.js';

afterEach(() => {
  cleanupRegisteredDirs();
});

function createBridgeRun(runId: string, projectRoot: string) {
  const runDir = path.join(projectRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const executionPlan = compileExecutionPlan(runId, {
    outline_seed_path: 'artifacts/outline_seed_v1.json',
    outline: {
      thesis: 'Deterministic minimal approved execution should produce a follow-up finding.',
      claims: [{ claim_text: 'Claim A' }],
      hypotheses: ['Hypothesis A'],
      source_handoff_uri: '/tmp/idea-handoff.json',
    },
    hints: {
      minimal_compute_plan: [{ step: 'Evaluate the bridge task', method: 'generic execution', estimated_difficulty: 'low' }],
    },
  });
  writeJson(executionPlanArtifactPath(runDir), executionPlan);
  const { manifestPath } = materializeExecutionPlan(runDir, executionPlan);
  return { runDir, manifestPath };
}

describe('compute-loop approved execution', () => {
  it('writes a canonical computation_result_v1 artifact and deterministic finding follow-up for bridge-generated manifests', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-loop-success';
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createBridgeRun(runId, projectRoot);
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const result = await executeComputationManifest({
      manifestPath,
      projectRoot,
      runDir,
      runId,
    });

    expect(result.status).toBe('completed');
    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'task_001.json'))).toBe(true);
    expect(fs.existsSync(result.artifact_paths.computation_result)).toBe(true);
    expect(result.next_actions[0]?.task_kind).toBe('finding');
    expect(result.outcome_ref.uri).toBe(`rep://runs/${encodeURIComponent(runId)}/artifact/artifacts%2Fcomputation_result_v1.json`);

    const outcome = JSON.parse(fs.readFileSync(result.artifact_paths.computation_result, 'utf-8')) as {
      execution_status: string;
      summary: string;
      produced_artifact_refs: Array<{ uri: string }>;
      workspace_feedback: { tasks: Array<{ kind: string; status: string }>; handoffs: unknown[]; events: Array<{ event_type: string }> };
    };

    expect(outcome.execution_status).toBe('completed');
    expect(outcome.summary).toContain('Approved execution completed');
    expect(outcome.produced_artifact_refs.some(ref => ref.uri.includes('execution_status.json'))).toBe(true);
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'compute' && task.status === 'completed')).toBe(true);
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'finding' && task.status === 'pending')).toBe(true);
    expect(outcome.workspace_feedback.handoffs).toHaveLength(0);
    expect(outcome.workspace_feedback.events.some(event => event.event_type === 'task_followup_created')).toBe(true);
  });
});
