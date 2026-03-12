import { z } from 'zod';

const NonEmptyString = z.string().min(1);
const UuidString = z.string().uuid();
const UriString = z.string().url();
const LooseObject = z.record(z.string(), z.unknown());

const SeedSchema = z.object({
  seed_id: UuidString.optional(),
  seed_type: NonEmptyString,
  content: NonEmptyString,
  source_uris: z.array(UriString).optional(),
  tags: z.array(NonEmptyString).optional(),
  metadata: LooseObject.optional(),
}).strict();

const CampaignCharterSchema = z.object({
  campaign_name: NonEmptyString.optional(),
  domain: NonEmptyString,
  scope: z.string().min(10),
  approval_gate_ref: NonEmptyString,
  objectives: z.array(NonEmptyString).optional(),
  constraints: z.array(NonEmptyString).optional(),
  search_policy_id: NonEmptyString.optional(),
  team_policy_id: NonEmptyString.optional(),
  distributor: z.object({
    policy_id: NonEmptyString.optional(),
    factorization: z.enum(['joint', 'factorized']),
    policy_config_ref: UriString.optional(),
    notes: z.string().optional(),
  }).strict().optional(),
  notes: z.string().optional(),
  extensions: LooseObject.optional(),
}).strict();

const SeedPackSchema = z.object({
  seeds: z.array(SeedSchema).min(1),
  created_at: z.string().datetime().optional(),
  extensions: LooseObject.optional(),
}).strict();

const BudgetEnvelopeSchema = z.object({
  max_tokens: z.number().int().min(1),
  max_cost_usd: z.number().min(0),
  max_wall_clock_s: z.number().min(0),
  max_nodes: z.number().int().min(1).optional(),
  max_steps: z.number().int().min(1).optional(),
  degradation_order: z.array(z.enum([
    'reduce_eval_rounds',
    'reduce_islands',
    'disable_cross_domain_operators',
    'reduce_population',
    'early_stop',
  ])).optional(),
  extensions: LooseObject.optional(),
}).strict();

const AbstractProblemRegistrySchema = z.object({
  entries: z.array(z.object({
    abstract_problem_type: NonEmptyString,
    description: z.string().min(10),
    known_solution_families: z.array(NonEmptyString).min(1),
    prerequisite_checklist: z.array(NonEmptyString),
    reference_uris: z.array(UriString).min(1),
  }).strict()).min(1),
}).strict();

const BudgetTopupSchema = z.object({
  add_tokens: z.number().int().min(1).optional(),
  add_cost_usd: z.number().gt(0).optional(),
  add_wall_clock_s: z.number().gt(0).optional(),
  add_steps: z.number().int().min(1).optional(),
  add_nodes: z.number().int().min(1).optional(),
}).strict().refine(
  value => Object.keys(value).length > 0,
  'At least one top-up dimension is required',
);

const BudgetLimitSchema = z.object({
  max_tokens: z.number().int().min(1).optional(),
  max_cost_usd: z.number().min(0).optional(),
  max_wall_clock_s: z.number().min(0).optional(),
  max_steps: z.number().int().min(1).optional(),
  max_nodes: z.number().int().min(1).optional(),
}).strict().refine(
  value => Object.keys(value).length > 0,
  'At least one step_budget dimension is required',
);

const EvaluatorConfigSchema = z.object({
  dimensions: z.array(z.enum([
    'novelty',
    'feasibility',
    'impact',
    'tractability',
    'grounding',
  ])).min(1),
  n_reviewers: z.number().int().min(1),
  clean_room: z.boolean().optional(),
  debate_threshold: z.number().min(0).optional(),
  weights: z.record(z.string(), z.number().min(0)).optional(),
  extensions: LooseObject.optional(),
}).strict();

export interface IdeaToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  rpcMethod: string;
}

export const IDEA_TOOLS: IdeaToolDef[] = [
  {
    name: 'idea_campaign_init',
    description: 'Create a new idea campaign using the live charter/seed/budget contract.',
    schema: z.object({
      charter: CampaignCharterSchema,
      seed_pack: SeedPackSchema,
      budget: BudgetEnvelopeSchema,
      abstract_problem_registry: AbstractProblemRegistrySchema.optional(),
      idempotency_key: NonEmptyString,
    }).strict(),
    rpcMethod: 'campaign.init',
  },
  {
    name: 'idea_campaign_status',
    description: 'Get the current status of an idea campaign.',
    schema: z.object({ campaign_id: UuidString }).strict(),
    rpcMethod: 'campaign.status',
  },
  {
    name: 'idea_campaign_topup',
    description: 'Request an auditable budget top-up for an existing campaign.',
    schema: z.object({
      campaign_id: UuidString,
      topup: BudgetTopupSchema,
      idempotency_key: NonEmptyString,
    }).strict(),
    rpcMethod: 'campaign.topup',
  },
  {
    name: 'idea_campaign_pause',
    description: 'Pause an active campaign.',
    schema: z.object({ campaign_id: UuidString, idempotency_key: NonEmptyString }).strict(),
    rpcMethod: 'campaign.pause',
  },
  {
    name: 'idea_campaign_resume',
    description: 'Resume a paused campaign.',
    schema: z.object({ campaign_id: UuidString, idempotency_key: NonEmptyString }).strict(),
    rpcMethod: 'campaign.resume',
  },
  {
    name: 'idea_campaign_complete',
    description: 'Mark a campaign as complete and finalize results.',
    schema: z.object({ campaign_id: UuidString, idempotency_key: NonEmptyString }).strict(),
    rpcMethod: 'campaign.complete',
  },
  {
    name: 'idea_search_step',
    description: 'Execute one or more search steps in a campaign.',
    schema: z.object({
      campaign_id: UuidString,
      n_steps: z.number().int().min(1),
      step_budget: BudgetLimitSchema.optional(),
      idempotency_key: NonEmptyString,
    }).strict(),
    rpcMethod: 'search.step',
  },
  {
    name: 'idea_eval_run',
    description: 'Run deterministic multi-agent evaluation for specific idea nodes.',
    schema: z.object({
      campaign_id: UuidString,
      node_ids: z.array(UuidString).min(1).max(100),
      evaluator_config: EvaluatorConfigSchema,
      idempotency_key: NonEmptyString,
    }).strict(),
    rpcMethod: 'eval.run',
  },
];
