import { IdeaEngineStore } from '../store/engine-store.js';
import { exhaustedDimensions } from './budget-snapshot.js';
import { RpcError } from './errors.js';

export interface CampaignRecord extends Record<string, unknown> {
  budget: Record<string, number | null>;
  campaign_id: string;
  charter: Record<string, unknown>;
  status: string;
  usage: Record<string, number>;
}

export function loadCampaignOrError(store: IdeaEngineStore, campaignId: string): CampaignRecord {
  const campaign = store.loadCampaign<CampaignRecord>(campaignId);
  if (!campaign || campaign.campaign_id !== campaignId) {
    throw new RpcError(-32003, 'campaign_not_found', { reason: 'campaign_not_found', campaign_id: campaignId });
  }
  return campaign;
}

export function ensureCampaignRunning(campaign: CampaignRecord): void {
  if (campaign.status === 'exhausted') {
    const exhausted = exhaustedDimensions(campaign);
    throw new RpcError(-32001, 'budget_exhausted', {
      reason: 'dimension_exhausted',
      campaign_id: campaign.campaign_id,
      details: { exhausted_dimensions: exhausted.length > 0 ? exhausted : ['steps'] },
    });
  }
  if (campaign.status !== 'running') {
    throw new RpcError(-32015, 'campaign_not_active', { reason: 'campaign_not_active', campaign_id: campaign.campaign_id });
  }
}

export function ensureCampaignNotCompleted(campaign: CampaignRecord): void {
  if (campaign.status === 'completed') {
    throw new RpcError(-32015, 'campaign_not_active', { reason: 'campaign_not_active', campaign_id: campaign.campaign_id });
  }
}

export function setCampaignRunningIfBudgetAvailable(campaign: CampaignRecord): void {
  campaign.status = exhaustedDimensions(campaign).length > 0 ? 'exhausted' : 'running';
}
