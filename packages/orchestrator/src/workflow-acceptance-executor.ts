import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { z } from 'zod';
import { inputSchema, hashSchema, localPath, readJson, verifyInputs, type AcceptanceContext, type WorkflowAcceptanceDeps } from './workflow-acceptance-bindings.js';
import { writeBytesAtomicDurable, writeJsonAtomicDurable, type WorkflowAcceptanceCheckSpec } from '@nullius/shared';
import type { RunState } from './types.js';

export const checkerResultSchema = z.object({
  schema_version: z.literal(1), check_id: z.string(), run_id: z.string(), workflow_id: z.string(),
  plan_sha256: hashSchema, outputs_sha256: hashSchema,
  status: z.enum(['passed', 'failed', 'incomplete', 'unavailable']), summary: z.string(),
  findings: z.array(z.string()), inputs: z.array(inputSchema),
}).strict();
export type CheckerResult = z.infer<typeof checkerResultSchema>;
export function executeAcceptanceCheck(context: AcceptanceContext, state: RunState, spec: WorkflowAcceptanceCheckSpec, directory: string, deps: WorkflowAcceptanceDeps): CheckerResult {
  const envelope = {
    schema_version: 1 as const, project_root: context.project, run_id: state.run_id!, workflow_id: state.workflow_id!,
    ...context.identity!, check_id: spec.id, requirements: spec.request,
  };
  const base = { schema_version: 1 as const, check_id: spec.id, run_id: state.run_id!, workflow_id: state.workflow_id!, ...context.identity!, inputs: [] };
  try {
    const requestPath = path.join(directory, `${spec.id}.request.json`);
    const outputPath = path.join(directory, `${spec.id}.result.json`);
    writeJsonAtomicDurable(requestPath, envelope);
    const child = spawnSync('python3', [localPath(context.runtimeRoot, spec.checker_path), '--request', requestPath, '--output', outputPath], {
      cwd: context.project, encoding: 'utf8', timeout: deps.timeoutMs ?? 30_000, maxBuffer: 1_000_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    writeBytesAtomicDurable(path.join(directory, `${spec.id}.log`), `${child.stdout ?? ''}\n${child.stderr ?? ''}`);
    if (child.error || child.signal || child.status === null) throw new Error(`checker unavailable: ${child.error?.message ?? child.signal}`);
    const outputRelative = path.relative(context.project, outputPath);
    const result = checkerResultSchema.parse(readJson(localPath(context.project, outputRelative)));
    for (const key of ['check_id', 'run_id', 'workflow_id', 'plan_sha256', 'outputs_sha256'] as const) {
      if (result[key] !== base[key]) throw new Error(`checker identity mismatch: ${key}`);
    }
    const expectedExit = result.status === 'passed' ? 0 : result.status === 'unavailable' ? 2 : 1;
    if (child.status !== expectedExit) throw new Error('checker exit status contradicts structured verdict');
    if (result.status === 'passed' && (!result.inputs.length || result.findings.length)) throw new Error('checker pass lacks clean, nonempty evidence');
    verifyInputs(context.project, result.inputs);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, status: 'unavailable', summary: message, findings: [message] };
  }
}
