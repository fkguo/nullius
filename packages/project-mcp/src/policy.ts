import * as path from 'node:path';
import { getToolSpecs, handleToolCall } from '@nullius/orchestrator';
import { invalidParams, zodToMcpInputSchema } from '@nullius/shared';
import { boundPath, safeId } from './paths.js';

// Transport scope is explicit: fleet ownership and operator decisions stay local.
const allowed = new Set([
  'orch_run_create', 'orch_run_status', 'orch_run_list', 'orch_run_pause', 'orch_run_resume',
  'orch_run_export', 'orch_policy_query', 'orch_run_approvals_list', 'orch_run_stage_idea',
  'orch_run_stage_content', 'orch_run_plan_computation', 'orch_run_execute_manifest',
  'orch_run_record_verification', 'orch_run_request_final_conclusions',
  'orch_run_execute_agent', 'orch_run_progress_followups',
]);
export const samplingTools = new Set(['orch_run_execute_agent', 'orch_run_progress_followups']);
export const coreSpecs = getToolSpecs('full').filter(spec => allowed.has(spec.name) && spec.execution_policy.approval_behavior !== 'resolves_approval');
export type Context = NonNullable<Parameters<typeof handleToolCall>[3]>;
export function requireSpec(name: string) {
  const spec = coreSpecs.find(item => item.name === name);
  if (!spec || spec.execution_policy.approval_behavior === 'resolves_approval') throw invalidParams(`Tool is not exposed by this project transport: ${name}`);
  return spec;
}
export function isBackground(name: string): boolean {
  return requireSpec(name).execution_policy.mutation_class === 'stateful' && !samplingTools.has(name);
}

export function coreArguments(root: string, name: string, raw: Record<string, unknown>): Record<string, unknown> {
  const spec = requireSpec(name);
  const args = { ...raw };
  delete args.delivery_id;
  delete args.timeout_seconds;
  if (args.project_root !== undefined && (typeof args.project_root !== 'string' || boundPath(root, args.project_root) !== root)) {
    throw invalidParams('project_root differs from the bound project.');
  }
  args.project_root = root;
  const runId = typeof args.run_id === 'string' ? safeId(args.run_id) : null;
  const canonicalRun = runId ? boundPath(root, `artifacts/runs/${runId}`) : root;
  if (args.run_dir !== undefined) {
    if (typeof args.run_dir !== 'string' || boundPath(root, args.run_dir) !== canonicalRun) throw invalidParams('run_dir must match artifacts/runs/<run_id> in the bound project.');
    args.run_dir = canonicalRun;
  }
  for (const field of ['handoff_path', 'manifest_path', 'checker_path']) {
    if (typeof args[field] === 'string') args[field] = boundPath(root, args[field] as string, field === 'handoff_path' ? root : canonicalRun);
  }
  for (const field of ['evidence_paths', 'checker_helper_paths']) {
    if (Array.isArray(args[field])) args[field] = (args[field] as unknown[]).map(value => {
      if (typeof value !== 'string') throw invalidParams(`Invalid ${field}`);
      return boundPath(root, value, canonicalRun);
    });
  }
  // No caller may create operator authority through nested team configuration.
  if (args.team && typeof args.team === 'object') {
    const team = args.team as Record<string, unknown>;
    if (team.permissions !== undefined || team.interventions !== undefined) throw invalidParams('Team permissions/interventions belong to the local host, not MCP callers.');
  }
  if (Array.isArray(args.tools)) {
    args.tools = args.tools.map(item => {
      const tool = item as Record<string, unknown>;
      if (typeof tool.name !== 'string' || samplingTools.has(tool.name)) throw invalidParams('Nested delegated runtimes are not exposed.');
      const trusted = requireSpec(tool.name);
      return { name: trusted.name, description: trusted.description, input_schema: zodToMcpInputSchema(trusted.zodSchema) };
    });
  }
  // Canonical Zod validation runs before durable dispatch as well as inside handleToolCall.
  const result = spec.zodSchema.safeParse(args);
  if (!result.success) throw invalidParams(`Invalid arguments for ${name}`, { issues: result.error.issues });
  // Before every run operation, guard runtime-owned directories against substituted symlinks.
  for (const value of ['.nullius', 'artifacts', 'artifacts/runs', path.relative(root, canonicalRun)]) {
    if (value) boundPath(root, value);
  }
  return result.data as Record<string, unknown>;
}
