import * as path from 'node:path';
import { invalidParams, type ComputationManifestV1, type ExecutionPlanV1 } from '@autoresearch/shared';
import { utcNowIso } from '../util.js';
import { sanitizeRelativePath } from './path-safety.js';
import { ensureDir, toPosixRelative, writeJsonAtomic, writeTextAtomic } from './io.js';
import { assertComputationManifestValid } from './manifest.js';

export interface MaterializedExecutionPlan {
  manifestPath: string;
  manifest: ComputationManifestV1;
}

function materializationError(message: string, details: Record<string, unknown> = {}): never {
  throw invalidParams(message, { validation_layer: 'materialization', ...details });
}

function bridgeStubContent(): string {
  return [
    'import argparse',
    'import sys',
    '',
    "parser = argparse.ArgumentParser(description='EVO-01-A bridge execution stub')",
    "parser.add_argument('--task-id', required=True)",
    "parser.add_argument('--execution-plan', required=True)",
    'args = parser.parse_args()',
    '',
    "sys.stderr.write(",
    "    f'Bridge stub for {args.task_id}: real provider execution is out of scope for EVO-01-A.\\n'",
    ')',
    'raise SystemExit(2)',
    '',
  ].join('\n');
}

function topLevelOutputs(plan: ExecutionPlanV1): string[] {
  const seen = new Set<string>();
  const outputs: string[] = [];
  for (const task of plan.tasks) {
    for (const artifact of task.expected_artifacts) {
      const outputPath = sanitizeRelativePath(artifact.path, `tasks.${task.task_id}.expected_artifacts.path`);
      if (!seen.has(outputPath)) {
        outputs.push(outputPath);
        seen.add(outputPath);
      }
    }
  }
  return outputs;
}

export function materializeExecutionPlan(runDir: string, executionPlan: ExecutionPlanV1): MaterializedExecutionPlan {
  if (executionPlan.tasks.length === 0) {
    materializationError('execution_plan_v1 must contain at least one task before materialization');
  }
  const computationDir = path.join(runDir, 'computation');
  const scriptsDir = path.join(computationDir, 'scripts');
  ensureDir(scriptsDir);
  const stubPath = path.join(scriptsDir, 'bridge_stub.py');
  writeTextAtomic(stubPath, bridgeStubContent());

  const steps = executionPlan.tasks.map((task, index) => {
    if (task.expected_artifacts.length === 0) {
      materializationError(`execution_plan task '${task.task_id}' is missing expected_artifacts`);
    }
    const outputs = task.expected_artifacts.map(artifact =>
      sanitizeRelativePath(artifact.path, `tasks.${task.task_id}.expected_artifacts.path`),
    );
    return {
      id: task.task_id,
      description: task.title,
      tool: 'python' as const,
      script: 'scripts/bridge_stub.py',
      args: ['--task-id', task.task_id, '--execution-plan', 'execution_plan_v1.json'],
      expected_outputs: outputs,
      ...(task.depends_on_task_ids?.length ? { depends_on: [...task.depends_on_task_ids] } : {}),
      timeout_minutes: Math.max(1, (task.method_hint_indices.length + 1) * 5 + index),
    };
  });
  const manifest = assertComputationManifestValid({
    schema_version: 1,
    title: executionPlan.objective,
    description: 'Bridge-generated manifest. Pre-approval path validates only; real provider execution is intentionally not wired in EVO-01-A.',
    entry_point: {
      script: 'scripts/bridge_stub.py',
      tool: 'python',
      args: ['--task-id', steps[0]!.id, '--execution-plan', 'execution_plan_v1.json'],
    },
    steps,
    environment: {
      python_version: '3.11',
      platform: 'any',
      notes: 'Bridge-generated validation stub manifest. Real provider execution remains out of scope for EVO-01-A.',
    },
    dependencies: {},
    computation_budget: {
      estimated_runtime_minutes: executionPlan.tasks.length,
      max_runtime_minutes: Math.max(5, executionPlan.tasks.length * 5),
      max_disk_gb: 1,
      notes: 'Budget applies to bridge stubs only until a later provider lane lands.',
    },
    outputs: topLevelOutputs(executionPlan),
    created_at: utcNowIso(),
  });
  const manifestPath = path.join(computationDir, 'manifest.json');
  writeJsonAtomic(manifestPath, manifest);
  return { manifestPath, manifest };
}

export function executionPlanArtifactPath(runDir: string): string {
  return path.join(runDir, 'computation', 'execution_plan_v1.json');
}

export function executionPlanRelativePath(runDir: string): string {
  return toPosixRelative(runDir, executionPlanArtifactPath(runDir));
}
