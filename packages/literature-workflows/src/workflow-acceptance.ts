import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkflowAcceptanceCheckSpec } from '@nullius/shared';
import { getRecipeDir, loadWorkflowRecipe } from './recipeLoader.js';
import {
  LiteratureSaturationContractSchema,
  ReadingHandoffContractSchema,
  SearchDepthContractSchema,
} from './types.js';

const CONTRACTS = {
  search_depth_contract: SearchDepthContractSchema,
  literature_saturation_contract: LiteratureSaturationContractSchema,
  reading_handoff_contract: ReadingHandoffContractSchema,
} as const;
const GATES = 'skills/research-team/scripts/gates/';
const LIB = 'skills/research-team/scripts/lib/';
const CHECKER = `${GATES}check_workflow_literature.py`;
const SOURCES = [CHECKER, `${GATES}check_literature_trace.py`, `${GATES}check_knowledge_layers.py`,
  ...['workflow_literature_reads.py', 'literature_artifact_refs.py', 'literature_identity.py',
    'literature_identity_keys.py', 'literature_identity_provenance.py', 'literature_coverage.py',
    'team_config.py', 'md_math_hygiene.py', 'md_utils.py'].map(name => `${LIB}${name}`),
  'skills/citation-triangulation/scripts/bin/triangulate_citation.py'];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function protectedHints(hints: unknown): Record<string, unknown> {
  if (hints == null) return {};
  if (!object(hints)) throw new Error('Literature consumer_hints must be an object');
  return Object.fromEntries(Object.entries(CONTRACTS).flatMap(([key, schema]) => {
    if (!(key in hints)) return [];
    const parsed = schema.parse(hints[key]);
    if (key === 'literature_saturation_contract') {
      const expected = (parsed as { providers_expected: string[] }).providers_expected;
      if (new Set(expected).size !== 4) throw new Error('providers_expected must cover every required provider exactly once');
    }
    return [[key, parsed]];
  }));
}

/** Literature policy stays here; the control plane runs the declared checker only
 * after all selected workflow steps have completed. */
export function resolveWorkflowAcceptanceChecks(
  workflowId: string, plan: Record<string, unknown> | null,
): WorkflowAcceptanceCheckSpec[] {
  const known = /^[a-z0-9_]+$/.test(workflowId)
    && fs.existsSync(path.join(getRecipeDir(), `${workflowId}.json`));
  const recipe = known ? loadWorkflowRecipe(workflowId) : null;
  const protectedRecipe = recipe?.steps.some(s => Object.keys(protectedHints(s.consumer_hints)).length > 0);
  if (!plan) {
    if (protectedRecipe) throw new Error('Literature acceptance requires the persisted selected plan');
    return [];
  }
  const rawSteps = plan.steps ?? plan.resolved_steps;
  if (!Array.isArray(rawSteps)) {
    if (protectedRecipe) throw new Error('Literature plan must contain selected steps');
    return [];
  }
  const steps = rawSteps.map(raw => {
    if (!object(raw)) throw new Error('Malformed workflow step');
    const id = raw.step_id ?? raw.id;
    const execution = 'execution' in raw ? raw.execution : raw;
    if (typeof id !== 'string' || !id || !object(execution)) {
      if (protectedRecipe) throw new Error('Malformed literature execution step');
      return { id: String(id), contracts: {} };
    }
    return { id, contracts: protectedHints(execution.consumer_hints) };
  });
  if (protectedRecipe && recipe) {
    const actual = steps.map(s => s.id).sort();
    if (new Set(actual).size !== actual.length) throw new Error('Duplicate literature step');
    const phases = new Set(recipe.steps.flatMap(s => s.consumer_hints?.phases ?? []));
    const selections = [recipe.steps, ...[...phases].map(phase => recipe.steps.filter(s =>
      !s.consumer_hints?.phases || s.consumer_hints.phases.includes(phase)))];
    if (!selections.some(selection => stable(selection.map(s => s.id).sort()) === stable(actual))) {
      throw new Error('Selected literature steps omit or introduce checked-in recipe steps');
    }
    for (const selected of steps) {
      const expected = recipe.steps.find(s => s.id === selected.id)!;
      if (stable(selected.contracts) !== stable(protectedHints(expected.consumer_hints))) {
        throw new Error(`Literature acceptance contracts changed or omitted for ${selected.id}`);
      }
    }
  }
  const requirements = steps.filter(s => Object.keys(s.contracts).length > 0);
  if (!requirements.length) return [];
  const saturations = requirements.flatMap(s => s.contracts.literature_saturation_contract
    ? [s.contracts.literature_saturation_contract as Record<string, unknown>] : []);
  if (!saturations.length) throw new Error('Literature reading/depth requirements need a saturation contract');
  if (saturations.some(s => stable(s) !== stable(saturations[0]))) {
    throw new Error('Conflicting literature saturation contracts');
  }
  return [{
    id: 'literature_evidence_coverage', checker_path: CHECKER,
    checker_sources: [...SOURCES, ...(recipe ? [`packages/literature-workflows/recipes/${workflowId}.json`] : [])],
    request: {
      saturation_path: saturations[0].artifact,
      trace_path: 'knowledge_base/methodology_traces/literature_queries.md',
      providers_expected: saturations[0].providers_expected,
      selected_step_requirements: requirements,
      workflow_binding_required: true,
      source_first_reading_required: true,
    },
  }];
}
