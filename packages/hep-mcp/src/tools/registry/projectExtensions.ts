import { TOOL_SPECS as ARXIV_TOOL_SPECS } from '@autoresearch/arxiv-mcp/tooling';
import { TOOL_SPECS as HEPDATA_MCP_TOOL_SPECS } from '@autoresearch/hepdata-mcp/tooling';
import {
  HEP_RUN_INGEST_SKILL_ARTIFACTS,
} from '../../tool-names.js';
import { ingestSkillArtifacts } from '../ingest-skill-artifacts.js';
import type { ToolSpec } from './types.js';
import {
  HepRunIngestSkillArtifactsToolSchema,
} from './projectSchemas.js';

export const RAW_PROJECT_EXTENSION_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = [
  {
    name: HEP_RUN_INGEST_SKILL_ARTIFACTS,
    tier: 'advanced',
    exposure: 'full',
    description:
      'Ingest skill artifacts from a computation step into the computation evidence catalog (JSONL). Requires skill_artifacts_dir within run_dir (C-02 containment).',
    zodSchema: HepRunIngestSkillArtifactsToolSchema,
    handler: async params => ingestSkillArtifacts(params),
  },
  ...HEPDATA_MCP_TOOL_SPECS.map(
    (spec): Omit<ToolSpec, 'riskLevel'> => ({
      name: spec.name,
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
      tier: 'consolidated',
      exposure: spec.exposure,
      description: String(spec.description ?? '').trim(),
      zodSchema: spec.zodSchema,
      handler: spec.handler as ToolSpec['handler'],
    })
  ),
];
