import { TOOL_SPECS as ARXIV_TOOL_SPECS } from '@nullius/arxiv-mcp/tooling';
import { TOOL_SPECS as HEPDATA_MCP_TOOL_SPECS } from '@nullius/hepdata-mcp/tooling';
import type { ToolSpec } from './types.js';

export const RAW_PROJECT_EXTENSION_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = [
  ...HEPDATA_MCP_TOOL_SPECS.map(
    (spec): Omit<ToolSpec, 'riskLevel'> => ({
      name: spec.name,
      title: spec.title,
      tier: 'consolidated',
      exposure: spec.exposure,
      description: String(spec.description ?? '').trim(),
      zodSchema: spec.zodSchema,
      handler: spec.handler,
    })
  ),
  ...ARXIV_TOOL_SPECS.map(
    (spec): Omit<ToolSpec, 'riskLevel'> => ({
      name: spec.name,
      title: spec.title,
      tier: 'consolidated',
      exposure: spec.exposure,
      description: String(spec.description ?? '').trim(),
      zodSchema: spec.zodSchema,
      handler: spec.handler as ToolSpec['handler'],
    })
  ),
];
