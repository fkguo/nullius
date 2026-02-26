import * as fs from 'fs';
import { z } from 'zod';
import {
  HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1,
  invalidParams,
} from '@autoresearch/shared';

import { getRun, type RunArtifactRef } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';

type TokenBudgetOverflowPolicyV1 = 'fail_fast';

export type WritingTokenBudgetPlanStepV1 =
  | 'outline'
  | 'evidence_rerank'
  | 'section_write'
  | 'review'
  | 'revise';

export type WritingTokenBudgetPlanV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  model_context_hint: {
    max_context_tokens: number;
    model?: string;
  };
  safety_margin_tokens: number;
  overflow_policy: TokenBudgetOverflowPolicyV1;
  per_step_budgets: Record<
    WritingTokenBudgetPlanStepV1,
    {
      reserved_output_tokens: number;
    }
  >;
  tokenizer_model?: string;
};

const StepBudgetSchema = z.object({
  reserved_output_tokens: z.number().int().nonnegative(),
}).passthrough();

const PerStepBudgetsSchema = z.object({
  outline: StepBudgetSchema,
  evidence_rerank: StepBudgetSchema,
  section_write: StepBudgetSchema,
  review: StepBudgetSchema,
  revise: StepBudgetSchema,
}).passthrough();

const WritingTokenBudgetPlanV1Schema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  run_id: z.string(),
  project_id: z.string(),
  model_context_hint: z.object({
    max_context_tokens: z.number().int().positive(),
    model: z.string().optional(),
  }).passthrough(),
  safety_margin_tokens: z.number().int().nonnegative(),
  overflow_policy: z.literal('fail_fast'),
  per_step_budgets: PerStepBudgetsSchema,
  tokenizer_model: z.string().optional(),
}).passthrough();

function nowIso(): string {
  return new Date().toISOString();
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.trunc(value)
      : typeof value === 'string'
        ? Math.trunc(Number.parseInt(value, 10))
        : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function defaultReservedOutputTokens(step: WritingTokenBudgetPlanStepV1): number {
  if (step === 'evidence_rerank') return 512;
  if (step === 'outline') return 2048;
  if (step === 'review') return 2048;
  if (step === 'revise') return 3072;
  return 4096;
}

function normalizeStepOrThrow(step: string): WritingTokenBudgetPlanStepV1 {
  const t = String(step ?? '').trim();
  if (t === 'outline') return 'outline';
  if (t === 'evidence_rerank') return 'evidence_rerank';
  if (t === 'section_write') return 'section_write';
  if (t === 'review') return 'review';
  if (t === 'revise') return 'revise';
  throw invalidParams('Unsupported token budget plan step', { step });
}

export function readWritingTokenBudgetPlanV1OrThrow(params: {
  run_id: string;
  artifact_name?: string;
}): WritingTokenBudgetPlanV1 {
  const name = params.artifact_name?.trim() ? params.artifact_name.trim() : 'writing_token_budget_plan_v1.json';
  const runId = params.run_id;
  const run = getRun(runId);

  const artifactPath = getRunArtifactPath(runId, name);
  if (!fs.existsSync(artifactPath)) {
    throw invalidParams('Missing required token budget plan artifact', {
      run_id: runId,
      artifact_name: name,
      next_actions: [
        {
          tool: HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1,
          args: { run_id: runId, model_context_tokens: 32_000 },
          reason: 'Create a TokenBudgetPlan so TokenGate can enforce fail-fast budget checks.',
        },
      ],
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as unknown;
  } catch (err) {
    throw invalidParams('Malformed JSON in token budget plan artifact', {
      run_id: runId,
      artifact_name: name,
      parse_error: err instanceof Error ? err.message : String(err),
    });
  }

  const parsed = WritingTokenBudgetPlanV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw invalidParams('Invalid token budget plan artifact: schema mismatch', {
      run_id: runId,
      artifact_name: name,
      issues: parsed.error.issues,
    });
  }

  const plan = parsed.data as WritingTokenBudgetPlanV1;
  if (plan.run_id !== runId) {
    throw invalidParams('Invalid token budget plan artifact: run_id mismatch', {
      run_id: runId,
      artifact_name: name,
      plan_run_id: plan.run_id,
    });
  }
  if (plan.project_id !== run.project_id) {
    throw invalidParams('Invalid token budget plan artifact: project_id mismatch', {
      run_id: runId,
      artifact_name: name,
      project_id: run.project_id,
      plan_project_id: plan.project_id,
    });
  }

  return plan;
}

export function createRunWritingTokenBudgetPlanV1(params: {
  run_id: string;
  model_context_tokens: number;
  model?: string;
  safety_margin_tokens?: number;
  reserved_output_tokens?: Partial<Record<WritingTokenBudgetPlanStepV1 | string, number>>;
  output_artifact_name?: string;
  tokenizer_model?: string;
}): {
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
} {
  const runId = params.run_id;
  const run = getRun(runId);

  const modelContextTokens = clampInt(params.model_context_tokens, 0, 1_024, 2_000_000);
  if (modelContextTokens <= 0) {
    throw invalidParams('model_context_tokens must be a positive integer', { model_context_tokens: params.model_context_tokens });
  }

  const safetyMarginTokens = clampInt(params.safety_margin_tokens, 512, 0, Math.max(0, modelContextTokens - 1));
  const model = params.model?.trim() ? params.model.trim() : undefined;
  const tokenizerModel = params.tokenizer_model?.trim() ? params.tokenizer_model.trim() : 'claude-opus-4-6';

  const perStepBudgets = ((): WritingTokenBudgetPlanV1['per_step_budgets'] => {
    const steps: WritingTokenBudgetPlanStepV1[] = ['outline', 'evidence_rerank', 'section_write', 'review', 'revise'];
    const out = {} as WritingTokenBudgetPlanV1['per_step_budgets'];

    const overridesRaw = params.reserved_output_tokens ?? {};
    const overrides = new Map<WritingTokenBudgetPlanStepV1, number>();
    for (const [k, v] of Object.entries(overridesRaw)) {
      if (v === undefined) continue;
      const step = normalizeStepOrThrow(k);
      overrides.set(step, clampInt(v, defaultReservedOutputTokens(step), 0, modelContextTokens));
    }

    for (const step of steps) {
      out[step] = {
        reserved_output_tokens: overrides.get(step) ?? defaultReservedOutputTokens(step),
      };
    }

    return out;
  })();

  for (const [step, budget] of Object.entries(perStepBudgets) as Array<[WritingTokenBudgetPlanStepV1, { reserved_output_tokens: number }]>) {
    const reserved = clampInt(budget.reserved_output_tokens, defaultReservedOutputTokens(step), 0, modelContextTokens);
    if (reserved + safetyMarginTokens >= modelContextTokens) {
      throw invalidParams('Token budget plan invalid: reserved_output_tokens + safety_margin_tokens must be < model_context_tokens', {
        run_id: runId,
        step,
        model_context_tokens: modelContextTokens,
        reserved_output_tokens: reserved,
        safety_margin_tokens: safetyMarginTokens,
        next_actions: [
          {
            tool: HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1,
            args: { run_id: runId, model_context_tokens: modelContextTokens + 8_000 },
            reason: 'Increase model_context_tokens (use a larger-context model).',
          },
          {
            tool: HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1,
            args: { run_id: runId, model_context_tokens: modelContextTokens, reserved_output_tokens: { [step]: Math.max(0, modelContextTokens - safetyMarginTokens - 1024) } },
            reason: 'Lower reserved_output_tokens for this step to leave room for prompt+context.',
          },
        ],
      });
    }
  }

  const artifactName = params.output_artifact_name?.trim()
    ? params.output_artifact_name.trim()
    : 'writing_token_budget_plan_v1.json';

  const payload: WritingTokenBudgetPlanV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    model_context_hint: {
      max_context_tokens: modelContextTokens,
      ...(model ? { model } : {}),
    },
    safety_margin_tokens: safetyMarginTokens,
    overflow_policy: 'fail_fast',
    per_step_budgets: perStepBudgets,
    tokenizer_model: tokenizerModel,
  };

  const ref = writeRunJsonArtifact(runId, artifactName, payload);

  return {
    run_id: runId,
    project_id: run.project_id,
    manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
    artifacts: [ref],
    summary: {
      token_budget_plan_uri: ref.uri,
      token_budget_plan_artifact: artifactName,
      model_context_tokens: modelContextTokens,
      safety_margin_tokens: safetyMarginTokens,
      overflow_policy: payload.overflow_policy,
      tokenizer_model: tokenizerModel,
      per_step_reserved_output_tokens: Object.fromEntries(
        Object.entries(payload.per_step_budgets).map(([step, b]) => [step, b.reserved_output_tokens])
      ),
    },
  };
}
