import { TOOL_SPECS as ARXIV_TOOL_SPECS } from '@autoresearch/arxiv-mcp/tooling';
import { TOOL_SPECS as HEPDATA_MCP_TOOL_SPECS } from '@autoresearch/hepdata-mcp/tooling';
import {
  HEP_RUN_INGEST_SKILL_ARTIFACTS,
  HEP_RUN_EXECUTE_MANIFEST,
  HEP_RUN_CREATE_FROM_IDEA,
  HEP_RUN_PLAN_COMPUTATION,
} from '../../tool-names.js';
import { ORCH_TOOL_SPECS } from '../orchestrator/tools.js';
import { ingestSkillArtifacts } from '../ingest-skill-artifacts.js';
import { createFromIdea } from '../create-from-idea.js';
import { executeManifest, HepRunExecuteManifestToolSchema } from '../execute-manifest.js';
import { planComputation } from '../plan-computation.js';
import type { ToolSpec } from './types.js';
import {
  HepRunIngestSkillArtifactsToolSchema,
  HepRunCreateFromIdeaToolSchema,
  HepRunPlanComputationToolSchema,
} from './projectSchemas.js';

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
    handler: async (params, ctx) => executeManifest(params, ctx),
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
  {
    name: HEP_RUN_PLAN_COMPUTATION,
    tier: 'core',
    exposure: 'standard',
    description:
      'Compile staged idea artifacts into execution_plan_v1.json, materialize computation/manifest.json, then stop at dry_run validation or A3 approval request before any execution.',
    zodSchema: HepRunPlanComputationToolSchema,
    handler: async params => planComputation(params),
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
