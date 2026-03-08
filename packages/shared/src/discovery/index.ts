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
  DiscoveryCandidateChannelSchema,
  type DiscoveryCandidateChannel,
} from './candidate-channel.js';

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
  DiscoveryCandidateBatchSchema,
  DiscoveryCandidateGenerationArtifactSchema,
  type DiscoveryCandidateBatch,
  type DiscoveryCandidateGenerationArtifact,
} from './candidate-generation-artifact.js';

export {
  DiscoveryProviderResultCountsSchema,
  type DiscoveryProviderResultCounts,
} from './provider-result-counts.js';

export {
  DiscoveryRiskLevelSchema,
  DiscoveryQppStatusSchema,
  DiscoveryTriggerDecisionSchema,
  DiscoveryReformulationStatusSchema,
  DiscoveryQueryProbeSchema,
  DiscoveryQppAssessmentSchema,
  DiscoveryReformulationTelemetrySchema,
  DiscoveryQueryReformulationArtifactSchema,
  type DiscoveryRiskLevel,
  type DiscoveryQppStatus,
  type DiscoveryTriggerDecision,
  type DiscoveryReformulationStatus,
  type DiscoveryQueryProbe,
  type DiscoveryQppAssessment,
  type DiscoveryReformulationTelemetry,
  type DiscoveryQueryReformulationArtifact,
} from './query-reformulation-artifact.js';

export {
  DiscoveryRerankStatusSchema,
  DiscoveryRerankMethodSchema,
  DiscoveryRerankedPaperSchema,
  DiscoveryRerankArtifactSchema,
  type DiscoveryRerankStatus,
  type DiscoveryRerankMethod,
  type DiscoveryRerankedPaper,
  type DiscoveryRerankArtifact,
} from './rerank-artifact.js';

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
