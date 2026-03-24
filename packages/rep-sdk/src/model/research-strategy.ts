export type StrategyPreset = 'explore' | 'deepen' | 'verify' | 'consolidate';

export interface ResearchStrategyMethod {
  approach: string;
  tools: string[];
  model?: string;
}

export interface ParameterRange {
  min?: number;
  max?: number;
  unit?: string;
}

export interface StrategyApproximation {
  name: string;
  validity_condition: string;
  estimated_error?: string;
}

export interface ExpectedOutcomeQuantity {
  name: string;
  type?: 'scalar' | 'vector' | 'matrix' | 'function' | 'distribution';
  unit?: string;
}

export interface ValidationCriterion {
  name: string;
  method: string;
  tolerance?: number;
  required?: boolean;
}

export interface ResearchStrategy {
  schema_version: 1;
  strategy_id: string;
  name: string;
  description: string;
  objective: string;
  method: ResearchStrategyMethod;
  constraints?: {
    parameter_ranges?: Record<string, ParameterRange>;
    approximations?: StrategyApproximation[];
    assumptions?: string[];
  };
  expected_outcome_form?: {
    quantities?: ExpectedOutcomeQuantity[];
    format?: string;
  };
  domain: string;
  applicable_when?: string[];
  validation_criteria: [ValidationCriterion, ...ValidationCriterion[]];
  preset?: StrategyPreset;
  tags?: string[];
}
