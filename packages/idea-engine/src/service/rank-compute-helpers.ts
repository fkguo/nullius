import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import { RpcError } from './errors.js';

export function insufficientEvalDataError(options: {
  campaignId: string;
  contracts: IdeaEngineContractCatalog;
  reason: string;
}): RpcError {
  const data = { campaign_id: options.campaignId, reason: options.reason };
  options.contracts.validateErrorData(data);
  return new RpcError(-32013, 'insufficient_eval_data', data);
}

export function scorecardIndex(payload: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const index: Record<string, Record<string, unknown>> = {};
  const scorecards = payload.scorecards;
  if (!Array.isArray(scorecards)) {
    return index;
  }
  for (const card of scorecards) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      continue;
    }
    const record = card as Record<string, unknown>;
    if (typeof record.node_id !== 'string') {
      continue;
    }
    index[record.node_id] = record;
  }
  return index;
}
