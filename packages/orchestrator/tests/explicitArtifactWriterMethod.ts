import type { ExecutionPlanV1 } from '@nullius/shared';
import { compileExecutionPlan, type StagedIdeaSurface } from '../src/computation/execution-plan.js';

function controlledArtifactWriterContent(lastTaskId?: string, feedbackSignal?: 'success' | 'weak_signal' | 'failure'): string {
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
    "parser = argparse.ArgumentParser(description='Explicit test artifact writer')",
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
    "    'summary': f\"Controlled test artifact written for {task.get('task_id')}.\",",
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
    ...(feedbackSignal ? [
      `if args.task_id == ${JSON.stringify(lastTaskId)}:`,
      "    feedback_path = Path('outputs/research_feedback.json')",
      "    feedback_path.parent.mkdir(parents=True, exist_ok=True)",
      `    feedback_path.write_text(json.dumps({'feedback_signal': '${feedbackSignal}'}) + '\\n', encoding='utf-8')`,
    ] : []),
  ].join('\n');
}

export function explicitArtifactWriterMethod(plan: ExecutionPlanV1, feedbackSignal?: 'success' | 'weak_signal' | 'failure'): Record<string, unknown> {
  return {
    files: [{ path: 'scripts/execution_plan_runner.py', content: controlledArtifactWriterContent(plan.tasks.at(-1)?.task_id, feedbackSignal) }],
    run_card: {
      schema_version: 2,
      workflow_id: 'computation',
      title: 'Write controlled test artifacts',
      phases: plan.tasks.map(task => ({
        phase_id: task.task_id,
        backend: {
          kind: 'shell', argv: ['python3', 'scripts/execution_plan_runner.py', '--task-id', task.task_id, '--execution-plan', 'execution_plan_v1.json'],
          cwd: '.', timeout_seconds: 10,
        },
        outputs: [...task.expected_artifacts.map(artifact => artifact.path), ...(feedbackSignal && task === plan.tasks.at(-1) ? ['outputs/research_feedback.json'] : [])],
        ...(task.depends_on_task_ids?.length ? { depends_on: [...task.depends_on_task_ids] } : {}),
      })),
    },
  };
}

export function withExplicitSurfaceMethod<T extends StagedIdeaSurface>(surface: T): T & { hints: NonNullable<T['hints']> & { method_spec: Record<string, unknown> } } {
  const plan = compileExecutionPlan('controlled-test-plan', surface);
  return { ...surface, hints: { ...surface.hints, method_spec: explicitArtifactWriterMethod(plan) } } as T & { hints: NonNullable<T['hints']> & { method_spec: Record<string, unknown> } };
}

export function withExplicitHandoffMethod(handoff: Record<string, unknown>): Record<string, unknown> {
  const card = handoff.idea_card as Record<string, unknown>;
  const surface: StagedIdeaSurface = {
    outline_seed_path: 'artifacts/outline_seed_v1.json',
    outline: {
      thesis: String(card.thesis_statement), claims: card.claims as unknown[],
      hypotheses: card.testable_hypotheses as string[], source_handoff_uri: 'fixture://controlled-test-input',
    },
    hints: { minimal_compute_plan: card.minimal_compute_plan as NonNullable<StagedIdeaSurface['hints']>['minimal_compute_plan'] },
  };
  return { ...handoff, idea_card: { ...card, method_spec: explicitArtifactWriterMethod(compileExecutionPlan('controlled-test-plan', surface)) } };
}
