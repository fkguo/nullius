export {
  DiscoveryProviderIdSchema,
  DiscoveryCapabilityNameSchema,
  DiscoveryProviderCapabilitiesSchema,
  supportsCapabilities,
  type DiscoveryProviderId,
  type DiscoveryCapabilityName,
  type DiscoveryProviderCapabilities,
} from './capabilities.js';

export {
  DiscoveryQueryIntentSchema,
  DiscoveryPlannerRequestSchema,
  type DiscoveryQueryIntent,
  type DiscoveryPlannerRequest,
} from './query-intent.js';

export {
  DiscoveryProviderDescriptorSchema,
  getProviderDescriptor,
  supportsIntent,
  type DiscoveryProviderDescriptor,
} from './provider-descriptor.js';

export {
  CanonicalCandidateSchema,
  type CanonicalCandidate,
} from './canonical-candidate.js';

export {
  CanonicalPaperSchema,
  CanonicalPaperMergeStateSchema,
  CanonicalPaperMergeConfidenceSchema,
  DiscoveryCanonicalPapersArtifactSchema,
  type CanonicalPaper,
  type DiscoveryCanonicalPapersArtifact,
} from './canonical-paper.js';

export {
  DiscoveryDedupArtifactSchema,
  type DiscoveryDedupArtifact,
} from './dedup-artifact.js';

export {
  DiscoveryQueryPlanSchema,
  DiscoveryPlanStepSchema,
  DiscoveryProviderDecisionSchema,
  type DiscoveryPlan,
  type DiscoveryPlanStep,
  type DiscoveryProviderDecision,
} from './query-plan.js';

export {
  DiscoveryArtifactLocatorSchema,
  DiscoverySearchLogEntrySchema,
  appendDiscoverySearchLogEntries,
  type DiscoveryArtifactLocator,
  type DiscoverySearchLogEntry,
} from './search-log.js';

export { planDiscoveryProviders } from './planner.js';
export { canonicalizeDiscoveryCandidates } from './canonicalize.js';

export {
  normalizeDiscoveryName,
  normalizeDiscoveryQuery,
  normalizeDiscoveryTitle,
} from './normalization.js';
