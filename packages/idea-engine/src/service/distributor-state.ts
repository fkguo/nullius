import { readJsonFile, writeJsonFileAtomic } from '../store/file-io.js';
import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { schemaValidationError } from './errors.js';
import type { DistributorPolicyConfigRecord } from './distributor-config.js';
import { initializeDistributorState, type DistributorStateSnapshot } from './distributor-discounted-ucb-v.js';

const DISTRIBUTOR_STATE_NAME = 'distributor_state_snapshot_v1.json';
const DISTRIBUTOR_ARTIFACT_TYPE = 'distributor';

export function distributorStatePath(store: IdeaEngineStore, campaignId: string): string {
  return store.artifactPath(campaignId, DISTRIBUTOR_ARTIFACT_TYPE, DISTRIBUTOR_STATE_NAME);
}

export function loadDistributorState(options: {
  actionIds: string[];
  campaignId: string;
  contracts: IdeaEngineContractCatalog;
  policyId: string;
  store: IdeaEngineStore;
  timestamp: string;
}): DistributorStateSnapshot {
  const path = distributorStatePath(options.store, options.campaignId);
  const snapshot = readJsonFile<DistributorStateSnapshot | null>(path, null);
  if (!snapshot) {
    return initializeDistributorState({
      actionIds: options.actionIds,
      campaignId: options.campaignId,
      policyId: options.policyId,
      timestamp: options.timestamp,
    });
  }
  options.contracts.validateAgainstRef(
    './distributor_state_snapshot_v1.schema.json',
    snapshot,
    `search.step/distributor_state/${options.campaignId}`,
  );
  if (snapshot.campaign_id !== options.campaignId || snapshot.policy_id !== options.policyId) {
    throw schemaValidationError('distributor state snapshot does not match campaign/policy', {
      campaign_id: options.campaignId,
    });
  }
  const snapshotActionIds = Object.keys(snapshot.action_stats).sort((left, right) => left.localeCompare(right));
  const expectedActionIds = [...options.actionIds].sort((left, right) => left.localeCompare(right));
  if (snapshotActionIds.length !== expectedActionIds.length || snapshotActionIds.some((value, index) => value !== expectedActionIds[index])) {
    throw schemaValidationError('distributor state snapshot action ids do not match runtime action space', {
      campaign_id: options.campaignId,
    });
  }
  return snapshot;
}

export function saveDistributorState(options: {
  config: DistributorPolicyConfigRecord;
  contracts: IdeaEngineContractCatalog;
  snapshot: DistributorStateSnapshot;
  store: IdeaEngineStore;
}): void {
  options.contracts.validateAgainstRef(
    './distributor_state_snapshot_v1.schema.json',
    options.snapshot,
    `search.step/distributor_state/${options.config.campaign_id}`,
  );
  writeJsonFileAtomic(distributorStatePath(options.store, options.config.campaign_id), options.snapshot);
}
