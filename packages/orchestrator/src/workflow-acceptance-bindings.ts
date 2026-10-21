import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkflowAcceptanceChecks } from '@nullius/literature-workflows';
import type { WorkflowAcceptanceCheckSpec } from '@nullius/shared';
import { z } from 'zod';
import { assertNoSymlinkComponents, resolveWithinRoot } from './computation/path-safety.js';
import { canonicalJson, createToolAttemptIdentity, RunManifestManager } from './run-manifest.js';
import { runDirFor } from './run-paths.js';
import type { RunState } from './types.js';
import { compileWorkflowRuntimeRequest, normalizeWorkflowRuntimeResult, parsePersistedWorkflowExecution } from './workflow-runtime.js';

export interface WorkflowAcceptanceDeps {
  resolveChecks?: (workflowId: string, plan: Record<string, unknown> | null) => WorkflowAcceptanceCheckSpec[];
  runtimeRoot?: string;
  timeoutMs?: number;
}
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const digestJson = (value: unknown): string => digest(canonicalJson(value));
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const inputSchema = z.object({ path: z.string().min(1), sha256: hashSchema }).strict();
export const specSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/), checker_path: z.string().min(1),
  checker_sources: z.array(z.string().min(1)).min(1), request: z.record(z.string(), z.unknown()),
}).strict();
export function localPath(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === '..' || p === '.')) {
    throw new Error(`acceptance path must be project-relative: ${relative}`);
  }
  const resolved = resolveWithinRoot(root, relative, 'workflow acceptance');
  assertNoSymlinkComponents(root, resolved, 'workflow acceptance');
  return resolved;
}
export function fileHash(root: string, relative: string): string {
  const target = localPath(root, relative);
  if (!fs.statSync(target).isFile()) throw new Error(`not a regular acceptance input: ${relative}`);
  return digest(fs.readFileSync(target));
}
export function readJson(file: string): unknown {
  if (fs.statSync(file).size > 2_000_000) throw new Error('acceptance JSON exceeds size limit');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function semanticPlan(plan: Record<string, unknown>): Record<string, unknown> {
  const omit = new Set(['status', 'current_step_id', 'created_at', 'updated_at', 'started_at', 'completed_at']);
  const stable = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([key]) => !omit.has(key)));
  return { ...stable(plan), steps: Array.isArray(plan.steps) ? plan.steps.map(raw => stable(raw as Record<string, unknown>)) : [] };
}
export function acceptanceContext(projectRoot: string, state: RunState, deps: WorkflowAcceptanceDeps = {}) {
  const project = fs.realpathSync(projectRoot);
  const runtimeRoot = fs.realpathSync(deps.runtimeRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
  const specs = (deps.resolveChecks ?? resolveWorkflowAcceptanceChecks)(state.workflow_id ?? '', state.plan).map(s => specSchema.parse(s));
  if (new Set(specs.map(s => s.id)).size !== specs.length) throw new Error('duplicate acceptance check IDs');
  if (!specs.length) return { project, runtimeRoot, specs, identity: null, executionFindings: [] as string[] };
  if (!state.run_id || !state.workflow_id || !state.plan || !Array.isArray(state.plan.steps) || !state.plan.steps.length) {
    throw new Error('required workflow acceptance needs a nonempty persisted run plan');
  }
  const journal = new RunManifestManager(path.dirname(runDirFor(project, state.run_id)));
  const findings: string[] = [];
  if (state.run_status !== 'completed') findings.push('workflow execution is not completed');
  const ids = new Set<string>();
  const outputs = state.plan.steps.map(raw => {
    const item = raw as Record<string, unknown>;
    if (typeof item.step_id !== 'string' || !item.step_id || ids.has(item.step_id)) throw new Error('invalid or duplicate workflow step ID');
    ids.add(item.step_id);
    const step = { step_id: item.step_id, description: String(item.description ?? ''), status: String(item.status ?? ''), execution: parsePersistedWorkflowExecution(item.execution) };
    if (step.status !== 'completed') findings.push(`${step.step_id}: execution status is ${step.status}`);
    const request = compileWorkflowRuntimeRequest({ projectRoot, workflowId: state.workflow_id!, runId: state.run_id, step });
    const attempt = createToolAttemptIdentity({ stepId: step.step_id, toolName: request.tool, input: request });
    let outcome;
    try { outcome = journal.classifyToolAttempt(state.run_id!, attempt); } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      findings.push(`${step.step_id}: committed tool identity unavailable: ${reason}`);
      return { ...attempt, outcome: 'identity_conflict', reason };
    }
    if (outcome.state !== 'committed') {
      findings.push(`${step.step_id}: no committed tool result (${outcome.state})`);
      return { ...attempt, outcome: outcome.state };
    }
    const runtime = normalizeWorkflowRuntimeResult(request, outcome.result);
    if (runtime.status !== 'completed') findings.push(`${step.step_id}: tool outcome is ${runtime.status}`);
    return { ...attempt, result_sha256: outcome.result_sha256 };
  });
  return { project, runtimeRoot, specs, identity: { plan_sha256: digestJson(semanticPlan(state.plan)), outputs_sha256: digestJson(outputs) }, executionFindings: findings };
}
export type AcceptanceContext = ReturnType<typeof acceptanceContext>;
export function checkerIdentity(context: AcceptanceContext) {
  const names = [...new Set(context.specs.flatMap(s => [s.checker_path, ...s.checker_sources]))].sort();
  return names.map(name => ({ path: name, sha256: fileHash(context.runtimeRoot, name) }));
}
export function implementationIdentity(): string {
  const extension = path.extname(fileURLToPath(import.meta.url));
  return digestJson(['workflow-acceptance', 'workflow-acceptance-bindings', 'workflow-acceptance-executor'].map(name => ({
    name, sha256: digest(fs.readFileSync(new URL(`./${name}${extension}`, import.meta.url))),
  })));
}
export function verifyInputs(project: string, inputs: { path: string; sha256: string }[]): void {
  const seen = new Set<string>();
  for (const input of inputs) {
    const key = path.relative(project, localPath(project, input.path));
    if (seen.has(key)) throw new Error(`duplicate acceptance input: ${input.path}`);
    seen.add(key);
    if (fileHash(project, input.path) !== input.sha256) throw new Error(`acceptance input changed: ${input.path}`);
  }
}
