import { ARXIV_DISCOVERY_DESCRIPTOR } from '@autoresearch/arxiv-mcp/tooling';
import { INSPIRE_DISCOVERY_DESCRIPTOR } from '@autoresearch/hep-mcp/provider-descriptors';
import { OPENALEX_DISCOVERY_DESCRIPTOR } from '@autoresearch/openalex-mcp/tooling';
import type { DiscoveryProviderDescriptor } from '@autoresearch/shared';
import type { WorkflowActionId, WorkflowCapabilityId, WorkflowProviderId } from './types.js';

type ProviderProfile = {
  provider: WorkflowProviderId;
  display_name: string;
  capabilities: WorkflowCapabilityId[];
  toolByAction: Partial<Record<WorkflowActionId, string>>;
  notes: string;
};

function discoveryCapabilities(descriptor: DiscoveryProviderDescriptor): WorkflowCapabilityId[] {
  return Object.entries(descriptor.capabilities)
    .filter(([, enabled]) => enabled === true)
    .map(([capability]) => capability as WorkflowCapabilityId);
}

const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    provider: 'inspire',
    display_name: INSPIRE_DISCOVERY_DESCRIPTOR.display_name,
    capabilities: [
      ...discoveryCapabilities(INSPIRE_DISCOVERY_DESCRIPTOR),
      'analysis.topic_evolution',
      'analysis.citation_network',
      'analysis.paper_set_connections',
      'analysis.provenance_trace',
      'analysis.paper_set_critical_review',
    ],
    toolByAction: {
      'discover.seed_search': 'inspire_search',
      'analyze.topic_evolution': 'inspire_topic_analysis',
      'analyze.citation_network': 'inspire_network_analysis',
      'analyze.paper_connections': 'inspire_find_connections',
      'analyze.provenance_trace': 'inspire_trace_original_source',
      'analyze.paper_set_critical_review': 'inspire_critical_analysis',
    },
    notes: 'Primary executor for checked-in topic, network, provenance, connections, and critical-review operators.',
  },
  {
    provider: 'openalex',
    display_name: OPENALEX_DISCOVERY_DESCRIPTOR.display_name,
    capabilities: discoveryCapabilities(OPENALEX_DISCOVERY_DESCRIPTOR),
    toolByAction: {
      'discover.seed_search': 'openalex_search',
    },
    notes: 'Discovery expansion and metadata enrichment only; workflow-analysis operators remain incomplete.',
  },
  {
    provider: 'arxiv',
    display_name: ARXIV_DISCOVERY_DESCRIPTOR.display_name,
    capabilities: discoveryCapabilities(ARXIV_DISCOVERY_DESCRIPTOR),
    toolByAction: {
      'discover.seed_search': 'arxiv_search',
    },
    notes: 'Known-item lookup, keyword intake, and source retrieval only.',
  },
  {
    provider: 'zotero',
    display_name: 'Zotero',
    capabilities: [],
    toolByAction: {},
    notes: 'Local curated corpus input only.',
  },
  {
    provider: 'crossref',
    display_name: 'Crossref',
    capabilities: [],
    toolByAction: {},
    notes: 'Metadata enrichment only.',
  },
  {
    provider: 'datacite',
    display_name: 'DataCite',
    capabilities: [],
    toolByAction: {},
    notes: 'Dataset/software DOI enrichment only.',
  },
  {
    provider: 'github',
    display_name: 'GitHub',
    capabilities: [],
    toolByAction: {},
    notes: 'Companion-code enrichment only.',
  },
  {
    provider: 'doi',
    display_name: 'DOI Resolver',
    capabilities: [],
    toolByAction: {},
    notes: 'Canonical DOI redirect utility only.',
  },
];

export function getWorkflowProviderProfiles(): ProviderProfile[] {
  return PROVIDER_PROFILES.map(profile => ({
    ...profile,
    capabilities: [...profile.capabilities],
    toolByAction: { ...profile.toolByAction },
  }));
}
