import type { WorkflowActionId, WorkflowCapabilityId, WorkflowProviderId } from './types.js';
import {
  ResolveWorkflowRequestSchema,
  ResolvedWorkflowPlanSchema,
  type ResolveWorkflowRequest,
  type ResolvedWorkflowPlan,
  type WorkflowRecipeStep,
} from './types.js';
import { getWorkflowProviderProfiles } from './providerProfiles.js';
import { loadWorkflowRecipe } from './recipeLoader.js';

const ACTION_CAPABILITIES: Record<WorkflowActionId, WorkflowCapabilityId[]> = {
  'discover.seed_search': ['supports_keyword_search'],
  'analyze.topic_evolution': ['analysis.topic_evolution'],
  'analyze.citation_network': ['analysis.citation_network'],
  'analyze.paper_connections': ['analysis.paper_set_connections'],
  'analyze.provenance_trace': ['analysis.provenance_trace'],
  'analyze.paper_set_critical_review': ['analysis.paper_set_critical_review'],
  'materialize.evidence_build': [],
};

function resolveTemplate(value: unknown, inputs: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^<([A-Za-z0-9_.-]+)>$/);
    if (exact) {
      const resolved = inputs[exact[1]];
      if (resolved === undefined) {
        throw new Error(`Missing workflow input: ${exact[1]}`);
      }
      return resolved;
    }
    return value.replace(/<([A-Za-z0-9_.-]+)>/g, (_, key: string) => {
      const resolved = inputs[key];
      if (resolved === undefined) {
        throw new Error(`Missing workflow input: ${key}`);
      }
      return String(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map(item => resolveTemplate(item, inputs));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolveTemplate(child, inputs)]),
    );
  }
  return value;
}

function stepMatchesPhase(step: WorkflowRecipeStep, phase?: string): boolean {
  if (!phase) return true;
  const phases = step.consumer_hints?.phases;
  return !phases || phases.includes(phase);
}

function chooseProvider(
  step: WorkflowRecipeStep,
  request: ResolveWorkflowRequest,
  availableTools?: Set<string>,
): { provider?: WorkflowProviderId; tool: string; requiredCapabilities: WorkflowCapabilityId[] } {
  if (!step.action) {
    if (!step.tool) throw new Error(`Workflow step ${step.id} is missing action/tool authority`);
    return { tool: step.tool, requiredCapabilities: [...step.required_capabilities] };
  }
  if (step.action === 'materialize.evidence_build') {
    return { tool: step.tool ?? 'hep_project_build_evidence', requiredCapabilities: [] };
  }

  const profiles = getWorkflowProviderProfiles();
  const requiredCapabilities = [
    ...new Set([
      ...ACTION_CAPABILITIES[step.action],
      ...step.required_capabilities,
    ]),
  ];
  const allowlist = request.allowed_providers ? new Set(request.allowed_providers) : undefined;
  const preferred = [
    ...request.preferred_providers,
    ...step.preferred_providers,
  ];

  const candidates = profiles
    .filter(profile => !allowlist || allowlist.has(profile.provider))
    .filter(profile => requiredCapabilities.every(capability => profile.capabilities.includes(capability)))
    .filter(profile => Boolean(profile.toolByAction[step.action!]))
    .sort((left, right) => {
      const leftRank = preferred.indexOf(left.provider);
      const rightRank = preferred.indexOf(right.provider);
      const normalizedLeft = leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank;
      const normalizedRight = rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank;
      return normalizedLeft - normalizedRight;
    });

  const selected = (availableTools
    ? candidates.find(profile => availableTools.has(profile.toolByAction[step.action!]!))
    : undefined) ?? candidates[0];
  if (!selected) {
    throw new Error(
      `No provider satisfies workflow action ${step.action} (required capabilities: ${requiredCapabilities.join(', ') || 'none'})`,
    );
  }
  return {
    provider: selected.provider,
    tool: selected.toolByAction[step.action]!,
    requiredCapabilities,
  };
}

export function resolveWorkflowRecipe(request: ResolveWorkflowRequest): ResolvedWorkflowPlan {
  const parsed = ResolveWorkflowRequestSchema.parse(request);
  const recipe = loadWorkflowRecipe(parsed.recipe_id);
  const availableTools = parsed.available_tools ? new Set(parsed.available_tools) : undefined;
  const resolvedSteps = recipe.steps
    .filter(step => stepMatchesPhase(step, parsed.phase))
    .map(step => {
      const { provider, tool, requiredCapabilities } = chooseProvider(step, parsed, availableTools);
      if (availableTools && !availableTools.has(tool)) {
        throw new Error(`Workflow step ${step.id} resolved to unavailable tool ${tool}`);
      }
      return {
        id: step.id,
        action: step.action,
        tool,
        provider,
        purpose: step.purpose,
        depends_on: [...step.depends_on],
        params: resolveTemplate(step.params, parsed.inputs) as Record<string, unknown>,
        required_capabilities: requiredCapabilities,
        degrade_mode: step.degrade_mode,
        consumer_hints: step.consumer_hints,
      };
    });

  return ResolvedWorkflowPlanSchema.parse({
    recipe_id: recipe.recipe_id,
    name: recipe.name,
    entry_tool: recipe.entry_tool,
    phase: parsed.phase,
    resolved_steps: resolvedSteps,
  });
}
