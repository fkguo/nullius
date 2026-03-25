import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { buildDistributorPolicyConfig } from './distributor-config.js';
import {
  initialIslandStates,
  mergeRegistryEntries,
  resolveDomainPackForCharter,
  resolveInitialIslandCount,
} from './domain-pack.js';
import { loadBuiltinSearchDomainPackRuntime } from './domain-pack-registry.js';
import { RpcError, schemaValidationError } from './errors.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { refreshIslandPopulationSizes } from './island-state.js';
import { buildSeedNode } from './seed-node.js';
import { toSchemaError } from './service-contract-error.js';

export function executeCampaignInit(options: {
  contracts: IdeaEngineContractCatalog;
  createId: () => string;
  now: () => string;
  params: Record<string, unknown>;
  payloadHash: string;
  store: IdeaEngineStore;
}): Record<string, unknown> {
  const idempotencyKeyValue = String(options.params.idempotency_key);
  const { payloadHash } = options;
  return options.store.withMutationLock(null, () => {
    const replay = recordOrReplay({
      campaignId: null,
      idempotencyKeyValue,
      method: 'campaign.init',
      payloadHash,
      store: options.store,
    });
    if (replay) {
      if (replay.kind === 'error') throw new RpcError(-32603, 'internal_error', replay.payload);
      return replay.payload;
    }
    const now = options.now();
    const charter = options.params.charter as Record<string, unknown>;
    const seedPack = options.params.seed_pack as { seeds: Array<Record<string, unknown>> };
    const campaignId = options.createId();
    const domainPack = resolveDomainPackForCharter(charter);
    const initialIslands = resolveInitialIslandCount(charter);
    if (initialIslands > seedPack.seeds.length) {
      throw schemaValidationError(`initial_island_count (${initialIslands}) exceeds seed count (${seedPack.seeds.length})`);
    }
    const userRegistry = typeof options.params.abstract_problem_registry === 'object' && options.params.abstract_problem_registry
      ? options.params.abstract_problem_registry as Record<string, unknown>
      : undefined;
    const types = ((userRegistry?.entries as Array<Record<string, unknown>> | undefined) ?? []).map(entry => String(entry.abstract_problem_type));
    if (types.length !== new Set(types).size) {
      throw new RpcError(-32002, 'schema_validation_failed', {
        reason: 'schema_invalid',
        details: { message: 'duplicate abstract_problem_type in abstract_problem_registry' },
      });
    }
    const islandStates = initialIslandStates(initialIslands);
    let distributorConfig: ReturnType<typeof buildDistributorPolicyConfig> = null;
    const distributorEnabled = typeof charter.distributor === 'object' && charter.distributor !== null && !Array.isArray(charter.distributor);
    if (distributorEnabled) {
      try {
        distributorConfig = buildDistributorPolicyConfig({
          campaignId,
          charter,
          contracts: options.contracts,
          islandIds: islandStates.map(state => String(state.island_id)),
          now,
          runtime: loadBuiltinSearchDomainPackRuntime(domainPack.packId),
          store: options.store,
        });
      } catch (error) {
        if (error instanceof RpcError) {
          throw error;
        }
        throw schemaValidationError(
          `failed to build distributor config for domain pack ${domainPack.packId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const campaign: Record<string, unknown> = {
      campaign_id: campaignId,
      charter: options.params.charter,
      seed_pack: options.params.seed_pack,
      budget: options.params.budget,
      status: 'running',
      created_at: now,
      usage: { tokens_used: 0, cost_usd_used: 0.0, wall_clock_s_elapsed: 0.0, steps_used: 0, nodes_used: 0 },
      island_states: islandStates,
      abstract_problem_registry: mergeRegistryEntries(domainPack.abstractProblemRegistry, userRegistry, 'abstract_problem_type'),
      domain_pack: { pack_id: domainPack.packId, enabled_pack_ids: domainPack.enabledPackIds },
      ...(distributorConfig ? { distributor_policy_config_ref: distributorConfig.artifactRef } : {}),
    };
    const nodes: Record<string, Record<string, unknown>> = {};
    for (const [index, seed] of seedPack.seeds.entries()) {
      const node = buildSeedNode({
        campaignId,
        createId: options.createId,
        index,
        islandId: `island-${index % initialIslands}`,
        now,
        seed,
      });
      try {
        options.contracts.validateAgainstRef('./idea_node_v1.schema.json', node, `seed_node/${index}`);
      } catch (error) {
        throw toSchemaError(error, `seed node ${index} invalid: `);
      }
      nodes[String(node.node_id)] = node;
    }
    (campaign.usage as Record<string, unknown>).nodes_used = Object.keys(nodes).length;
    refreshIslandPopulationSizes(campaign, nodes);
    const result: Record<string, unknown> = {
      campaign_id: campaignId,
      status: 'running',
      created_at: now,
      budget_snapshot: budgetSnapshot(campaign as { budget: Record<string, number | null>; usage: Record<string, number> }),
      island_states: campaign.island_states,
      idempotency: responseIdempotency(idempotencyKeyValue, payloadHash),
      ...(distributorConfig ? { distributor_policy_config_ref: distributorConfig.artifactRef } : {}),
    };
    options.contracts.validateResult('campaign.init', result);
    storeIdempotency({
      campaignId: null,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'campaign.init',
      payload: result,
      payloadHash,
      state: 'prepared',
      store: options.store,
    });
    if (distributorConfig) {
      options.store.writeArtifact(campaignId, 'distributor', distributorConfig.artifactName, distributorConfig.payload);
    }
    options.store.saveNodes(campaignId, nodes);
    for (const node of Object.values(nodes)) options.store.appendNodeLog(campaignId, node, 'create');
    options.store.saveCampaign(campaign as Record<string, unknown> & { campaign_id: string });
    storeIdempotency({
      campaignId: null,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'campaign.init',
      payload: result,
      payloadHash,
      state: 'committed',
      store: options.store,
    });
    return result;
  });
}
