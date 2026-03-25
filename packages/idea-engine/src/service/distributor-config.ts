import { pathToFileURL } from 'url';
import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { schemaValidationError } from './errors.js';
import type { SearchDomainPackRuntime } from './search-operator.js';

const DISTRIBUTOR_ARTIFACT_TYPE = 'distributor';
const DISTRIBUTOR_CONFIG_NAME = 'distributor_policy_config_v1.json';

export const DISTRIBUTOR_POLICY_ID = 'ts.discounted_ucb_v1';
export const DISTRIBUTOR_POLICY_FAMILY = 'discounted_ucb_v';
export const DISTRIBUTOR_HYPERPARAMETERS = {
  discount: 0.85,
  exploration_scale: 1.0,
  reward_upper_bound: 1.25,
};

interface DistributorActionSpace extends Record<string, unknown> {
  backend_ids: string[];
  factorization: string;
  island_ids: string[];
  operator_ids: string[];
}

export interface DistributorPolicyConfigRecord extends Record<string, unknown> {
  action_space: DistributorActionSpace;
  campaign_id: string;
  cost_mapping?: Record<string, unknown>;
  created_at: string;
  hyperparameters?: Record<string, unknown>;
  policy_family: string;
  policy_id: string;
  reward_mapping?: Record<string, unknown>;
}

export function distributorPolicyConfigRef(store: IdeaEngineStore, campaignId: string): string {
  return pathToFileURL(store.artifactPath(campaignId, DISTRIBUTOR_ARTIFACT_TYPE, DISTRIBUTOR_CONFIG_NAME)).href;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function distributorConfigActionSpace(runtime: SearchDomainPackRuntime, islandIds: string[]): DistributorActionSpace {
  const backendIds = sortedUnique(runtime.searchOperators.map(operator => operator.descriptor.backendId));
  const operatorIds = sortedUnique(runtime.searchOperators.map(operator => operator.descriptor.operatorId));
  return {
    factorization: 'factorized',
    backend_ids: backendIds,
    operator_ids: operatorIds,
    island_ids: sortedUnique(islandIds),
  };
}

export function buildDistributorPolicyConfig(options: {
  campaignId: string;
  charter: Record<string, unknown>;
  contracts: IdeaEngineContractCatalog;
  islandIds: string[];
  now: string;
  runtime: SearchDomainPackRuntime;
  store: IdeaEngineStore;
}): { artifactName: string; artifactRef: string; payload: DistributorPolicyConfigRecord } | null {
  const distributor = options.charter.distributor;
  if (!distributor || typeof distributor !== 'object' || Array.isArray(distributor)) {
    return null;
  }
  const policy = distributor as Record<string, unknown>;
  if (typeof policy.policy_id !== 'string' || !policy.policy_id) {
    throw schemaValidationError('charter.distributor.policy_id is required when distributor is enabled');
  }
  if (policy.policy_id !== DISTRIBUTOR_POLICY_ID) {
    throw schemaValidationError(`unsupported distributor policy_id: ${String(policy.policy_id)}`);
  }
  if (policy.factorization !== 'factorized') {
    throw schemaValidationError(`unsupported distributor factorization: ${String(policy.factorization)}`);
  }
  if (policy.policy_config_ref !== undefined) {
    throw schemaValidationError('charter.distributor.policy_config_ref is unsupported in EVO-11 slice-1');
  }
  const payload: DistributorPolicyConfigRecord = {
    campaign_id: options.campaignId,
    policy_id: DISTRIBUTOR_POLICY_ID,
    policy_family: DISTRIBUTOR_POLICY_FAMILY,
    action_space: distributorConfigActionSpace(options.runtime, options.islandIds),
    reward_mapping: {
      score_weights: {
        node_committed: 1.0,
        island_best_score_improved: 0.25,
      },
      gate_fail_penalty: 0,
      reward_range: [0, DISTRIBUTOR_HYPERPARAMETERS.reward_upper_bound],
    },
    cost_mapping: {
      lambda_cost: 0,
      cost_unit: 'slice1_runtime_units',
    },
    hyperparameters: structuredClone(DISTRIBUTOR_HYPERPARAMETERS),
    created_at: options.now,
    extensions: {
      action_id_format: 'backend_id::operator_id::island_id',
      lane: 'EVO-11-first-deliverable',
    },
  };
  options.contracts.validateAgainstRef(
    './distributor_policy_config_v1.schema.json',
    payload,
    `campaign.init/distributor_policy_config/${options.campaignId}`,
  );
  return {
    artifactName: DISTRIBUTOR_CONFIG_NAME,
    artifactRef: distributorPolicyConfigRef(options.store, options.campaignId),
    payload,
  };
}

export function loadDistributorPolicyConfig(options: {
  campaign: Record<string, unknown>;
  contracts: IdeaEngineContractCatalog;
  store: IdeaEngineStore;
}): { config: DistributorPolicyConfigRecord; configRef: string } | null {
  const ref = options.campaign.distributor_policy_config_ref;
  if (typeof ref !== 'string' || !ref) {
    return null;
  }
  const config = options.store.loadArtifactFromRef<DistributorPolicyConfigRecord>(ref);
  options.contracts.validateAgainstRef(
    './distributor_policy_config_v1.schema.json',
    config,
    `search.step/distributor_policy_config/${String(options.campaign.campaign_id)}`,
  );
  if (config.campaign_id !== options.campaign.campaign_id) {
    throw schemaValidationError('distributor config campaign_id does not match campaign', {
      campaign_id: String(options.campaign.campaign_id),
    });
  }
  if (config.policy_id !== DISTRIBUTOR_POLICY_ID || config.policy_family !== DISTRIBUTOR_POLICY_FAMILY) {
    throw schemaValidationError('distributor config policy does not match EVO-11 slice-1 runtime', {
      campaign_id: String(options.campaign.campaign_id),
    });
  }
  return { config, configRef: ref };
}
