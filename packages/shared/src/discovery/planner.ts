import {
  supportsCapabilities,
  type DiscoveryCapabilityName,
  type DiscoveryProviderId,
} from './capabilities.js';
import { DiscoveryPlannerRequestSchema, type DiscoveryPlannerRequest } from './query-intent.js';
import { supportsIntent, type DiscoveryProviderDescriptor } from './provider-descriptor.js';

export type DiscoveryPlanStep = {
  provider: DiscoveryProviderId;
  reason: string;
};

export type DiscoveryPlan = {
  intent: DiscoveryPlannerRequest['intent'];
  query: string;
  selected_providers: DiscoveryProviderId[];
  steps: DiscoveryPlanStep[];
};

function buildReason(required: DiscoveryCapabilityName[], preferred: boolean): string {
  const parts: string[] = [];
  if (preferred) parts.push('preferred_provider');
  if (required.length > 0) parts.push(`capabilities:${required.join(',')}`);
  if (parts.length === 0) parts.push('intent_match');
  return parts.join('|');
}

export function planDiscoveryProviders(
  request: DiscoveryPlannerRequest,
  descriptors: DiscoveryProviderDescriptor[],
): DiscoveryPlan {
  const parsed = DiscoveryPlannerRequestSchema.parse(request);
  const preferred = new Set(parsed.preferred_providers);

  const selected = descriptors
    .filter(descriptor => supportsIntent(descriptor, parsed.intent))
    .filter(descriptor => supportsCapabilities(descriptor.capabilities, parsed.required_capabilities))
    .sort((left, right) => {
      const leftPreferred = preferred.has(left.provider) ? 0 : 1;
      const rightPreferred = preferred.has(right.provider) ? 0 : 1;
      if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
      return left.display_name.localeCompare(right.display_name);
    });

  return {
    intent: parsed.intent,
    query: parsed.query,
    selected_providers: selected.map(descriptor => descriptor.provider),
    steps: selected.map(descriptor => ({
      provider: descriptor.provider,
      reason: buildReason(parsed.required_capabilities, preferred.has(descriptor.provider)),
    })),
  };
}
