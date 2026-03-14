import { IdeaEngineStore } from '../store/engine-store.js';
import { RpcError } from './errors.js';
import { filterNodes, type NodeRecord, type NodeListFilter } from './filter-nodes.js';
import { validateReadParams } from './validators.js';

interface CampaignRecord extends Record<string, unknown> {
  campaign_id: string;
  status: string;
  created_at: string;
  budget: Record<string, number | null>;
  usage: Record<string, number>;
  island_states: unknown[];
  early_stop_reason?: string;
}

function budgetSnapshot(campaign: CampaignRecord): Record<string, number | null> {
  const stepsRemaining = campaign.budget.max_steps === undefined || campaign.budget.max_steps === null
    ? null
    : Math.max(Number(campaign.budget.max_steps) - Number(campaign.usage.steps_used), 0);
  const nodesRemaining = campaign.budget.max_nodes === undefined || campaign.budget.max_nodes === null
    ? null
    : Math.max(Number(campaign.budget.max_nodes) - Number(campaign.usage.nodes_used), 0);

  return {
    tokens_used: Number(campaign.usage.tokens_used),
    tokens_remaining: Math.max(Number(campaign.budget.max_tokens) - Number(campaign.usage.tokens_used), 0),
    cost_usd_used: Number(campaign.usage.cost_usd_used),
    cost_usd_remaining: Math.max(Number(campaign.budget.max_cost_usd) - Number(campaign.usage.cost_usd_used), 0),
    wall_clock_s_elapsed: Number(campaign.usage.wall_clock_s_elapsed),
    wall_clock_s_remaining: Math.max(Number(campaign.budget.max_wall_clock_s) - Number(campaign.usage.wall_clock_s_elapsed), 0),
    steps_used: Number(campaign.usage.steps_used),
    steps_remaining: stepsRemaining,
    nodes_used: Number(campaign.usage.nodes_used),
    nodes_remaining: nodesRemaining,
  };
}

export class IdeaEngineReadService {
  readonly store: IdeaEngineStore;

  constructor(options: { rootDir: string }) {
    this.store = new IdeaEngineStore(options.rootDir);
  }

  handle(method: string, params: unknown): Record<string, unknown> {
    if (!['campaign.status', 'node.get', 'node.list'].includes(method)) {
      throw new RpcError(-32601, 'method_not_found', {
        reason: 'method_not_found',
        details: { method },
      });
    }

    const validated = validateReadParams(method, params);
    if (method === 'campaign.status') return this.campaignStatus(validated.campaign_id as string);
    if (method === 'node.get') return this.nodeGet(validated.campaign_id as string, validated.node_id as string);
    return this.nodeList(
      validated.campaign_id as string,
      validated.filter as NodeListFilter | undefined,
      validated.cursor as string | undefined,
      validated.limit as number,
    );
  }

  private loadCampaignOrError(campaignId: string): CampaignRecord {
    const campaign = this.store.loadCampaign<CampaignRecord>(campaignId);
    if (!campaign || campaign.campaign_id !== campaignId) {
      throw new RpcError(-32003, 'campaign_not_found', {
        reason: 'campaign_not_found',
        campaign_id: campaignId,
      });
    }
    return campaign;
  }

  private campaignStatus(campaignId: string): Record<string, unknown> {
    return this.store.withMutationLock(campaignId, () => {
      const campaign = this.loadCampaignOrError(campaignId);
      const nodes = this.store.loadNodes<NodeRecord>(campaign.campaign_id);
      const result: Record<string, unknown> = {
        campaign_id: campaign.campaign_id,
        status: campaign.status,
        created_at: campaign.created_at,
        budget_snapshot: budgetSnapshot(campaign),
        island_states: campaign.island_states,
        node_count: Object.keys(nodes).length,
      };
      if (campaign.status === 'early_stopped') {
        result.early_stop_reason = campaign.early_stop_reason ?? 'policy_halt';
      }
      return result;
    });
  }

  private nodeGet(campaignId: string, nodeId: string): Record<string, unknown> {
    return this.store.withMutationLock(campaignId, () => {
      const campaign = this.loadCampaignOrError(campaignId);
      const nodes = this.store.loadNodes<NodeRecord>(campaign.campaign_id);
      const node = nodes[nodeId];
      if (!node) {
        throw new RpcError(-32004, 'node_not_found', {
          reason: 'node_not_found',
          campaign_id: campaignId,
          node_id: nodeId,
        });
      }
      if (node.campaign_id !== campaignId) {
        throw new RpcError(-32014, 'node_not_in_campaign', {
          reason: 'node_not_in_campaign',
          campaign_id: campaignId,
          node_id: nodeId,
        });
      }
      return node;
    });
  }

  private nodeList(
    campaignId: string,
    filter: NodeListFilter | undefined,
    cursor: string | undefined,
    limit: number,
  ): Record<string, unknown> {
    return this.store.withMutationLock(campaignId, () => {
      const campaign = this.loadCampaignOrError(campaignId);
      const nodes = this.store.loadNodes<NodeRecord>(campaign.campaign_id);
      const filtered = filterNodes(nodes, filter).sort((left, right) => {
        const leftCreated = String(left.created_at ?? '');
        const rightCreated = String(right.created_at ?? '');
        if (leftCreated < rightCreated) return -1;
        if (leftCreated > rightCreated) return 1;
        if (left.node_id < right.node_id) return -1;
        if (left.node_id > right.node_id) return 1;
        return 0;
      });

      const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
      if (!Number.isInteger(start)) {
        throw new RpcError(-32002, 'schema_validation_failed', {
          reason: 'schema_invalid',
          details: { message: 'cursor must be an integer offset string' },
        });
      }
      if (start < 0) {
        throw new RpcError(-32002, 'schema_validation_failed', {
          reason: 'schema_invalid',
          details: { message: 'cursor must be >= 0' },
        });
      }

      const page = filtered.slice(start, start + limit);
      const nextCursor = start + limit < filtered.length ? String(start + limit) : null;
      return {
        campaign_id: campaignId,
        nodes: page,
        cursor: nextCursor,
        total_count: filtered.length,
      };
    });
  }
}
