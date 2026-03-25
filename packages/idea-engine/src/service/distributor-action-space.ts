import { schemaValidationError } from './errors.js';
import type { DistributorPolicyConfigRecord } from './distributor-config.js';
import type { SearchDomainPackRuntime, SearchOperator } from './search-operator.js';

export interface DistributorAction {
  actionId: string;
  backendId: string;
  islandId: string;
  operator: SearchOperator;
  operatorFamily: string;
  operatorId: string;
}

function sortStrings(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function buildDistributorActionId(backendId: string, operatorId: string, islandId: string): string {
  return `${backendId}::${operatorId}::${islandId}`;
}

function configIds(config: DistributorPolicyConfigRecord, key: 'backend_ids' | 'operator_ids' | 'island_ids'): string[] {
  const actionSpace = config.action_space as Record<string, unknown>;
  const values = actionSpace[key];
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
    throw schemaValidationError(`distributor config action_space.${key} is invalid`, { campaign_id: config.campaign_id });
  }
  return sortStrings(values as string[]);
}

function runtimeIds(runtime: SearchDomainPackRuntime, key: 'backendId' | 'operatorId'): string[] {
  return sortStrings(
    [...new Set(runtime.searchOperators.map(operator => operator.descriptor[key]))],
  );
}

function assertEqualIds(label: string, expected: string[], actual: string[], campaignId: string): void {
  if (expected.length !== actual.length || expected.some((value, index) => actual[index] !== value)) {
    throw schemaValidationError(`distributor action-space mismatch for ${label}`, { campaign_id: campaignId });
  }
}

export function validateDistributorActionSpace(options: {
  config: DistributorPolicyConfigRecord;
  islandIds: string[];
  runtime: SearchDomainPackRuntime;
}): void {
  if (options.config.action_space.factorization !== 'factorized') {
    throw schemaValidationError(`unsupported distributor factorization: ${String(options.config.action_space.factorization)}`, {
      campaign_id: options.config.campaign_id,
    });
  }
  assertEqualIds('backend_ids', configIds(options.config, 'backend_ids'), runtimeIds(options.runtime, 'backendId'), options.config.campaign_id);
  assertEqualIds('operator_ids', configIds(options.config, 'operator_ids'), runtimeIds(options.runtime, 'operatorId'), options.config.campaign_id);
  assertEqualIds('island_ids', configIds(options.config, 'island_ids'), sortStrings(options.islandIds), options.config.campaign_id);
}

export function buildEligibleDistributorActions(options: {
  config: DistributorPolicyConfigRecord;
  islandId: string;
  runtime: SearchDomainPackRuntime;
}): DistributorAction[] {
  const configIslandIds = configIds(options.config, 'island_ids');
  if (!configIslandIds.includes(options.islandId)) {
    throw schemaValidationError(`current island not declared in distributor action space: ${options.islandId}`, {
      campaign_id: options.config.campaign_id,
    });
  }
  const actions = options.runtime.searchOperators.map(operator => ({
    actionId: buildDistributorActionId(
      operator.descriptor.backendId,
      operator.descriptor.operatorId,
      options.islandId,
    ),
    backendId: operator.descriptor.backendId,
    islandId: options.islandId,
    operator,
    operatorFamily: operator.descriptor.operatorFamily,
    operatorId: operator.descriptor.operatorId,
  }));
  if (new Set(actions.map(action => action.actionId)).size !== actions.length) {
    throw schemaValidationError('duplicate distributor action ids in current runtime', {
      campaign_id: options.config.campaign_id,
    });
  }
  return actions.sort((left, right) => left.actionId.localeCompare(right.actionId));
}
