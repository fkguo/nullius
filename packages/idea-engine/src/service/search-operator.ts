import { builtinDomainPackById } from './domain-pack.js';

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

export interface SearchOperatorContext {
  campaignId: string;
  islandId: string;
  parentNodeId: string;
  stepId: string;
  tick: number;
}

export interface SearchOperatorOutput {
  backendId: string;
  claimText: string;
  evidenceUrisUsed: string[];
  hypothesis: string;
  operatorFamily: string;
  operatorId: string;
  rationale: string;
  rationaleTitle: string;
  thesisStatement: string;
  traceInputs: Record<string, unknown>;
  traceParams: Record<string, unknown>;
}

export interface SearchDomainPackRuntime {
  operatorSelectionPolicy: string;
  searchOperators: Array<{ run: (context: SearchOperatorContext, parentNode: Record<string, unknown>) => SearchOperatorOutput }>;
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

function renderOperatorOutput(
  spec: SearchOperatorSpec,
  context: SearchOperatorContext,
  parentNode: Record<string, unknown>,
): SearchOperatorOutput {
  return {
    operatorId: spec.operatorId,
    operatorFamily: spec.operatorFamily,
    backendId: spec.backendId,
    rationaleTitle: `${spec.rationaleTitlePrefix} ${parentTitle(parentNode)}`,
    rationale: `${spec.rationalePrefix} in island ${context.islandId}. Parent: ${parentRationale(parentNode)}`,
    thesisStatement: spec.thesisStatement,
    hypothesis: spec.hypothesis.replace('{tick}', String(context.tick)),
    claimText: spec.claimText,
    traceInputs: { parent_node_id: context.parentNodeId, step_id: context.stepId, tick: context.tick, style: spec.traceStyle, island_id: context.islandId },
    traceParams: { deterministic_policy: 'island_index_v1', template_version: spec.traceTemplateVersion, backend_id: spec.backendId },
    evidenceUrisUsed: [`urn:hepar:operator-template:${spec.traceTemplateVersion}`],
  };
}

export function chooseSearchOperator(options: {
  islandId: string;
  runtime: Record<string, unknown>;
  searchOperators: SearchDomainPackRuntime['searchOperators'];
  selectionPolicy: string;
}): SearchDomainPackRuntime['searchOperators'][number] {
  if (options.selectionPolicy === 'island_index_v1') {
    const parts = options.islandId.split('-', 2);
    if (parts.length === 2 && parts[0] === 'island' && /^\d+$/.test(parts[1] ?? '')) {
      return options.searchOperators[Number.parseInt(parts[1]!, 10) % options.searchOperators.length]!;
    }
  }
  const nextOperatorIndex = Number(options.runtime.next_operator_index ?? 0);
  const chosenIndex = nextOperatorIndex % options.searchOperators.length;
  options.runtime.next_operator_index = (chosenIndex + 1) % options.searchOperators.length;
  return options.searchOperators[chosenIndex]!;
}

export function loadSearchDomainPackRuntime(packId: string): SearchDomainPackRuntime {
  const entry = builtinDomainPackById(packId);
  if (!entry) throw new Error(`unknown built-in pack: ${packId}`);
  if (entry.operator_source !== 'hep_operator_families_m32') {
    throw new Error(`unknown HEP operator_source: ${entry.operator_source ?? '<missing>'}`);
  }
  return {
    operatorSelectionPolicy: entry.operator_selection_policy ?? 'round_robin_v1',
    searchOperators: HEP_OPERATOR_SPECS.map(spec => ({ run: (context, parentNode) => renderOperatorOutput(spec, context, parentNode) })),
  };
}
