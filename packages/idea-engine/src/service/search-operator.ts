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

export interface SearchOperator {
  run: (context: SearchOperatorContext, parentNode: Record<string, unknown>) => SearchOperatorOutput;
}

export interface SearchDomainPackRuntime {
  operatorSelectionPolicy: string;
  searchOperators: SearchOperator[];
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
