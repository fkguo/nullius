import type { SamplingCostClass, SamplingMetadata, ToolRiskLevel } from '@autoresearch/shared';

export type SamplingBackendName = 'anthropic';

export interface SamplingRouteDefinition {
  backend: SamplingBackendName;
  model: string;
  max_tokens?: number;
  fallbacks?: string[];
}

export interface SamplingRouteSelectors {
  tools: Record<string, string>;
  modules: Record<string, string>;
  module_prompt_versions: Record<string, string>;
  risk_levels: Partial<Record<ToolRiskLevel, string>>;
  cost_classes: Partial<Record<SamplingCostClass, string>>;
}

export interface SamplingRoutingConfig {
  version: 1;
  default_route: string;
  routes: Record<string, SamplingRouteDefinition>;
  selectors: SamplingRouteSelectors;
}

export interface SamplingRouteSelectorMatch {
  kind: 'module_prompt_version' | 'module' | 'tool' | 'risk_level' | 'cost_class' | 'default';
  key: string;
}

export interface ResolvedSamplingRoute extends SamplingRouteDefinition {
  route_key: string;
  selector: SamplingRouteSelectorMatch;
  attempt_route_keys: string[];
  metadata: SamplingMetadata;
}
