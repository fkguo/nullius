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

function createProviderBackedRun(runId: string, projectRoot: string) {
  const runDir = path.join(projectRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const executionPlan = compileExecutionPlan(runId, {
    outline_seed_path: 'artifacts/outline_seed_v1.json',
    outline: {
      thesis: 'Provider-backed approved execution should remain the canonical public capability truth.',
      claims: [{ claim_text: 'Claim A' }],
      hypotheses: ['Hypothesis A'],
      source_handoff_uri: '/tmp/provider-backed-handoff.json',
    },
    hints: {
      minimal_compute_plan: [{ step: 'Execute the provider-backed task', method: 'provider execution', estimated_difficulty: 'low' }],
    },
  });
  writeJson(executionPlanArtifactPath(runDir), executionPlan);
  const { manifestPath } = materializeExecutionPlan(runDir, executionPlan, {
    methodSpec: {
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
  });
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
      objective_title: string;
      feedback_lowering: {
        signal: string;
        decision_kind: string;
        priority_change: string;
        prune_candidate: boolean;
      };
      execution_status: string;
      summary: string;
      produced_artifact_refs: Array<{ uri: string }>;
      workspace_feedback: {
        workspace: { nodes: Array<{ kind: string }>; edges: Array<{ kind: string; to_node_id: string }> };
        tasks: Array<{ kind: string; status: string }>;
        handoffs: unknown[];
        events: Array<{ event_type: string }>;
      };
    };

    expect(outcome.objective_title).toContain('Deterministic minimal approved execution');
    expect(outcome.feedback_lowering.signal).toBe('success');
    expect(outcome.feedback_lowering.decision_kind).toBe('capture_finding');
    expect(outcome.feedback_lowering.priority_change).toBe('raise');
    expect(outcome.feedback_lowering.prune_candidate).toBe(false);
    expect(outcome.execution_status).toBe('completed');
    expect(outcome.summary).toContain('Approved execution completed');
    expect(outcome.produced_artifact_refs.some(ref => ref.uri.includes('execution_status.json'))).toBe(true);
    expect(outcome.workspace_feedback.workspace.nodes.some(node => node.kind === 'decision')).toBe(true);
    expect(outcome.workspace_feedback.workspace.edges.some(edge => edge.kind === 'produces' && edge.to_node_id === `finding:${runId}`)).toBe(true);
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'compute' && task.status === 'completed')).toBe(true);
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'finding' && task.status === 'pending')).toBe(true);
    expect(outcome.workspace_feedback.handoffs).toHaveLength(0);
    expect(outcome.workspace_feedback.events.some(event => event.event_type === 'task_followup_created')).toBe(true);
  });

  it('treats a staged provider-backed execution bundle as the canonical public execution path', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-provider-backed-success';
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createProviderBackedRun(runId, projectRoot);
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const result = await executeComputationManifest({
      manifestPath,
      projectRoot,
      runDir,
      runId,
    });

    expect(result.status).toBe('completed');
    expect(fs.existsSync(path.join(runDir, 'computation', 'results', 'provider_result.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'computation', 'scripts', 'execution_plan_runner.py'))).toBe(false);

    const outcome = JSON.parse(fs.readFileSync(result.artifact_paths.computation_result, 'utf-8')) as {
      objective_title: string;
      summary: string;
      execution_status: string;
      produced_artifact_refs: Array<{ uri: string }>;
    };
    expect(outcome.objective_title).toContain('Provider-backed approved execution');
    expect(outcome.summary).toContain('Approved execution completed');
    expect(outcome.execution_status).toBe('completed');
    expect(outcome.produced_artifact_refs.some(ref => ref.uri.includes('provider_result.json'))).toBe(true);
  });
});
