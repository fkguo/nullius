import { IdeaEngineStore } from '../store/engine-store.js';
import { exhaustedDimensions } from './budget-snapshot.js';
import { RpcError, schemaValidationError } from './errors.js';

export interface SearchCampaignRecord extends Record<string, unknown> {
  budget: Record<string, number | null>;
  campaign_id: string;
  charter: Record<string, unknown>;
  island_states: Array<Record<string, unknown>>;
  status: string;
  usage: Record<string, number>;
}

export function loadCampaignOrError(store: IdeaEngineStore, campaignId: string): SearchCampaignRecord {
  const campaign = store.loadCampaign<SearchCampaignRecord>(campaignId);
  if (!campaign || campaign.campaign_id !== campaignId) {
    throw new RpcError(-32003, 'campaign_not_found', { reason: 'campaign_not_found', campaign_id: campaignId });
  }
  return campaign;
}

export function ensureCampaignRunning(campaign: SearchCampaignRecord): void {
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

export function loadCampaignDomainPackMetadata(campaign: SearchCampaignRecord): { packId: string } {
  const domainPack = campaign.domain_pack as Record<string, unknown> | undefined;
  if (!domainPack || typeof domainPack !== 'object') {
    throw schemaValidationError('campaign missing domain_pack metadata', { campaign_id: campaign.campaign_id });
  }
  const packId = domainPack.pack_id;
  const enabledPackIds = domainPack.enabled_pack_ids;
  if (typeof packId !== 'string' || !packId) {
    throw schemaValidationError('campaign domain_pack.pack_id is missing or empty', { campaign_id: campaign.campaign_id });
  }
  if (!Array.isArray(enabledPackIds) || enabledPackIds.some(item => typeof item !== 'string')) {
    throw schemaValidationError('campaign domain_pack.enabled_pack_ids is missing or invalid', { campaign_id: campaign.campaign_id });
  }
  if (!enabledPackIds.includes(packId)) {
    throw schemaValidationError(`campaign domain_pack.pack_id not in enabled_pack_ids: ${packId}`, { campaign_id: campaign.campaign_id });
  }
  return { packId };
}

export function setCampaignRunningIfBudgetAvailable(campaign: SearchCampaignRecord): void {
  campaign.status = exhaustedDimensions(campaign).length > 0 ? 'exhausted' : 'running';
}
