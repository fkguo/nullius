import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import { budgetSnapshot } from './budget-snapshot.js';
import type { CampaignRecord } from './campaign-state.js';
import { responseIdempotency } from './idempotency.js';
import { nodeLifecycleReason, type NodeLifecycleState } from './node-shared.js';

export interface IdeaCardRevisionPlan {
  mutationEvent: Record<string, unknown>;
  now: string;
  result: Record<string, unknown>;
  updatedNode: Record<string, unknown>;
}

/** Build and contract-check the exact node/event persisted by the executor. */
export function planIdeaCardRevision(options: {
  afterIdeaCardHash: string;
  beforeIdeaCardHash: string;
  campaign: CampaignRecord;
  campaignId: string;
  contracts: IdeaEngineContractCatalog;
  currentCard: Record<string, unknown>;
  currentRevision: number;
  expectedRevision: number;
  idempotencyKey: string;
  node: Record<string, unknown>;
  nodeId: string;
  now: string;
  payloadHash: string;
  previousLifecycle: NodeLifecycleState;
  reason: string;
  replacementCard: Record<string, unknown>;
}): IdeaCardRevisionPlan {
  const updatedNode = structuredClone(options.node);
  updatedNode.idea_card = options.replacementCard;
  updatedNode.grounding_audit = null;
  updatedNode.posterior = null;
  updatedNode.literature_coverage = null;
  updatedNode.reduction_report = null;
  updatedNode.reduction_audit = null;
  updatedNode.lifecycle_state = 'candidate';
  updatedNode.lifecycle_reason = 'idea_card_revised';
  updatedNode.activation_condition = null;
  updatedNode.revision = options.currentRevision + 1;
  updatedNode.updated_at = options.now;
  options.contracts.validateAgainstRef('./idea_node_v1.schema.json', updatedNode, `node.revise_card/node/${options.nodeId}`);

  const idempotency = responseIdempotency(options.idempotencyKey, options.payloadHash);
  const mutationEvent = {
    mutation: 'revise_card',
    campaign_id: options.campaignId,
    node_id: options.nodeId,
    idea_id: String(updatedNode.idea_id),
    expected_revision: options.expectedRevision,
    revision: Number(updatedNode.revision),
    reason: options.reason,
    before_idea_card_hash: options.beforeIdeaCardHash,
    after_idea_card_hash: options.afterIdeaCardHash,
    before_node: structuredClone(options.node),
    before: {
      revision: options.currentRevision,
      idea_card: structuredClone(options.currentCard),
      grounding_audit: structuredClone(options.node.grounding_audit ?? null),
      posterior: structuredClone(options.node.posterior ?? null),
      literature_coverage: structuredClone(options.node.literature_coverage ?? null),
      reduction_report: structuredClone(options.node.reduction_report ?? null),
      reduction_audit: structuredClone(options.node.reduction_audit ?? null),
      lifecycle_state: options.previousLifecycle,
      lifecycle_reason: nodeLifecycleReason(options.node),
      activation_condition: structuredClone(options.node.activation_condition ?? null),
      updated_at: typeof options.node.updated_at === 'string' ? options.node.updated_at : null,
    },
    invalidations: {
      grounding_audit: options.node.grounding_audit != null,
      posterior: options.node.posterior != null,
      literature_coverage: options.node.literature_coverage != null,
      reduction_report: options.node.reduction_report != null,
      reduction_audit: options.node.reduction_audit != null,
      activation_condition: options.node.activation_condition != null,
      allocation_eligibility: true,
    },
    occurred_at: options.now,
    idempotency: structuredClone(idempotency),
    node: structuredClone(updatedNode),
  };
  options.contracts.validateAgainstRef('./idea_card_revision_event_v1.schema.json', mutationEvent, `node.revise_card/mutation_event/${options.nodeId}`);
  const result = {
    budget_snapshot: budgetSnapshot(options.campaign),
    campaign_id: options.campaignId,
    idempotency,
    mutation_event: mutationEvent,
    node: updatedNode,
  };
  options.contracts.validateResult('node.revise_card', result);
  return { mutationEvent, now: options.now, result, updatedNode };
}
