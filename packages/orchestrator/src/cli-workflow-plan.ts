import * as fs from 'node:fs';
import {
  resolveWorkflowRecipe,
  type ResolveWorkflowRequest,
  type ResolvedWorkflowPlan,
  type ResolvedWorkflowStep,
} from '@autoresearch/literature-workflows';
import type { CliIo } from './cli-lifecycle.js';
import { resolveLifecycleProjectRoot } from './cli-project-root.js';
import { StateManager } from './state-manager.js';
import { utcNowIso } from './util.js';

export type WorkflowPlanCommandInput = {
  projectRoot: string | null;
  recipeId: string;
  phase: string | null;
  inputs: Record<string, unknown>;
  preferredProviders: string[];
  allowedProviders: string[];
  availableTools: string[];
};

function derivedRunId(input: WorkflowPlanCommandInput): string {
  const explicit = typeof input.inputs.run_id === 'string' ? input.inputs.run_id.trim() : '';
  if (explicit) return explicit;
  return [input.recipeId, input.phase ?? 'plan'].join('-');
}

function buildWorkflowExecution(step: ResolvedWorkflowStep): Record<string, unknown> {
  return {
    action: step.action ?? null,
    tool: step.tool,
    provider: step.provider ?? null,
    depends_on: [...step.depends_on],
    params: step.params,
    required_capabilities: [...step.required_capabilities],
    degrade_mode: step.degrade_mode ?? null,
    consumer_hints: step.consumer_hints ?? null,
  };
}

function humanizeWorkflowStepTitle(stepId: string): string {
  return stepId
    .split(/[_-]+/)
    .filter(Boolean)
    .map(token => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

function taskIntentForStep(step: ResolvedWorkflowStep): string {
  if (step.action) return step.action;
  return `workflow_step.${step.id}`;
}

function buildWorkflowTaskProjection(step: ResolvedWorkflowStep): Record<string, unknown> {
  const preconditions: string[] = [];
  if (step.consumer_hints?.project_required) preconditions.push('project_required');
  if (step.consumer_hints?.run_required) preconditions.push('run_required');

  return {
    task_id: step.id,
    task_kind: 'literature',
    task_intent: taskIntentForStep(step),
    title: humanizeWorkflowStepTitle(step.id),
    description: step.purpose,
    depends_on_task_ids: [...step.depends_on],
    required_capabilities: [...step.required_capabilities],
    expected_artifacts: step.consumer_hints?.artifact ? [step.consumer_hints.artifact] : [],
    preconditions,
  };
}

function buildPersistedPlan(input: WorkflowPlanCommandInput, resolvedPlan: ResolvedWorkflowPlan, runId: string): Record<string, unknown> {
  const now = utcNowIso();
  const steps = resolvedPlan.resolved_steps.map(step => {
    return {
      step_id: step.id,
      description: step.purpose,
      status: 'pending',
      expected_approvals: [],
      expected_outputs: step.consumer_hints?.artifact ? [step.consumer_hints.artifact] : [],
      recovery_notes: '',
      task: buildWorkflowTaskProjection(step),
      execution: buildWorkflowExecution(step),
    };
  });
  return {
    schema_version: 1,
    created_at: now,
    updated_at: now,
    plan_id: `${runId}:${resolvedPlan.recipe_id}`,
    run_id: runId,
    workflow_id: resolvedPlan.recipe_id,
    ...(steps[0]?.step_id ? { current_step_id: steps[0].step_id } : {}),
    steps,
    notes: `Resolved from checked-in workflow recipe ${resolvedPlan.recipe_id}${input.phase ? ` (phase=${input.phase})` : ''}.`,
  };
}

export async function runWorkflowPlanCommand(input: WorkflowPlanCommandInput, io: CliIo): Promise<void> {
  const request = {
    recipe_id: input.recipeId,
    ...(input.phase ? { phase: input.phase } : {}),
    inputs: input.inputs,
    ...(input.preferredProviders.length > 0 ? { preferred_providers: input.preferredProviders } : {}),
    ...(input.allowedProviders.length > 0 ? { allowed_providers: input.allowedProviders } : {}),
    ...(input.availableTools.length > 0 ? { available_tools: input.availableTools } : {}),
  } as ResolveWorkflowRequest;
  const plan = resolveWorkflowRecipe(request);
  const projectRoot = resolveLifecycleProjectRoot(input.projectRoot, io.cwd);
  const manager = new StateManager(projectRoot);
  if (!fs.existsSync(manager.statePath)) {
    throw new Error(`project root is not initialized: ${projectRoot}; run autoresearch init first`);
  }

  const runId = derivedRunId(input);
  const state = manager.readState();
  if (!['idle', 'completed', 'failed', 'rejected'].includes(state.run_status)) {
    throw new Error(`cannot replace workflow plan while run_status=${state.run_status}; finish or reset the current run first`);
  }

  state.run_id = runId;
  state.workflow_id = plan.recipe_id;
  state.run_status = 'idle';
  state.current_step = null;
  state.plan = buildPersistedPlan(input, plan, runId);
  state.notes = `workflow plan loaded from ${plan.recipe_id}${input.phase ? ` (${input.phase})` : ''}`;
  state.checkpoints.last_checkpoint_at = utcNowIso();
  manager.saveStateWithLedger(state, 'workflow_plan_resolved', {
    details: {
      recipe_id: plan.recipe_id,
      phase: input.phase,
      run_id: runId,
      resolved_step_count: plan.resolved_steps.length,
    },
  });

  io.stdout(`${JSON.stringify(plan, null, 2)}\n`);
}
