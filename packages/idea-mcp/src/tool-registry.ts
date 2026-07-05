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
  extensions: LooseObject.optional(),
}).strict();

const BudgetTopupSchema = z.object({
  add_tokens: z.number().int().min(1).optional(),
  add_cost_usd: z.number().positive().optional(),
  add_wall_clock_s: z.number().positive().optional(),
  add_steps: z.number().int().min(1).optional(),
  add_nodes: z.number().int().min(1).optional(),
}).strict().refine(
  value => Object.keys(value).length > 0,
  'At least one topup dimension is required',
);

const AbstractProblemRegistrySchema = z.object({
  entries: z.array(z.object({
    abstract_problem_type: NonEmptyString,
    description: z.string().min(10),
    known_solution_families: z.array(NonEmptyString).min(1),
    prerequisite_checklist: z.array(NonEmptyString),
    reference_uris: z.array(UriString).min(1),
  }).strict()).min(1),
}).strict();

/**
 * Tool risk classification (B-10).
 *
 * - `read` — pure query; no state mutation.
 * - `write` — mutates state but is reversible (e.g. pause is undone by
 *   resume) OR idempotent via `idempotency_key`. Default classification
 *   for stateful tools.
 * - `destructive` — irreversible or high-consequence. Requires the caller
 *   to pass `_confirm: true` in tool args; the request is rejected
 *   otherwise. Per MEMORY Batch 9 rule, only mark `destructive` when
 *   `_confirm` is genuinely needed; downgrade to `write` if the action is
 *   reversible.
 */
export type IdeaToolRiskLevel = 'read' | 'write' | 'destructive';

export interface IdeaToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  rpcMethod: string;
  riskLevel: IdeaToolRiskLevel;
}

/**
 * Source-of-truth raw spec list. Destructive entries get their `_confirm`
 * field injected by `applyRiskLevelToSchema` below so the Zod parse layer
 * handles both validation (must be `true`) and field acceptance (the
 * surrounding `.strict()` would otherwise reject `_confirm` as unknown).
 */
const RAW_IDEA_TOOLS: IdeaToolDef[] = [
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
    // New state but idempotent via `idempotency_key`; not destructive.
    riskLevel: 'write',
  },
  {
    name: 'idea_campaign_status',
    description: 'Get the current status of an idea campaign.',
    schema: z.object({ campaign_id: UuidString }).strict(),
    rpcMethod: 'campaign.status',
    riskLevel: 'read',
  },
  {
    name: 'idea_campaign_topup',
    description: 'Add budget to an existing campaign without creating a new runtime authority path.',
    schema: z.object({
      campaign_id: UuidString,
      topup: BudgetTopupSchema,
      idempotency_key: NonEmptyString,
    }).strict(),
    rpcMethod: 'campaign.topup',
    // Adds budget; idempotent and not destructive.
    riskLevel: 'write',
  },
  {
    name: 'idea_campaign_pause',
    description: 'Pause an active or budget-exhausted campaign.',
    schema: z.object({
      campaign_id: UuidString,
      idempotency_key: NonEmptyString,
    }).strict(),
    rpcMethod: 'campaign.pause',
    // Reversible by `idea_campaign_resume` → not destructive per the
    // MEMORY Batch-9 downgrade rule.
    riskLevel: 'write',
  },
  {
    name: 'idea_campaign_resume',
    description: 'Resume a paused or early-stopped campaign when budget remains.',
    schema: z.object({
      campaign_id: UuidString,
      idempotency_key: NonEmptyString,
    }).strict(),
    rpcMethod: 'campaign.resume',
    riskLevel: 'write',
  },
  {
    name: 'idea_campaign_complete',
    description: 'Mark a campaign complete and close further campaign mutation.',
    schema: z.object({
      campaign_id: UuidString,
      idempotency_key: NonEmptyString,
    }).strict(),
    rpcMethod: 'campaign.complete',
    // Irreversible terminal state — the description itself says
    // "close further campaign mutation". Requires explicit `_confirm: true`.
    riskLevel: 'destructive',
  },
];

/**
 * B-10: marker field name that the server strips after Zod parse.
 * Exported for the server / test layer to keep both sides in sync.
 */
export const CONFIRM_FIELD = '_confirm' as const;

/**
 * Inject `_confirm: z.literal(true)` into destructive tool schemas. The
 * surrounding schemas use `.strict()`, so adding `_confirm` via `.extend()`
 * keeps the strict-unknown contract intact while making `_confirm` an
 * explicit required field of the validated input.
 *
 * Two effects:
 *   - Validation: `_confirm` must be present and `=== true`, otherwise the
 *     Zod parse rejects with a structured error.
 *   - Inventory: the JSON schema exposed via `ListTools` includes
 *     `_confirm` in `required`, so clients see the gate without needing
 *     out-of-band documentation.
 *
 * The server strips `_confirm` from the parsed params before forwarding to
 * `rpc.call(...)` (see `server.ts`), so the idea-engine backend does not
 * observe the confirmation field.
 */
function applyRiskLevelToSchema(spec: IdeaToolDef): IdeaToolDef {
  if (spec.riskLevel !== 'destructive') return spec;
  if (!(spec.schema instanceof z.ZodObject)) {
    // All current spec schemas are `z.object(...).strict()`. If a future
    // schema is not a ZodObject (e.g. a discriminated union), the author
    // must thread `_confirm` through that schema explicitly.
    throw new Error(
      `applyRiskLevelToSchema: destructive tool "${spec.name}" must use a top-level z.object(...) schema`,
    );
  }
  const augmented = (spec.schema as z.ZodObject<Record<string, z.ZodTypeAny>>)
    .extend({
      [CONFIRM_FIELD]: z.literal(true, {
        message: `${spec.name} is a destructive operation; pass _confirm: true to execute.`,
      }),
    })
    .strict();
  return { ...spec, schema: augmented };
}

export const IDEA_TOOLS: IdeaToolDef[] = RAW_IDEA_TOOLS.map(applyRiskLevelToSchema);
