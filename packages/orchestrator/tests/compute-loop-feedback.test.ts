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
      thesis: 'Deterministic failed execution should lower into idea refinement.',
      claims: [{ claim_text: 'Claim A' }],
      hypotheses: ['Hypothesis A'],
      source_handoff_uri: '/tmp/idea-handoff.json',
    },
    hints: {
      minimal_compute_plan: [{ step: 'Fail the bridge task', method: 'generic execution', estimated_difficulty: 'low' }],
    },
  });
  writeJson(executionPlanArtifactPath(runDir), executionPlan);
  const { manifestPath } = materializeExecutionPlan(runDir, executionPlan);
  return { runDir, manifestPath };
}

describe('compute-loop failure lowering', () => {
  it('writes a failed computation_result_v1 artifact and feedback handoff without emitting a false finding', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-loop-failure';
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createBridgeRun(runId, projectRoot);
    fs.writeFileSync(
      path.join(runDir, 'computation', 'scripts', 'execution_plan_runner.py'),
      "raise SystemExit(1)\n",
      'utf-8',
    );
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const result = await executeComputationManifest({
      manifestPath,
      projectRoot,
      runDir,
      runId,
    });

    expect(result.status).toBe('failed');
    expect(fs.existsSync(result.artifact_paths.computation_result)).toBe(true);
    expect(result.next_actions[0]?.task_kind).toBe('idea');
    expect(result.next_actions[0]?.handoff_kind).toBe('feedback');

    const outcome = JSON.parse(fs.readFileSync(result.artifact_paths.computation_result, 'utf-8')) as {
      execution_status: string;
      failure_reason?: string;
      workspace_feedback: {
        tasks: Array<{ kind: string; status: string }>;
        handoffs: Array<{ handoff_kind: string; payload: { disposition: string } }>;
      };
    };

    expect(outcome.execution_status).toBe('failed');
    expect(outcome.failure_reason).toContain("step 'task_001' exited with code 1");
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'compute' && task.status === 'blocked')).toBe(true);
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'idea' && task.status === 'pending')).toBe(true);
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'finding')).toBe(false);
    expect(outcome.workspace_feedback.handoffs).toHaveLength(1);
    expect(outcome.workspace_feedback.handoffs[0]?.handoff_kind).toBe('feedback');
    expect(outcome.workspace_feedback.handoffs[0]?.payload.disposition).toBe('refine_idea');
  });
});
