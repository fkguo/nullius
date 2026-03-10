import {
  OPENALEX_DISCOVERY_DESCRIPTOR,
  TOOL_SPECS as OPENALEX_MCP_TOOL_SPECS,
} from '@autoresearch/openalex-mcp/tooling';
import { getHepToolRiskLevel } from '../../tool-risk.js';
import type { ToolSpec } from './types.js';

const RAW_OPENALEX_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = OPENALEX_MCP_TOOL_SPECS.map(spec => ({
  name: spec.name,
  tier: 'consolidated',
  maturity: 'experimental',
  exposure: spec.exposure,
  description: spec.description,
  zodSchema: spec.zodSchema,
  handler: spec.handler,
}));

export const OPENALEX_TOOL_SPECS: ToolSpec[] = RAW_OPENALEX_TOOL_SPECS.map(spec => ({
  ...spec,
  riskLevel: getHepToolRiskLevel(spec.name),
}));

export { OPENALEX_DISCOVERY_DESCRIPTOR };
