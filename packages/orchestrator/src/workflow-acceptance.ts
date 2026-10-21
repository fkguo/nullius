import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { writeBytesAtomicDurable } from '@nullius/shared';
import { assertWritableRunId, runDirFor } from './run-paths.js';
import type { StateManager } from './state-manager.js';
import type { RunState } from './types.js';
import { acceptanceContext, checkerIdentity, digest, digestJson, hashSchema, implementationIdentity, inputSchema, localPath, readJson, verifyInputs, type AcceptanceContext, type WorkflowAcceptanceDeps } from './workflow-acceptance-bindings.js';
import { checkerResultSchema, executeAcceptanceCheck } from './workflow-acceptance-executor.js';
export type { WorkflowAcceptanceDeps } from './workflow-acceptance-bindings.js';

export interface WorkflowAcceptanceView {
  status: 'not_required' | 'missing' | 'passed' | 'failed' | 'incomplete' | 'unavailable' | 'stale';
  summary: string;
  required_checks: string[];
  identity: { plan_sha256: string; outputs_sha256: string } | null;
  receipt: { path: string; sha256: string } | null;
  findings: string[];
}
const receiptSchema = z.object({
  schema_version: z.literal(1), run_id: z.string(), workflow_id: z.string(), created_at: z.string(),
  identity: z.object({ plan_sha256: hashSchema, outputs_sha256: hashSchema }).strict(),
  specs_sha256: hashSchema, implementation_sha256: hashSchema, checker_sources: z.array(inputSchema),
  status: z.enum(['passed', 'failed', 'incomplete', 'unavailable']), summary: z.string(), findings: z.array(z.string()),
  checks: z.array(checkerResultSchema),
}).strict();
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function view(context: AcceptanceContext, status: WorkflowAcceptanceView['status'], summary: string, findings: string[] = [], receipt: WorkflowAcceptanceView['receipt'] = null): WorkflowAcceptanceView {
  return { status, summary, findings, required_checks: context.specs.map(s => s.id), identity: context.identity, receipt };
}
function unavailable(error: unknown): WorkflowAcceptanceView {
  return { status: 'unavailable', summary: message(error), findings: [message(error)], required_checks: [], identity: null, receipt: null };
}

/** Read-only freshness verification; status never executes a checker. */
export function readWorkflowAcceptance(projectRoot: string, state: RunState, deps: WorkflowAcceptanceDeps = {}): WorkflowAcceptanceView {
  let context: AcceptanceContext;
  try { context = acceptanceContext(projectRoot, state, deps); } catch (error) { return unavailable(error); }
  if (!context.specs.length) return view(context, 'not_required', 'No workflow acceptance checks are declared; this is not research approval.');
  const ref = state.workflow_acceptance;
  if (!ref) return view(context, 'missing', 'Workflow acceptance has not been checked.', context.executionFindings);
  try {
    const parsedRef = inputSchema.parse(ref);
    const allowed = path.relative(context.project, path.join(runDirFor(context.project, state.run_id!), 'workflow_acceptance')) + path.sep;
    if (!parsedRef.path.startsWith(allowed)) throw new Error('receipt is outside this run acceptance directory');
    const filename = localPath(context.project, parsedRef.path);
    if (digest(fs.readFileSync(filename)) !== parsedRef.sha256) throw new Error('acceptance receipt hash mismatch');
    const saved = receiptSchema.parse(readJson(filename));
    if (saved.run_id !== state.run_id || saved.workflow_id !== state.workflow_id) throw new Error('acceptance receipt belongs to a different run or workflow');
    const stale = (reason: string) => view(context, 'stale', reason, [reason], parsedRef);
    if (digestJson(saved.identity) !== digestJson(context.identity) || saved.specs_sha256 !== digestJson(context.specs)) return stale('Workflow plan, requirements or committed outputs changed.');
    if (saved.implementation_sha256 !== implementationIdentity() || digestJson(saved.checker_sources) !== digestJson(checkerIdentity(context))) return stale('Acceptance checker implementation changed.');
    if (saved.checks.length !== context.specs.length || saved.checks.some((check, i) => check.check_id !== context.specs[i].id
      || check.run_id !== state.run_id || check.workflow_id !== state.workflow_id
      || check.plan_sha256 !== context.identity!.plan_sha256 || check.outputs_sha256 !== context.identity!.outputs_sha256)) throw new Error('acceptance check identity mismatch');
    try { for (const check of saved.checks) verifyInputs(context.project, check.inputs); } catch (error) { return stale(message(error)); }
    if (saved.status === 'passed' && (context.executionFindings.length || saved.findings.length || saved.checks.some(c => c.status !== 'passed' || !c.inputs.length || c.findings.length))) return stale('Workflow execution or checker evidence does not support acceptance.');
    return view(context, saved.status, saved.summary, saved.findings, parsedRef);
  } catch (error) { return view(context, 'unavailable', message(error), [message(error)]); }
}

/** Execute package-selected checks and append an immutable, hash-bound receipt. */
export function evaluateWorkflowAcceptance(manager: StateManager, deps: WorkflowAcceptanceDeps = {}): WorkflowAcceptanceView {
  const state = manager.readState();
  let context: AcceptanceContext;
  try { context = acceptanceContext(manager.projectRoot, state, deps); } catch (error) { return unavailable(error); }
  if (!context.specs.length) return view(context, 'not_required', 'No workflow acceptance checks are declared; this is not research approval.');
  try {
    assertWritableRunId(context.project, state.run_id!);
    const parent = path.join(runDirFor(context.project, state.run_id!), 'workflow_acceptance');
    localPath(context.project, path.relative(context.project, parent));
    fs.mkdirSync(parent, { recursive: true });
    const directory = path.join(parent, randomUUID());
    fs.mkdirSync(directory);
    let sources: z.infer<typeof inputSchema>[] = [];
    let codeFailure: string | null = null;
    try { sources = checkerIdentity(context); } catch (error) { codeFailure = message(error); }
    const checks = context.specs.map(spec => executeAcceptanceCheck(context, state, spec, directory, deps));
    const findings = [...context.executionFindings, ...checks.flatMap(c => c.findings)];
    if (codeFailure) findings.push(codeFailure);
    try {
      if (digestJson(sources) !== digestJson(checkerIdentity(context))) findings.push('Checker source changed during acceptance.');
      for (const check of checks) verifyInputs(context.project, check.inputs);
    } catch (error) { findings.push(message(error)); codeFailure = message(error); }
    const status = codeFailure || checks.some(c => c.status === 'unavailable') ? 'unavailable'
      : checks.some(c => c.status === 'failed') ? 'failed'
      : findings.length || checks.some(c => c.status === 'incomplete') ? 'incomplete' : 'passed';
    const summary = status === 'passed'
      ? 'Declared workflow evidence checks passed; independent content review and research approval remain separate.'
      : `Workflow acceptance ${status}.`;
    const receipt = receiptSchema.parse({
      schema_version: 1, run_id: state.run_id, workflow_id: state.workflow_id, created_at: new Date().toISOString(),
      identity: context.identity, specs_sha256: digestJson(context.specs), implementation_sha256: implementationIdentity(),
      checker_sources: sources, status, summary, findings, checks,
    });
    const filename = path.join(directory, 'receipt.json');
    const bytes = JSON.stringify(receipt, null, 2) + '\n';
    writeBytesAtomicDurable(filename, bytes);
    // Keep the original StateManager snapshot: concurrent plan/state changes
    // must fail CAS rather than attaching a verdict to a different run.
    const current = acceptanceContext(manager.projectRoot, state, deps);
    if (digestJson(current.identity) !== digestJson(context.identity) || digestJson(current.specs) !== digestJson(context.specs)) throw new Error('Workflow changed during acceptance.');
    state.workflow_acceptance = { path: path.relative(context.project, filename), sha256: digest(bytes) };
    manager.saveStateWithLedger(state, 'workflow_acceptance_checked', { details: {
      run_id: state.run_id, workflow_id: state.workflow_id, status, receipt: state.workflow_acceptance,
    } });
    return readWorkflowAcceptance(manager.projectRoot, manager.readState(), deps);
  } catch (error) { return view(context, 'unavailable', message(error), [message(error)]); }
}
export function workflowAcceptanceExitCode(acceptance: WorkflowAcceptanceView): number {
  return acceptance.status === 'passed' || acceptance.status === 'not_required' ? 0 : acceptance.status === 'unavailable' ? 2 : 1;
}
