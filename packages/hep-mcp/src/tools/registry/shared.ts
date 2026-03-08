import {
  DiscoveryProviderDescriptorSchema,
  HEP_RENDER_LATEX,
  HEP_RUN_BUILD_PDF_EVIDENCE,
  type DiscoveryProviderDescriptor,
} from '@autoresearch/shared';
import { zodToMcpInputSchema } from '../mcpSchema.js';
import {
  type ToolExposure,
  type ToolExposureMode,
  type ToolHandlerContext,
  type ToolMaturity,
  type ToolSpec,
  type ToolTier,
  isAdvancedToolSpec,
  isToolExposed,
} from './types.js';
import { INSPIRE_TOOL_SPECS } from './inspire.js';
import { ZOTERO_TOOL_SPECS } from './zotero.js';
import { PDG_TOOL_SPECS } from './pdg.js';
import { ARXIV_DISCOVERY_DESCRIPTOR } from '@autoresearch/arxiv-mcp/tooling';
import { OPENALEX_DISCOVERY_DESCRIPTOR, OPENALEX_TOOL_SPECS } from './openalex.js';
import {
  PROJECT_CORE_TOOL_SPECS,
  PROJECT_CITATION_TOOL_SPECS,
  PROJECT_EXTENSION_TOOL_SPECS,
} from './project.js';

export type {
  ToolExposure,
  ToolExposureMode,
  ToolHandlerContext,
  ToolMaturity,
  ToolSpec,
  ToolTier,
};

export { isAdvancedToolSpec, isToolExposed };


export const INSPIRE_DISCOVERY_DESCRIPTOR: DiscoveryProviderDescriptor = DiscoveryProviderDescriptorSchema.parse({
  provider: 'inspire',
  display_name: 'INSPIRE-HEP',
  capabilities: {
    supports_keyword_search: true,
    supports_semantic_search: false,
    supports_citation_graph: true,
    supports_fulltext: true,
    supports_source_download: true,
    supports_open_access_content: true,
  },
  supported_intents: ['known_item', 'keyword_search', 'citation_expansion', 'fulltext_search'],
  notes: 'Shared discovery descriptor for NEW-DISC-01. Canonical identity, dedup, query-plan, and search-log artifacts are closed out in the shared broker substrate.',
});

export const DISCOVERY_PROVIDER_DESCRIPTORS: DiscoveryProviderDescriptor[] = [
  INSPIRE_DISCOVERY_DESCRIPTOR,
  OPENALEX_DISCOVERY_DESCRIPTOR,
  ARXIV_DISCOVERY_DESCRIPTOR,
];

const projectCoreRenderLatexIndex = PROJECT_CORE_TOOL_SPECS.findIndex(spec => spec.name === HEP_RENDER_LATEX);
const projectCoreBuildPdfIndex = PROJECT_CORE_TOOL_SPECS.findIndex(spec => spec.name === HEP_RUN_BUILD_PDF_EVIDENCE);

if (projectCoreRenderLatexIndex < 0 || projectCoreBuildPdfIndex <= projectCoreRenderLatexIndex) {
  throw new Error('Unexpected project core ordering in registry split');
}

const PROJECT_CORE_PREFIX_TOOL_SPECS = PROJECT_CORE_TOOL_SPECS.slice(0, projectCoreRenderLatexIndex);
const PROJECT_CORE_RENDER_EXPORT_TOOL_SPECS = PROJECT_CORE_TOOL_SPECS.slice(
  projectCoreRenderLatexIndex,
  projectCoreBuildPdfIndex,
);
const PROJECT_CORE_POST_ZOTERO_TOOL_SPECS = PROJECT_CORE_TOOL_SPECS.slice(projectCoreBuildPdfIndex);

export const TOOL_SPECS: ToolSpec[] = [
  ...PROJECT_CORE_PREFIX_TOOL_SPECS,
  ...PROJECT_CITATION_TOOL_SPECS,
  ...PROJECT_CORE_RENDER_EXPORT_TOOL_SPECS,
  ...ZOTERO_TOOL_SPECS,
  ...PROJECT_CORE_POST_ZOTERO_TOOL_SPECS,
  ...INSPIRE_TOOL_SPECS,
  ...PDG_TOOL_SPECS,
  ...OPENALEX_TOOL_SPECS,
  ...PROJECT_EXTENSION_TOOL_SPECS,
];

const TOOL_SPECS_BY_NAME = new Map<string, ToolSpec>(
  TOOL_SPECS.map(spec => [spec.name, spec])
);

export function getToolSpec(name: string): ToolSpec | undefined {
  return TOOL_SPECS_BY_NAME.get(name);
}

export function getToolSpecs(mode: ToolExposureMode): ToolSpec[] {
  return TOOL_SPECS.filter(spec => isToolExposed(spec, mode));
}

export function getTools(mode: ToolExposureMode = 'standard') {
  return getToolSpecs(mode).map(spec => {
    const baseDescription = spec.description.replace(/^(?:\[(?:Deprecated|Experimental|Advanced)\]\s*)+/, '');
    const prefixes: string[] = [];
    if (spec.maturity === 'deprecated') {
      prefixes.push('[Deprecated]');
    } else if (spec.maturity === 'experimental') {
      prefixes.push('[Experimental]');
    }
    if (isAdvancedToolSpec(spec)) {
      prefixes.push('[Advanced]');
    }

    const prefixText = prefixes.join(' ');
    const description = prefixText ? `${prefixText} ${baseDescription}` : baseDescription;

    return {
      name: spec.name,
      description,
      inputSchema: zodToMcpInputSchema(spec.zodSchema),
    };
  });
}
