import * as path from 'node:path';
import { z } from 'zod';
import { runCli } from '@nullius/orchestrator';
import { invalidParams } from '@nullius/shared';
import { boundPath, safeId } from './paths.js';
import { jsonResult } from './result.js';

export const DEFAULT_NOTEBOOK_REVIEW_TIMEOUT_SECONDS = 1200;
const REVIEW_COMPLETION_SECONDS = 60;
const positiveBudget = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional();

export const cliSchema = z.object({
  action: z.enum(['init', 'status', 'current', 'notebook_check', 'notebook_review', 'index_sync', 'report_validate', 'result_set_current', 'trace', 'decision_record']),
  delivery_id: z.string().optional(),
  timeout_seconds: z.number().int().min(1).max(3600).optional(),
  mode: z.enum(['file', 'engine']).optional(),
  runtime_only: z.boolean().optional(),
  result_id: z.string().optional(),
  run_id: z.string().optional(),
  artifact: z.string().optional(),
  description: z.string().optional(),
  text: z.string().optional(),
  structure_only: z.boolean().optional(),
  model: z.string().min(1).optional(),
  dependencies: z.array(z.string()).optional(),
  resume_run_id: z.string().optional(),
  review_timeout_seconds: z.number().int().min(1).max(3540).optional(),
  context_bytes: positiveBudget,
  context_tokens: positiveBudget,
  snapshot_bytes: positiveBudget,
  max_files: positiveBudget,
  max_batches: positiveBudget,
}).strict();
export function cliWrites(action: string): boolean { return !['status', 'current', 'notebook_check', 'report_validate'].includes(action); }

/** Keep the transport deadline outside the review's own execution budget so
 * the canonical reviewer can record its outcome and finish verification. */
export function cliDeliveryTimeout(args: z.infer<typeof cliSchema>): number {
  if (args.action !== 'notebook_review') return args.timeout_seconds ?? 300;
  const minimum = (args.review_timeout_seconds ?? DEFAULT_NOTEBOOK_REVIEW_TIMEOUT_SECONDS) + REVIEW_COMPLETION_SECONDS;
  if (args.timeout_seconds !== undefined && args.timeout_seconds < minimum) {
    throw invalidParams(`notebook_review timeout_seconds must be at least review_timeout_seconds + ${REVIEW_COMPLETION_SECONDS} (${minimum} seconds).`);
  }
  return args.timeout_seconds ?? minimum;
}

export function cliArguments(root: string, input: unknown): string[] {
  const args = cliSchema.parse(input);
  const prefix = ['--project-root', root];
  switch (args.action) {
    case 'init': return [...prefix, 'init', ...(args.runtime_only ? ['--runtime-only'] : ['--mode', args.mode ?? 'file'])];
    case 'status': case 'current': return [...prefix, args.action, '--json'];
    case 'notebook_check': return [...prefix, 'notebook', 'check',
      ...(args.result_id ? ['--result', safeId(args.result_id)] : []),
      ...(args.structure_only ? ['--structure-only'] : []), '--json'];
    case 'notebook_review': {
      if (!args.model?.trim() || args.model.startsWith('-') || args.model.includes(',')) {
        throw invalidParams('notebook_review requires one reviewer model spec.');
      }
      const values = [...prefix, 'notebook', 'review', '--model', args.model,
        '--timeout-secs', String(args.review_timeout_seconds ?? DEFAULT_NOTEBOOK_REVIEW_TIMEOUT_SECONDS), '--json'];
      for (const dependency of args.dependencies ?? []) {
        // Prefix relative paths so even a filename beginning with '-' stays
        // an option value at the canonical parser boundary.
        values.push('--dependency', `./${path.relative(root, boundPath(root, dependency)).split(path.sep).join('/')}`);
      }
      if (args.resume_run_id) values.push('--resume', safeId(args.resume_run_id));
      for (const [field, flag] of [
        ['context_bytes', '--context-bytes'], ['context_tokens', '--context-tokens'],
        ['snapshot_bytes', '--snapshot-bytes'], ['max_files', '--max-files'], ['max_batches', '--max-batches'],
      ] as const) {
        if (args[field] !== undefined) values.push(flag, String(args[field]));
      }
      return values;
    }
    case 'index_sync': return [...prefix, 'index', 'sync', '--json'];
    case 'report_validate': return [...prefix, 'report-validate'];
    case 'trace': {
      if (!args.run_id) throw invalidParams('trace requires run_id; it only stamps the canonical project run.');
      return [...prefix, 'trace', 'stamp', boundPath(root, `artifacts/runs/${safeId(args.run_id)}`), '--actor', 'project-mcp'];
    }
    case 'decision_record': {
      if (!args.text) throw invalidParams('decision_record requires text.');
      return [...prefix, 'decision', 'record', '--by', 'project-mcp', '--', args.text];
    }
    case 'result_set_current': {
      if (!args.result_id || !args.run_id || !args.artifact) throw invalidParams('result_set_current requires result_id, run_id, artifact.');
      const artifact = boundPath(root, args.artifact);
      const values = [...prefix, 'result', 'set-current', safeId(args.result_id), '--run', safeId(args.run_id), '--artifact', path.relative(root, artifact)];
      if (args.description) values.push('--description', args.description);
      return values;
    }
  }
}
export async function executeCli(root: string, input: unknown) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(cliArguments(root, input), { cwd: root, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  let data: unknown = null;
  try { data = JSON.parse(stdout); } catch { /* Human CLI output remains intact. */ }
  return jsonResult({ exit_code: exitCode, stdout, stderr, data }, exitCode !== 0);
}
