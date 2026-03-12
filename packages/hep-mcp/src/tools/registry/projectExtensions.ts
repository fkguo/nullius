import { TOOL_SPECS as ARXIV_TOOL_SPECS } from '@autoresearch/arxiv-mcp/tooling';
import { TOOL_SPECS as HEPDATA_MCP_TOOL_SPECS } from '@autoresearch/hepdata-mcp/tooling';
import {
  HEP_RUN_INGEST_SKILL_ARTIFACTS,
  HEP_RUN_EXECUTE_MANIFEST,
  HEP_RUN_CREATE_FROM_IDEA,
} from '../../tool-names.js';
import { ORCH_TOOL_SPECS } from '../orchestrator/tools.js';
import { ingestSkillArtifacts } from '../ingest-skill-artifacts.js';
import { createFromIdea } from '../create-from-idea.js';
import { executeManifest, HepRunExecuteManifestToolSchema } from '../execute-manifest.js';
import type { ToolSpec } from './types.js';
import { HepRunIngestSkillArtifactsToolSchema, HepRunCreateFromIdeaToolSchema } from './projectSchemas.js';

export const RAW_PROJECT_EXTENSION_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = [
  ...ORCH_TOOL_SPECS,
  {
    name: HEP_RUN_INGEST_SKILL_ARTIFACTS,
    tier: 'advanced',
    exposure: 'full',
    description:
      'Ingest skill artifacts from a computation step into the computation evidence catalog (JSONL). Requires skill_artifacts_dir within run_dir (C-02 containment).',
    zodSchema: HepRunIngestSkillArtifactsToolSchema,
    handler: async params => ingestSkillArtifacts(params),
  },
  {
    name: HEP_RUN_EXECUTE_MANIFEST,
    tier: 'advanced',
    exposure: 'full',
    description:
      'Execute a computation_manifest_v1 plan from the current run. dry_run validates only; real execution requires A3 approval and returns a packet when approval is pending.',
    zodSchema: HepRunExecuteManifestToolSchema,
    handler: async params => executeManifest(params),
  },
  {
    name: HEP_RUN_CREATE_FROM_IDEA,
    tier: 'core',
    exposure: 'standard',
    description:
      'Create a project + run from an IdeaHandoffC2 artifact. Stages outline_seed_v1.json with thesis/claims/hypotheses. Pure local staging, no network calls.',
    zodSchema: HepRunCreateFromIdeaToolSchema,
    handler: async params => createFromIdea(params),
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
