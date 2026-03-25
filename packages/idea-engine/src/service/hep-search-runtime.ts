import type {
  SearchDomainPackRuntime,
  SearchOperatorDescriptor,
  SearchOperator,
  SearchOperatorContext,
  SearchOperatorOutput,
} from './search-operator.js';

interface SearchOperatorSpec {
  backendId: string;
  claimText: string;
  hypothesis: string;
  operatorFamily: string;
  operatorId: string;
  rationalePrefix: string;
  rationaleTitlePrefix: string;
  thesisStatement: string;
  traceStyle: string;
  traceTemplateVersion: string;
}

const HEP_OPERATOR_SPECS: readonly SearchOperatorSpec[] = [
  { operatorId: 'hep.anomaly_abduction.v1', operatorFamily: 'AnomalyAbduction', backendId: 'hep.operator.backend.anomaly', rationaleTitlePrefix: 'Anomaly abduction from', rationalePrefix: 'Treat the parent node as an observed tension/anomaly and abduct a minimal, auditable explanation', thesisStatement: 'If an anomaly is real, propose the smallest structural change that explains it and yields a crisp kill criterion.', hypothesis: 'Anomaly-abduction tick-{tick} implies a correlated signature that remains testable with the current observable set.', claimText: 'A minimal explanatory mechanism should predict at least one correlated observable that was not used to motivate the anomaly.', traceStyle: 'anomaly_abduction', traceTemplateVersion: 'anomaly-abduction-v1' },
  { operatorId: 'hep.symmetry_operator.v1', operatorFamily: 'SymmetryOperator', backendId: 'hep.operator.backend.symmetry', rationaleTitlePrefix: 'Symmetry-based reformulation of', rationalePrefix: 'Generate a symmetry-motivated variant that compresses the hypothesis into a cleaner invariance statement', thesisStatement: 'Symmetry constraints often dictate the allowed operators/couplings; leverage this to prune the hypothesis space early.', hypothesis: 'Symmetry operator tick-{tick} yields a selection rule that should hold if the hypothesis is internally consistent.', claimText: 'A candidate symmetry (exact or approximate) implies at least one forbidden/allowed transition pattern that can be used as a hard kill criterion.', traceStyle: 'symmetry', traceTemplateVersion: 'symmetry-v1' },
  { operatorId: 'hep.limit_explorer.v1', operatorFamily: 'LimitExplorer', backendId: 'hep.operator.backend.limit', rationaleTitlePrefix: 'Limit exploration around', rationalePrefix: 'Probe a controlled limit (decoupling, large-N, soft/collinear, etc.) to extract a robust prediction', thesisStatement: 'Well-chosen limits expose invariants and consistency conditions that should survive model details.', hypothesis: 'Limit explorer tick-{tick} predicts a scaling relation that can be checked with a lightweight consistency computation.', claimText: 'In an appropriate limit, the hypothesis should reduce to a known baseline or produce a distinctive scaling law; otherwise it is likely inconsistent.', traceStyle: 'limit_explorer', traceTemplateVersion: 'limit-explorer-v1' },
];

function parentTitle(node: Record<string, unknown>): string {
  const title = (node.rationale_draft as Record<string, unknown> | undefined)?.title;
  return typeof title === 'string' && title ? title : 'Untitled seed';
}

function parentRationale(node: Record<string, unknown>): string {
  const rationale = (node.rationale_draft as Record<string, unknown> | undefined)?.rationale;
  return typeof rationale === 'string' && rationale ? rationale : 'seed rationale';
}

function failureAvoidanceRationale(context: SearchOperatorContext): string {
  if (!context.failureAvoidance) return '';
  if (context.failureAvoidance.hitCount === 0) {
    return '. Failure-library check found no matching prior dead ends for this configured query.';
  }
  const summaries = context.failureAvoidance.hits
    .slice(0, 2)
    .map(hit => `${hit.failureMode}: ${hit.approachSummary}`)
    .join(' | ');
  return `. Avoid ${context.failureAvoidance.hitCount} prior failure hit(s): ${summaries}`;
}

function renderOperatorOutput(
  spec: SearchOperatorSpec,
  context: SearchOperatorContext,
  parentNode: Record<string, unknown>,
): SearchOperatorOutput {
  const failureAvoidance = context.failureAvoidance;
  return {
    operatorId: spec.operatorId,
    operatorFamily: spec.operatorFamily,
    backendId: spec.backendId,
    rationaleTitle: `${spec.rationaleTitlePrefix} ${parentTitle(parentNode)}`,
    rationale: `${spec.rationalePrefix} in island ${context.islandId}. Parent: ${parentRationale(parentNode)}${failureAvoidanceRationale(context)}`,
    thesisStatement: spec.thesisStatement,
    hypothesis: spec.hypothesis.replace('{tick}', String(context.tick)),
    claimText: spec.claimText,
    traceInputs: {
      parent_node_id: context.parentNodeId,
      step_id: context.stepId,
      tick: context.tick,
      style: spec.traceStyle,
      island_id: context.islandId,
      ...(context.selection ? { selected_action_id: context.selection.actionId } : {}),
      ...(failureAvoidance
        ? {
            failure_library_hits_ref: failureAvoidance.artifactRef,
            failure_avoidance_hit_count: failureAvoidance.hitCount,
            failure_avoidance_failure_modes: failureAvoidance.matchedFailureModes,
            failure_avoidance_tags: failureAvoidance.matchedTags,
          }
        : {}),
    },
    traceParams: {
      deterministic_policy: context.selection?.deterministicPolicy ?? 'island_index_v1',
      template_version: spec.traceTemplateVersion,
      backend_id: spec.backendId,
      ...(context.selection ? { policy_id: context.selection.policyId } : {}),
    },
    evidenceUrisUsed: [`urn:hepar:operator-template:${spec.traceTemplateVersion}`],
  };
}

function buildSearchOperator(spec: SearchOperatorSpec): SearchOperator {
  const descriptor: Readonly<SearchOperatorDescriptor> = Object.freeze({
    backendId: spec.backendId,
    operatorFamily: spec.operatorFamily,
    operatorId: spec.operatorId,
  });
  return {
    descriptor,
    run: (context, parentNode) => renderOperatorOutput(spec, context, parentNode),
  };
}

export function buildHepSearchDomainPackRuntime(options: {
  operatorSelectionPolicy?: string;
}): SearchDomainPackRuntime {
  return {
    operatorSelectionPolicy: options.operatorSelectionPolicy ?? 'round_robin_v1',
    searchOperators: HEP_OPERATOR_SPECS.map(buildSearchOperator),
  };
}
