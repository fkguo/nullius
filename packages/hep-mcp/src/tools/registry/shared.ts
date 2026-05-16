import { zodToMcpInputSchema } from '../mcpSchema.js';
import { z } from 'zod';
import { HEP_RENDER_LATEX } from '../../tool-names.js';
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
import { OPENALEX_TOOL_SPECS } from './openalex.js';
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

const projectCoreRenderLatexIndex = PROJECT_CORE_TOOL_SPECS.findIndex(spec => spec.name === HEP_RENDER_LATEX);

if (projectCoreRenderLatexIndex < 0) {
  throw new Error('Unexpected project core ordering in registry split');
}

const PROJECT_CORE_PREFIX_TOOL_SPECS = PROJECT_CORE_TOOL_SPECS.slice(0, projectCoreRenderLatexIndex);
const PROJECT_CORE_RENDER_EXPORT_TOOL_SPECS = PROJECT_CORE_TOOL_SPECS.slice(projectCoreRenderLatexIndex);

const PROJECT_ROOT_DESCRIPTION =
  'Optional absolute path to an initialized autoresearch project root. When set, HEP/PDG artifacts for this call are stored under <project_root>/artifacts/hep-mcp; otherwise HEP_DATA_DIR or the scratch default is used.';

function withProjectRootContract(spec: ToolSpec): ToolSpec {
  if (!(spec.zodSchema instanceof z.ZodObject)) return spec;
  return {
    ...spec,
    zodSchema: spec.zodSchema.extend({
      project_root: z.string().optional().describe(PROJECT_ROOT_DESCRIPTION),
    }),
  };
}

export const TOOL_SPECS: ToolSpec[] = [
  ...PROJECT_CORE_PREFIX_TOOL_SPECS,
  ...PROJECT_CITATION_TOOL_SPECS,
  ...PROJECT_CORE_RENDER_EXPORT_TOOL_SPECS,
  ...ZOTERO_TOOL_SPECS,
  ...INSPIRE_TOOL_SPECS,
  ...PDG_TOOL_SPECS,
  ...OPENALEX_TOOL_SPECS,
  ...PROJECT_EXTENSION_TOOL_SPECS,
].map(withProjectRootContract);

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
