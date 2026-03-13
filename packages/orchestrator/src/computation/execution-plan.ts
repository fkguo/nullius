import Ajv2020 from 'ajv/dist/2020.js';
import { invalidParams, type ExecutionPlanV1 } from '@autoresearch/shared';
import executionPlanSchema from '../../../../meta/schemas/execution_plan_v1.schema.json' with { type: 'json' };
import { utcNowIso } from '../util.js';

export interface OutlineSeedInput {
  thesis: string;
  claims: unknown[];
  hypotheses: string[];
  source_handoff_uri: string;
}

export interface MinimalComputePlanHint {
  step: string;
  method: string;
  estimated_difficulty: string;
  estimate_confidence?: string;
  estimated_compute_hours_log10?: number;
  required_infrastructure?: string;
  blockers?: string[];
  tool_hint?: string;
}

export interface StagedIdeaHints {
  campaign_id?: string;
  node_id?: string;
  idea_id?: string;
  promoted_at?: string;
  required_observables?: string[];
  candidate_formalisms?: string[];
  minimal_compute_plan?: MinimalComputePlanHint[];
  method_spec?: Record<string, unknown> | null;
}

export interface StagedIdeaSurface {
  outline_seed_path: string;
  outline: OutlineSeedInput;
  hints?: StagedIdeaHints | null;
}

type AjvConstructor = new (options: Record<string, unknown>) => {
  compile: (schema: Record<string, unknown>) => {
    (value: unknown): boolean;
    errors?: unknown[];
  };
};

const validator = new (Ajv2020 as unknown as AjvConstructor)({
  allErrors: true,
  strict: false,
  validateFormats: false,
}).compile(executionPlanSchema as Record<string, unknown>);

function stagedInputError(message: string, details: Record<string, unknown> = {}): never {
  throw invalidParams(message, { validation_layer: 'staged_input', ...details });
}

function taskCapabilities(observableCount: number, includeMethodGuidance: boolean): string[] {
  const capabilities = ['hypothesis_evaluation', 'claim_cross_check'];
  if (observableCount > 0) capabilities.push('observable_estimation');
  if (includeMethodGuidance) capabilities.push('method_guided_analysis');
  return capabilities;
}

export function validateStagedIdeaSurface(surface: StagedIdeaSurface): StagedIdeaSurface {
  const { outline_seed_path, outline, hints } = surface;
  if (typeof outline_seed_path !== 'string' || outline_seed_path.length === 0) {
    stagedInputError('outline_seed_path missing from staged idea surface');
  }
  if (!outline || typeof outline !== 'object') stagedInputError('outline seed missing from staged idea surface');
  if (typeof outline.thesis !== 'string' || outline.thesis.trim().length === 0) {
    stagedInputError('outline_seed.thesis missing or empty');
  }
  if (!Array.isArray(outline.claims) || outline.claims.length === 0) {
    stagedInputError('outline_seed.claims missing or empty');
  }
  if (!Array.isArray(outline.hypotheses) || outline.hypotheses.length === 0) {
    stagedInputError('outline_seed.hypotheses missing or empty');
  }
  if (outline.hypotheses.some(hypothesis => typeof hypothesis !== 'string' || hypothesis.trim().length === 0)) {
    stagedInputError('outline_seed.hypotheses must contain non-empty strings');
  }
  if (typeof outline.source_handoff_uri !== 'string' || outline.source_handoff_uri.length === 0) {
    stagedInputError('outline_seed.source_handoff_uri missing or empty');
  }
  if (hints?.required_observables && hints.required_observables.some(item => typeof item !== 'string' || item.trim().length === 0)) {
    stagedInputError('required_observables must contain non-empty strings');
  }
  if (hints?.minimal_compute_plan && hints.minimal_compute_plan.some(item => {
    return typeof item.step !== 'string' || item.step.trim().length === 0
      || typeof item.method !== 'string' || item.method.trim().length === 0;
  })) {
    stagedInputError('minimal_compute_plan items must include non-empty step and method strings');
  }
  return surface;
}

export function assertExecutionPlanValid(value: unknown): ExecutionPlanV1 {
  if (!validator(value)) {
    throw invalidParams('execution_plan_v1 validation failed', {
      validation_layer: 'execution_plan',
      issues: validator.errors ?? [],
    });
  }
  return value as ExecutionPlanV1;
}

export function compileExecutionPlan(runId: string, stagedIdea: StagedIdeaSurface): ExecutionPlanV1 {
  const validated = validateStagedIdeaSurface(stagedIdea);
  const observables = [...(validated.hints?.required_observables ?? [])];
  const methodHints = [...(validated.hints?.minimal_compute_plan ?? [])];
  const claimIndices = validated.outline.claims.map((_, index) => index);
  const tasks = methodHints.length > 0
    ? methodHints.map((hint, index) => ({
      task_id: `task_${String(index + 1).padStart(3, '0')}`,
      title: hint.step,
      description: `Bridge task derived from staged method hint: ${hint.method}`,
      hypothesis_indices: methodHints.length === validated.outline.hypotheses.length
        ? [index]
        : validated.outline.hypotheses.map((_, hypothesisIndex) => hypothesisIndex),
      claim_indices: claimIndices,
      method_hint_indices: [index],
      observables,
      method_hint_summary: `${hint.method} (${hint.estimated_difficulty})`,
      capabilities: taskCapabilities(observables.length, true),
      expected_artifacts: [
        {
          artifact_id: `${String(index + 1).padStart(3, '0')}_result`,
          kind: 'structured_result',
          path: `outputs/task_${String(index + 1).padStart(3, '0')}.json`,
          description: `Structured computation placeholder for ${hint.step}`,
        },
      ],
      lowering_hints: { workspace_subdir: `task_${String(index + 1).padStart(3, '0')}` },
    }))
    : validated.outline.hypotheses.map((hypothesis, index) => ({
      task_id: `task_${String(index + 1).padStart(3, '0')}`,
      title: `Evaluate hypothesis ${index + 1}`,
      description: hypothesis,
      hypothesis_indices: [index],
      claim_indices: claimIndices,
      method_hint_indices: [],
      observables,
      capabilities: taskCapabilities(observables.length, false),
      expected_artifacts: [
        {
          artifact_id: `${String(index + 1).padStart(3, '0')}_result`,
          kind: 'structured_result',
          path: `outputs/task_${String(index + 1).padStart(3, '0')}.json`,
          description: `Structured computation placeholder for hypothesis ${index + 1}`,
        },
      ],
      lowering_hints: { workspace_subdir: `task_${String(index + 1).padStart(3, '0')}` },
    }));
  return assertExecutionPlanValid({
    schema_version: 1,
    run_id: runId,
    objective: validated.outline.thesis,
    source: {
      outline_seed_path: validated.outline_seed_path,
      source_handoff_uri: validated.outline.source_handoff_uri,
      ...(validated.hints?.campaign_id ? { campaign_id: validated.hints.campaign_id } : {}),
      ...(validated.hints?.node_id ? { node_id: validated.hints.node_id } : {}),
      ...(validated.hints?.idea_id ? { idea_id: validated.hints.idea_id } : {}),
      ...(validated.hints?.promoted_at ? { promoted_at: validated.hints.promoted_at } : {}),
      ...(observables.length > 0 ? { required_observables: observables } : {}),
      ...(validated.hints?.candidate_formalisms?.length ? { candidate_formalisms: [...validated.hints.candidate_formalisms] } : {}),
      method_spec_present: Boolean(validated.hints?.method_spec),
      method_hint_count: methodHints.length,
    },
    tasks,
    created_at: utcNowIso(),
  });
}
