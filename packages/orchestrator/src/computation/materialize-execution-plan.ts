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

function bridgeRunnerContent(): string {
  return [
    'import argparse',
    'import json',
    'from datetime import datetime, timezone',
    'from pathlib import Path',
    'import sys',
    '',
    '',
    'def now_iso() -> str:',
    "    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')",
    '',
    "parser = argparse.ArgumentParser(description='Minimal approved execution runner for bridge-generated tasks')",
    "parser.add_argument('--task-id', required=True)",
    "parser.add_argument('--execution-plan', required=True)",
    'args = parser.parse_args()',
    '',
    "execution_plan = json.loads(Path(args.execution_plan).read_text(encoding='utf-8'))",
    "task = next((item for item in execution_plan.get('tasks', []) if item.get('task_id') == args.task_id), None)",
    'if task is None:',
    "    sys.stderr.write(f'Unknown task id: {args.task_id}\\n')",
    '    raise SystemExit(2)',
    '',
    'base_payload = {',
    "    'schema_version': 1,",
    "    'run_id': execution_plan.get('run_id'),",
    "    'task_id': task.get('task_id'),",
    "    'title': task.get('title'),",
    "    'description': task.get('description'),",
    "    'status': 'completed',",
    "    'summary': f\"Minimal approved execution completed for {task.get('task_id')}.\",",
    "    'objective': execution_plan.get('objective'),",
    "    'source': execution_plan.get('source'),",
    "    'hypothesis_indices': task.get('hypothesis_indices', []),",
    "    'claim_indices': task.get('claim_indices', []),",
    "    'method_hint_indices': task.get('method_hint_indices', []),",
    "    'capabilities': task.get('capabilities', []),",
    "    'produced_at': now_iso(),",
    '}',
    '',
    "for artifact in task.get('expected_artifacts', []):",
    "    output_path = Path(artifact['path'])",
    '    output_path.parent.mkdir(parents=True, exist_ok=True)',
    '    payload = {',
    '        **base_payload,',
    "        'artifact_id': artifact.get('artifact_id'),",
    "        'artifact_kind': artifact.get('kind'),",
    "        'artifact_path': artifact.get('path'),",
    '    }',
    "    output_path.write_text(json.dumps(payload, indent=2) + '\\n', encoding='utf-8')",
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
  const stubPath = path.join(scriptsDir, 'execution_plan_runner.py');
  writeTextAtomic(stubPath, bridgeRunnerContent());

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
      script: 'scripts/execution_plan_runner.py',
      args: ['--task-id', task.task_id, '--execution-plan', 'execution_plan_v1.json'],
      expected_outputs: outputs,
      ...(task.depends_on_task_ids?.length ? { depends_on: [...task.depends_on_task_ids] } : {}),
      timeout_minutes: Math.max(1, (task.method_hint_indices.length + 1) * 5 + index),
    };
  });
  const manifest = assertComputationManifestValid({
    schema_version: 1,
    title: executionPlan.objective,
    description: 'Bridge-generated manifest. Approved execution writes structured provider-neutral result artifacts for each validated execution-plan task.',
    entry_point: {
      script: 'scripts/execution_plan_runner.py',
      tool: 'python',
      args: ['--task-id', steps[0]!.id, '--execution-plan', 'execution_plan_v1.json'],
    },
    steps,
    environment: {
      python_version: '3.11',
      platform: 'any',
      notes: 'Bridge-generated manifest uses a generic Python execution surface to materialize structured result artifacts after approval. External provider orchestration remains a later lane.',
    },
    dependencies: {},
    computation_budget: {
      estimated_runtime_minutes: executionPlan.tasks.length,
      max_runtime_minutes: Math.max(5, executionPlan.tasks.length * 5),
      max_disk_gb: 1,
      notes: 'Budget applies to the minimal generic execution surface emitted by the bridge. External provider execution remains a later lane.',
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
