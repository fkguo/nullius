import * as path from 'node:path';
import { z } from 'zod';
import { runCli } from '@nullius/orchestrator';
import { invalidParams } from '@nullius/shared';
import { boundPath, safeId } from './paths.js';
import { jsonResult } from './result.js';

export const cliSchema = z.object({
  action: z.enum(['init', 'status', 'current', 'notebook_sync', 'index_sync', 'report_validate', 'result_set_current', 'trace', 'decision_record']),
  delivery_id: z.string().optional(),
  timeout_seconds: z.number().int().min(1).max(3600).optional(),
  mode: z.enum(['file', 'engine']).optional(),
  runtime_only: z.boolean().optional(),
  result_id: z.string().optional(),
  run_id: z.string().optional(),
  artifact: z.string().optional(),
  description: z.string().optional(),
  text: z.string().optional(),
}).strict();
export function cliWrites(action: string): boolean { return !['status', 'current', 'report_validate'].includes(action); }
export function cliArguments(root: string, input: unknown): string[] {
  const args = cliSchema.parse(input);
  const prefix = ['--project-root', root];
  switch (args.action) {
    case 'init': return [...prefix, 'init', ...(args.runtime_only ? ['--runtime-only'] : ['--mode', args.mode ?? 'file'])];
    case 'status': case 'current': return [...prefix, args.action, '--json'];
    case 'notebook_sync': return [...prefix, 'notebook', 'sync', '--json'];
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
