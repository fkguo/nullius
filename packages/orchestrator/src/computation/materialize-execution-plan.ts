import * as fs from 'node:fs';
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

interface MaterializationOptions {
  methodSpec?: Record<string, unknown> | null;
}

interface ProviderMethodSpecFile {
  path: string;
  content: string;
  executable: boolean;
}

interface ProviderBackedPhase {
  phaseId: string;
  description?: string;
  cwd: string;
  tool: 'python' | 'julia' | 'bash' | 'mathematica';
  script: string;
  args: string[];
  outputs: string[];
  dependsOn: string[];
  timeoutMinutes: number | null;
}

interface ProviderBackedMethodBundle {
  files: ProviderMethodSpecFile[];
  phases: ProviderBackedPhase[];
  title: string;
  description?: string;
}

function fixtureRunnerContent(): string {
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
    "parser = argparse.ArgumentParser(description='Internal fixture runner for bridge-generated tasks')",
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
    "    'summary': f\"Internal fixture execution completed for {task.get('task_id')}.\",",
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

function readStringField(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    materializationError(`${label} must be a non-empty string`, { field });
  }
  return value.trim();
}

function readRawStringField(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    materializationError(`${label} must be a non-empty string`, { field });
  }
  return value;
}

function toRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    materializationError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function sanitizeWorkspacePath(relativePath: string, label: string): string {
  return sanitizeRelativePath(relativePath.replace(/\\/g, '/'), label);
}

function writeProviderFiles(computationDir: string, files: ProviderMethodSpecFile[]): void {
  for (const file of files) {
    const filePath = path.join(computationDir, file.path);
    ensureDir(path.dirname(filePath));
    writeTextAtomic(filePath, file.content);
    if (file.executable) {
      fs.chmodSync(filePath, 0o755);
    }
  }
}

function detectPhaseTool(argv0: string): ProviderBackedPhase['tool'] {
  const normalized = path.basename(argv0).toLowerCase();
  if (normalized === 'python' || normalized.startsWith('python3')) return 'python';
  if (normalized === 'julia') return 'julia';
  if (normalized === 'bash' || normalized === 'sh') return 'bash';
  if (normalized === 'wolframscript') return 'mathematica';
  materializationError('method_spec.run_card backend argv[0] is unsupported for provider-backed materialization', {
    argv0,
  });
}

function prefixWithCwd(cwd: string, relativePath: string, label: string): string {
  const safePath = sanitizeWorkspacePath(relativePath, label);
  if (cwd === '.' || cwd === '') {
    return safePath;
  }
  return sanitizeWorkspacePath(path.posix.join(cwd, safePath), label);
}

function parseProviderBackedMethodBundle(methodSpec: Record<string, unknown>): ProviderBackedMethodBundle {
  const filesInput = methodSpec.files;
  const runCardInput = methodSpec.run_card;
  if (!Array.isArray(filesInput)) {
    materializationError('method_spec.files must be present for provider-backed materialization');
  }
  const runCard = toRecord(runCardInput, 'method_spec.run_card');
  if (runCard.schema_version !== 2) {
    materializationError('method_spec.run_card.schema_version must be 2 for provider-backed materialization');
  }
  if (runCard.workflow_id !== 'computation') {
    materializationError('method_spec.run_card.workflow_id must be computation for provider-backed materialization');
  }
  const title = readStringField(runCard, 'title', 'method_spec.run_card.title');
  const descriptionValue = runCard.description;
  const description = typeof descriptionValue === 'string' && descriptionValue.trim().length > 0
    ? descriptionValue.trim()
    : undefined;
  const files = filesInput.map((entry, index) => {
    const record = toRecord(entry, `method_spec.files[${index}]`);
    const filePath = sanitizeWorkspacePath(
      readStringField(record, 'path', `method_spec.files[${index}].path`),
      `method_spec.files[${index}].path`,
    );
    const content = readRawStringField(record, 'content', `method_spec.files[${index}].content`);
    const executable = record.executable === true;
    return { path: filePath, content, executable };
  });
  const phasesInput = runCard.phases;
  if (!Array.isArray(phasesInput) || phasesInput.length === 0) {
    materializationError('method_spec.run_card.phases must contain at least one phase');
  }
  const phases = phasesInput.map((entry, index) => {
    const record = toRecord(entry, `method_spec.run_card.phases[${index}]`);
    const backend = toRecord(record.backend, `method_spec.run_card.phases[${index}].backend`);
    if (backend.kind !== 'shell') {
      materializationError('method_spec.run_card phases must use shell backends for provider-backed materialization', {
        phase_index: index,
        backend_kind: backend.kind,
      });
    }
    const argv = backend.argv;
    if (!Array.isArray(argv) || argv.some(item => typeof item !== 'string' || item.trim().length === 0)) {
      materializationError('method_spec.run_card backend argv must be a non-empty string array', {
        phase_index: index,
      });
    }
    if (argv.length < 2) {
      materializationError('method_spec.run_card backend argv must include interpreter and script path', {
        phase_index: index,
      });
    }
    const cwdValue = backend.cwd;
    const cwd = cwdValue === undefined ? '.' : readStringField(backend, 'cwd', `method_spec.run_card.phases[${index}].backend.cwd`);
    const safeCwd = sanitizeWorkspacePath(cwd, `method_spec.run_card.phases[${index}].backend.cwd`);
    const tool = detectPhaseTool(argv[0]!);
    const script = prefixWithCwd(
      safeCwd,
      readStringField({ script: argv[1] }, 'script', `method_spec.run_card.phases[${index}].backend.argv[1]`),
      `method_spec.run_card.phases[${index}].backend.argv[1]`,
    );
    const outputsInput = record.outputs;
    if (!Array.isArray(outputsInput) || outputsInput.length === 0) {
      materializationError('method_spec.run_card phase outputs must be a non-empty string array', {
        phase_index: index,
      });
    }
    const outputs = outputsInput.map((output, outputIndex) => {
      if (typeof output !== 'string' || output.trim().length === 0) {
        materializationError('method_spec.run_card phase outputs must be non-empty strings', {
          phase_index: index,
          output_index: outputIndex,
        });
      }
      return prefixWithCwd(safeCwd, output, `method_spec.run_card.phases[${index}].outputs[${outputIndex}]`);
    });
    const dependsOnInput = record.depends_on;
    const dependsOn = Array.isArray(dependsOnInput)
      ? dependsOnInput.map((dep, depIndex) => {
        if (typeof dep !== 'string' || dep.trim().length === 0) {
          materializationError('method_spec.run_card depends_on must contain non-empty strings', {
            phase_index: index,
            depends_on_index: depIndex,
          });
        }
        return dep.trim();
      })
      : [];
    const timeoutSeconds = backend.timeout_seconds;
    const timeoutMinutes = typeof timeoutSeconds === 'number'
      ? Math.max(1, Math.ceil(timeoutSeconds / 60))
      : null;
    const descriptionValue = record.description;
    return {
      phaseId: readStringField(record, 'phase_id', `method_spec.run_card.phases[${index}].phase_id`),
      description: typeof descriptionValue === 'string' && descriptionValue.trim().length > 0
        ? descriptionValue.trim()
        : undefined,
      cwd: safeCwd,
      tool,
      script,
      args: argv.slice(2),
      outputs,
      dependsOn,
      timeoutMinutes,
    };
  });
  return { files, phases, title, description };
}

function materializeProviderBackedManifest(
  runDir: string,
  executionPlan: ExecutionPlanV1,
  bundle: ProviderBackedMethodBundle,
): MaterializedExecutionPlan {
  const computationDir = path.join(runDir, 'computation');
  writeProviderFiles(computationDir, bundle.files);
  const tools = new Set(bundle.phases.map(phase => phase.tool));
  const manifest = assertComputationManifestValid({
    schema_version: 1,
    title: executionPlan.objective,
    description: bundle.description
      ? `${bundle.description}\n\nProvider-backed execution materialized from staged method_spec.run_card.`
      : 'Provider-backed execution materialized from staged method_spec.run_card.',
    entry_point: {
      script: bundle.phases[0]!.script,
      tool: bundle.phases[0]!.tool,
      args: [...bundle.phases[0]!.args],
    },
    steps: bundle.phases.map(phase => ({
      id: phase.phaseId,
      description: phase.description ?? phase.phaseId,
      tool: phase.tool,
      script: phase.script,
      args: [...phase.args],
      expected_outputs: [...phase.outputs],
      ...(phase.dependsOn.length > 0 ? { depends_on: [...phase.dependsOn] } : {}),
      ...(phase.timeoutMinutes ? { timeout_minutes: phase.timeoutMinutes } : {}),
    })),
    environment: {
      ...(tools.has('python') ? { python_version: '3.11' } : {}),
      ...(tools.has('julia') ? { julia_version: '1.9' } : {}),
      platform: 'any',
      notes: 'Execution is provider-backed from the staged method bundle; orchestrator only materializes the approved run-local manifest.',
    },
    dependencies: {},
    computation_budget: {
      estimated_runtime_minutes: bundle.phases.length,
      max_runtime_minutes: Math.max(
        bundle.phases.length,
        bundle.phases.reduce((sum, phase) => sum + (phase.timeoutMinutes ?? 1), 0),
      ),
      max_disk_gb: 1,
      notes: 'Budget applies to the provider-backed execution bundle materialized from the staged method bundle.',
    },
    outputs: [...new Set(bundle.phases.flatMap(phase => phase.outputs))],
    created_at: utcNowIso(),
  });
  const manifestPath = path.join(computationDir, 'manifest.json');
  writeJsonAtomic(manifestPath, manifest);
  return { manifestPath, manifest };
}

export function materializeExecutionPlan(
  runDir: string,
  executionPlan: ExecutionPlanV1,
  options: MaterializationOptions = {},
): MaterializedExecutionPlan {
  if (executionPlan.tasks.length === 0) {
    materializationError('execution_plan_v1 must contain at least one task before materialization');
  }
  if (options.methodSpec) {
    return materializeProviderBackedManifest(runDir, executionPlan, parseProviderBackedMethodBundle(options.methodSpec));
  }
  const computationDir = path.join(runDir, 'computation');
  const scriptsDir = path.join(computationDir, 'scripts');
  ensureDir(scriptsDir);
  const stubPath = path.join(scriptsDir, 'execution_plan_runner.py');
  writeTextAtomic(stubPath, fixtureRunnerContent());

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
    description: 'Internal fixture manifest. Approved execution writes structured provider-neutral result artifacts for bounded bridge validation when no staged method bundle is present.',
    entry_point: {
      script: 'scripts/execution_plan_runner.py',
      tool: 'python',
      args: ['--task-id', steps[0]!.id, '--execution-plan', 'execution_plan_v1.json'],
    },
    steps,
    environment: {
      python_version: '3.11',
      platform: 'any',
      notes: 'No staged provider-backed method bundle was supplied; the bridge is using an internal fixture runner for bounded contract validation only.',
    },
    dependencies: {},
    computation_budget: {
      estimated_runtime_minutes: executionPlan.tasks.length,
      max_runtime_minutes: Math.max(5, executionPlan.tasks.length * 5),
      max_disk_gb: 1,
      notes: 'Budget applies to the internal fixture runner used for bounded contract validation when no staged method bundle is present.',
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
