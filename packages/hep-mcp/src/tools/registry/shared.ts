import { zodToMcpInputSchema } from '../mcpSchema.js';
import { toolAnnotationsFor } from '@nullius/shared';
import { HEP_TOOL_HINTS } from '../../tool-hints.js';
import { HEP_TOOL_RISK_LEVELS } from '../../tool-risk.js';
import { z } from 'zod';
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

const PROJECT_ROOT_DESCRIPTION =
  'Optional absolute path to an initialized nullius project root outside any nullius checkout; it is admitted in canonical (symlink-resolved) form. When set, the hep-mcp data for this call (caches, downloads, PDG data) lives under <project_root>/artifacts/hep-mcp, which must be reached through real directories (a symlinked artifacts/, artifacts/hep-mcp/ or pdg/ is refused); otherwise HEP_DATA_DIR or the scratch default is used. Tools that write output files put them in their output_dir instead, which requires project_root and may not lie under the reserved areas .nullius/, team/runs/ or artifacts/hep-mcp/.';

function withProjectRootContract(spec: ToolSpec): ToolSpec {
  if (!(spec.zodSchema instanceof z.ZodObject)) return spec;
  // A tool that declares its own project_root keeps that contract and
  // description.
  if ('project_root' in spec.zodSchema.shape) return spec;
  return {
    ...spec,
    zodSchema: spec.zodSchema.extend({
      project_root: z.string().optional().describe(PROJECT_ROOT_DESCRIPTION),
    }),
  };
}

export const TOOL_SPECS: ToolSpec[] = [
  ...PROJECT_CORE_TOOL_SPECS,
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
      title: spec.title,
      description,
      inputSchema: zodToMcpInputSchema(spec.zodSchema),
      annotations: toolAnnotationsFor(spec.name, HEP_TOOL_RISK_LEVELS, HEP_TOOL_HINTS),
    };
  });
}
