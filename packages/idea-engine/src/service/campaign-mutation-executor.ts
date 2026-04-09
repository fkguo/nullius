import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot, exhaustedDimensions } from './budget-snapshot.js';
import { RpcError, schemaValidationError } from './errors.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { refreshIslandPopulationSizes } from './island-state.js';
import { loadCampaignOrError, type SearchCampaignRecord } from './search-step-campaign.js';

type CampaignMutationMethod =
  | 'campaign.topup'
  | 'campaign.pause'
  | 'campaign.resume'
  | 'campaign.complete';

const TOPUP_FIELD_MAP = [
  ['add_tokens', 'max_tokens'],
  ['add_cost_usd', 'max_cost_usd'],
  ['add_wall_clock_s', 'max_wall_clock_s'],
  ['add_steps', 'max_steps'],
  ['add_nodes', 'max_nodes'],
] as const;

function budgetExhaustedError(campaign: SearchCampaignRecord): RpcError {
  const exhausted = exhaustedDimensions(campaign);
  return new RpcError(-32001, 'budget_exhausted', {
    reason: 'dimension_exhausted',
    campaign_id: campaign.campaign_id,
    details: { exhausted_dimensions: exhausted.length > 0 ? exhausted : ['steps'] },
  });
}

function campaignNotActive(campaignId: string): RpcError {
  return new RpcError(-32015, 'campaign_not_active', {
    reason: 'campaign_not_active',
    campaign_id: campaignId,
  });
}

function restoreBudgetReadyIslandStates(campaign: SearchCampaignRecord): void {
  for (const island of campaign.island_states) {
    if (String(island.state ?? '') !== 'EXHAUSTED') {
      continue;
    }
    const populationSize = Number(island.population_size ?? 0);
    island.state = populationSize > 0 ? 'EXPLORING' : 'SEEDING';
    island.stagnation_counter = 0;
  }
}

function buildCampaignStatus(
  campaign: SearchCampaignRecord,
  nodes: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    campaign_id: campaign.campaign_id,
    status: campaign.status,
    created_at: campaign.created_at,
    budget_snapshot: budgetSnapshot(campaign),
    island_states: structuredClone(campaign.island_states),
    node_count: Object.keys(nodes).length,
  };
  if (campaign.status === 'early_stopped') {
    result.early_stop_reason = typeof campaign.early_stop_reason === 'string'
      ? campaign.early_stop_reason
      : 'policy_halt';
  }
  if (typeof campaign.distributor_policy_config_ref === 'string') {
    result.distributor_policy_config_ref = campaign.distributor_policy_config_ref;
  }
  if (typeof campaign.last_step_id === 'string') {
    result.last_step_id = campaign.last_step_id;
  }
  return result;
}

function clearEarlyStopReason(campaign: SearchCampaignRecord): void {
  delete campaign.early_stop_reason;
}

function applyTopup(
  campaign: SearchCampaignRecord,
  topup: Record<string, unknown>,
): void {
  for (const [topupKey, budgetKey] of TOPUP_FIELD_MAP) {
    if (!(topupKey in topup)) {
      continue;
    }
    const current = campaign.budget[budgetKey];
    if (current === null || current === undefined) {
      throw schemaValidationError(
        `budget topup requires bounded ${budgetKey}; campaign budget is unbounded or missing`,
        { campaign_id: campaign.campaign_id },
      );
    }
    campaign.budget[budgetKey] = Number(current) + Number(topup[topupKey]);
  }
}

function mutateCampaign(
  campaign: SearchCampaignRecord,
  method: CampaignMutationMethod,
  params: Record<string, unknown>,
): { changed: boolean; exhaustedAfter: string[]; mutation: 'topup' | 'pause' | 'resume' | 'complete'; previousStatus: string } {
  const previousStatus = String(campaign.status);

  if (method === 'campaign.topup') {
    if (previousStatus === 'completed') {
      throw campaignNotActive(campaign.campaign_id);
    }
    applyTopup(campaign, params.topup as Record<string, unknown>);
    const exhaustedAfter = exhaustedDimensions(campaign);
    if (previousStatus === 'exhausted' && exhaustedAfter.length === 0) {
      campaign.status = 'running';
      restoreBudgetReadyIslandStates(campaign);
      clearEarlyStopReason(campaign);
      return { changed: true, exhaustedAfter, mutation: 'topup', previousStatus };
    }
    campaign.status = previousStatus;
    return { changed: false, exhaustedAfter, mutation: 'topup', previousStatus };
  }

  if (method === 'campaign.pause') {
    if (!['running', 'early_stopped', 'exhausted'].includes(previousStatus)) {
      throw campaignNotActive(campaign.campaign_id);
    }
    campaign.status = 'paused';
    clearEarlyStopReason(campaign);
    return {
      changed: true,
      exhaustedAfter: exhaustedDimensions(campaign),
      mutation: 'pause',
      previousStatus,
    };
  }

  if (method === 'campaign.resume') {
    if (previousStatus === 'exhausted') {
      throw budgetExhaustedError(campaign);
    }
    if (!['paused', 'early_stopped'].includes(previousStatus)) {
      throw campaignNotActive(campaign.campaign_id);
    }
    const exhaustedAfter = exhaustedDimensions(campaign);
    if (exhaustedAfter.length > 0) {
      throw budgetExhaustedError(campaign);
    }
    campaign.status = 'running';
    restoreBudgetReadyIslandStates(campaign);
    clearEarlyStopReason(campaign);
    return { changed: true, exhaustedAfter, mutation: 'resume', previousStatus };
  }

  if (previousStatus !== 'completed') {
    campaign.status = 'completed';
    clearEarlyStopReason(campaign);
    return {
      changed: true,
      exhaustedAfter: exhaustedDimensions(campaign),
      mutation: 'complete',
      previousStatus,
    };
  }

  return {
    changed: false,
    exhaustedAfter: exhaustedDimensions(campaign),
    mutation: 'complete',
    previousStatus,
  };
}

export function executeCampaignMutation(options: {
  contracts: IdeaEngineContractCatalog;
  method: CampaignMutationMethod;
  now: () => string;
  params: Record<string, unknown>;
  payloadHash: string;
  store: IdeaEngineStore;
}): Record<string, unknown> {
  const campaignId = String(options.params.campaign_id);
  const idempotencyKeyValue = String(options.params.idempotency_key);
  const { payloadHash } = options;
  return options.store.withMutationLock(campaignId, () => {
    const replay = recordOrReplay({
      campaignId,
      idempotencyKeyValue,
      method: options.method,
      payloadHash,
      store: options.store,
    });
    if (replay) {
      if (replay.kind === 'error') {
        throw new RpcError(-32603, 'internal_error', replay.payload);
      }
      return replay.payload;
    }

    const campaign = loadCampaignOrError(options.store, campaignId);
    const nodes = options.store.loadNodes<Record<string, unknown>>(campaignId);
    const plannedCampaign = structuredClone(campaign);
    refreshIslandPopulationSizes(plannedCampaign, nodes);

    const mutation = mutateCampaign(plannedCampaign, options.method, options.params);
    const campaignStatus = buildCampaignStatus(plannedCampaign, nodes);
    const result: Record<string, unknown> = {
      mutation: mutation.mutation,
      transition: {
        previous_status: mutation.previousStatus,
        current_status: String(plannedCampaign.status),
        changed: mutation.changed,
        exhausted_dimensions_after: mutation.exhaustedAfter,
      },
      campaign_status: campaignStatus,
      idempotency: responseIdempotency(idempotencyKeyValue, payloadHash),
    };

    options.contracts.validateResult(options.method, result);
    storeIdempotency({
      campaignId,
      createdAt: options.now(),
      idempotencyKeyValue,
      kind: 'result',
      method: options.method,
      payload: result,
      payloadHash,
      state: 'prepared',
      store: options.store,
    });
    options.store.saveCampaign(plannedCampaign as Record<string, unknown> & { campaign_id: string });
    storeIdempotency({
      campaignId,
      createdAt: options.now(),
      idempotencyKeyValue,
      kind: 'result',
      method: options.method,
      payload: result,
      payloadHash,
      state: 'committed',
      store: options.store,
    });
    return result;
  });
}
