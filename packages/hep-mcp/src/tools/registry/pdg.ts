import { TOOL_SPECS as PDG_MCP_TOOL_SPECS } from '@autoresearch/pdg-mcp/tooling';
import { TOOL_RISK_LEVELS, type ToolRiskLevel } from '@autoresearch/shared';
import type { ToolSpec } from './types.js';

const RAW_PDG_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = PDG_MCP_TOOL_SPECS.map(spec => ({
  name: spec.name,
  tier: 'consolidated',
  exposure: spec.exposure,
  description: (() => {
    const d = String(spec.description ?? '').trim();
    if (!d) return d;
    const needsLocal = !/\blocal-only\b/i.test(d);
    const needsDb = !/PDG_DB_PATH/.test(d);
    if (!needsLocal && !needsDb) return d;
    const suffix = [needsLocal ? 'local-only' : null, needsDb ? 'requires `PDG_DB_PATH`' : null]
      .filter(Boolean)
      .join('; ');
    const base = d.replace(/\.\s*$/, '');
    return `${base} (${suffix}).`;
  })(),
  zodSchema: spec.zodSchema,
  handler: spec.handler,
}));

export const PDG_TOOL_SPECS: ToolSpec[] = RAW_PDG_TOOL_SPECS.map(spec => ({
  ...spec,
  riskLevel: (TOOL_RISK_LEVELS[spec.name] ?? 'read') as ToolRiskLevel,
}));
