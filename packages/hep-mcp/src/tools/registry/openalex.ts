import { TOOL_SPECS as OPENALEX_MCP_TOOL_SPECS } from '@autoresearch/openalex-mcp/tooling';
import { TOOL_RISK_LEVELS, type ToolRiskLevel } from '@autoresearch/shared';
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
  riskLevel: (TOOL_RISK_LEVELS[spec.name] ?? 'read') as ToolRiskLevel,
}));
