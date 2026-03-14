import { randomUUID } from 'crypto';
import { IdeaEngineContractCatalog, ContractRuntimeError } from '../contracts/catalog.js';
import { hashWithoutIdempotency } from '../hash/payload-hash.js';
import { IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import {
  initialIslandStates,
  mergeRegistryEntries,
  resolveDomainPackForCharter,
  resolveInitialIslandCount,
} from './domain-pack.js';
import { RpcError, schemaValidationError } from './errors.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { buildSeedNode, refreshIslandPopulationSizes } from './seed-node.js';

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function toSchemaError(error: unknown, detailPrefix = ''): RpcError {
  if (error instanceof RpcError) {
    return error;
  }
  if (error instanceof ContractRuntimeError) {
    return schemaValidationError(`${detailPrefix}${error.message}`);
  }
  return schemaValidationError(`${detailPrefix}${error instanceof Error ? error.message : String(error)}`);
}

export class IdeaEngineWriteService {
  readonly contracts: IdeaEngineContractCatalog;
  readonly store: IdeaEngineStore;
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(options: { contractDir?: string; createId?: () => string; now?: () => string; rootDir: string }) {
    this.store = new IdeaEngineStore(options.rootDir);
    this.contracts = new IdeaEngineContractCatalog(options.contractDir);
    this.now = options.now ?? utcNowIso;
    this.createId = options.createId ?? randomUUID;
  }

  handle(method: string, params: unknown): Record<string, unknown> {
    if (method !== 'campaign.init') {
      throw new RpcError(-32601, 'method_not_found', {
        reason: 'method_not_found',
        details: { method },
      });
    }

    try {
      this.contracts.validateRequestParams(method, params);
    } catch (error) {
      throw toSchemaError(error);
    }

    try {
      return this.campaignInit(params as Record<string, unknown>);
    } catch (error) {
      if (error instanceof RpcError) {
        this.contracts.validateErrorData(error.data);
      }
      throw error;
    }
  }

  private campaignInit(params: Record<string, unknown>): Record<string, unknown> {
    const idempotencyKeyValue = String(params.idempotency_key);
    const payloadHash = hashWithoutIdempotency('campaign.init', params);
    return this.store.withMutationLock(null, () => {
      const replay = recordOrReplay({
        campaignId: null,
        idempotencyKeyValue,
        method: 'campaign.init',
        payloadHash,
        store: this.store,
      });
      if (replay) {
        if (replay.kind === 'error') {
          throw new RpcError(-32603, 'internal_error', replay.payload);
        }
        return replay.payload;
      }

      const now = this.now();
      const charter = params.charter as Record<string, unknown>;
      const seedPack = params.seed_pack as { seeds: Array<Record<string, unknown>> };
      const campaignId = this.createId();
      const domainPack = resolveDomainPackForCharter(charter);
      const initialIslands = resolveInitialIslandCount(charter);
      if (initialIslands > seedPack.seeds.length) {
        throw schemaValidationError(
          `initial_island_count (${initialIslands}) exceeds seed count (${seedPack.seeds.length})`,
        );
      }

      const userRegistry = typeof params.abstract_problem_registry === 'object' && params.abstract_problem_registry
        ? params.abstract_problem_registry as Record<string, unknown>
        : undefined;
      const types = ((userRegistry?.entries as Array<Record<string, unknown>> | undefined) ?? [])
        .map(entry => String(entry.abstract_problem_type));
      if (types.length !== new Set(types).size) {
        throw new RpcError(-32002, 'schema_validation_failed', {
          reason: 'schema_invalid',
          details: { message: 'duplicate abstract_problem_type in abstract_problem_registry' },
        });
      }

      const campaign: Record<string, unknown> = {
        campaign_id: campaignId,
        charter: params.charter,
        seed_pack: params.seed_pack,
        budget: params.budget,
        status: 'running',
        created_at: now,
        usage: {
          tokens_used: 0,
          cost_usd_used: 0.0,
          wall_clock_s_elapsed: 0.0,
          steps_used: 0,
          nodes_used: 0,
        },
        island_states: initialIslandStates(initialIslands),
        abstract_problem_registry: mergeRegistryEntries(
          domainPack.abstractProblemRegistry,
          userRegistry,
          'abstract_problem_type',
        ),
        domain_pack: {
          pack_id: domainPack.packId,
          enabled_pack_ids: domainPack.enabledPackIds,
        },
      };

      const nodes: Record<string, Record<string, unknown>> = {};
      for (const [index, seed] of seedPack.seeds.entries()) {
        const node = buildSeedNode({
          campaignId,
          createId: this.createId,
          index,
          islandId: `island-${index % initialIslands}`,
          now,
          seed,
        });
        try {
          this.contracts.validateAgainstRef('./idea_node_v1.schema.json', node, `seed_node/${index}`);
        } catch (error) {
          throw toSchemaError(error, `seed node ${index} invalid: `);
        }
        nodes[String(node.node_id)] = node;
      }

      (campaign.usage as Record<string, unknown>).nodes_used = Object.keys(nodes).length;
      refreshIslandPopulationSizes(campaign, nodes);

      const result = {
        campaign_id: campaignId,
        status: 'running',
        created_at: now,
        budget_snapshot: budgetSnapshot(campaign as { budget: Record<string, number | null>; usage: Record<string, number> }),
        island_states: campaign.island_states,
        idempotency: responseIdempotency(idempotencyKeyValue, payloadHash),
      };
      this.contracts.validateResult('campaign.init', result);

      storeIdempotency({
        campaignId: null,
        createdAt: now,
        idempotencyKeyValue,
        kind: 'result',
        method: 'campaign.init',
        payload: result,
        payloadHash,
        state: 'prepared',
        store: this.store,
      });

      this.store.saveNodes(campaignId, nodes);
      for (const node of Object.values(nodes)) {
        this.store.appendNodeLog(campaignId, node, 'create');
      }
      this.store.saveCampaign(campaign as Record<string, unknown> & { campaign_id: string });
      storeIdempotency({
        campaignId: null,
        createdAt: now,
        idempotencyKeyValue,
        kind: 'result',
        method: 'campaign.init',
        payload: result,
        payloadHash,
        state: 'committed',
        store: this.store,
      });
      return result;
    });
  }
}
