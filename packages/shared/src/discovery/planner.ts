import { type DiscoveryCapabilityName } from './capabilities.js';
import { supportsCapabilities } from './capabilities.js';
import { normalizeDiscoveryQuery } from './normalization.js';
import { DiscoveryQueryPlanSchema, type DiscoveryPlan, type DiscoveryPlanStep, type DiscoveryProviderDecision } from './query-plan.js';
import { DiscoveryPlannerRequestSchema, type DiscoveryPlannerRequest } from './query-intent.js';
import { supportsIntent, type DiscoveryProviderDescriptor } from './provider-descriptor.js';

function buildReasonCodes(
  request: DiscoveryPlannerRequest,
  descriptor: DiscoveryProviderDescriptor,
): string[] {
  const reasonCodes: string[] = [];
  if (!supportsIntent(descriptor, request.intent)) {
    reasonCodes.push(`unsupported_intent:${request.intent}`);
  }
  const missing = request.required_capabilities.filter(
    capability => descriptor.capabilities[capability] !== true,
  );
  reasonCodes.push(...missing.map(capability => `missing_capability:${capability}`));
  if (reasonCodes.length === 0) {
    if (request.preferred_providers.includes(descriptor.provider)) {
      reasonCodes.push('preferred_provider');
    }
    if (request.required_capabilities.length > 0) {
      reasonCodes.push(...request.required_capabilities.map(capability => `matched_capability:${capability}`));
    }
    if (reasonCodes.length === 0) {
      reasonCodes.push('intent_match');
    }
  }
  return reasonCodes;
}

function buildStepReason(reasonCodes: string[], preferred: boolean, required: DiscoveryCapabilityName[]): string {
  const parts = preferred ? ['preferred_provider'] : [];
  if (required.length > 0) parts.push(`capabilities:${required.join(',')}`);
  if (parts.length === 0) parts.push(reasonCodes[0] ?? 'intent_match');
  return parts.join('|');
}

export function planDiscoveryProviders(
  request: DiscoveryPlannerRequest,
  descriptors: DiscoveryProviderDescriptor[],
): DiscoveryPlan {
  const parsed = DiscoveryPlannerRequestSchema.parse(request);
  const preferred = new Set(parsed.preferred_providers);
  const decisions = descriptors.map((descriptor, index): DiscoveryProviderDecision => {
    const reason_codes = buildReasonCodes(parsed, descriptor);
    const selected = supportsIntent(descriptor, parsed.intent)
      && supportsCapabilities(descriptor.capabilities, parsed.required_capabilities);
    const preferredRank = preferred.has(descriptor.provider) ? 0 : 1;
    return {
      provider: descriptor.provider,
      display_name: descriptor.display_name,
      selected,
      order: selected ? preferredRank * 100 + index + 1 : undefined,
      reason_codes,
    };
  });

  const selectedDecisions = decisions
    .filter(decision => decision.selected)
    .sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER));

  const plan: DiscoveryPlan = {
    version: 1,
    query: parsed.query,
    normalized_query: normalizeDiscoveryQuery(parsed.query),
    intent: parsed.intent,
    preferred_providers: parsed.preferred_providers,
    required_capabilities: parsed.required_capabilities,
    selected_providers: selectedDecisions.map(decision => decision.provider),
    steps: selectedDecisions.map((decision): DiscoveryPlanStep => ({
      provider: decision.provider,
      reason: buildStepReason(decision.reason_codes, preferred.has(decision.provider), parsed.required_capabilities),
    })),
    provider_decisions: decisions,
  };
  return DiscoveryQueryPlanSchema.parse(plan);
}
