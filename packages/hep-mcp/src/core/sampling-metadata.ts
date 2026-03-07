import {
  buildSamplingMetadata,
  type SamplingCostClass,
  type SamplingMetadata,
  type SamplingMetadataContext,
  type ToolRiskLevel,
} from '@autoresearch/shared';

export function buildToolSamplingMetadata(params: {
  tool: string;
  module: string;
  promptVersion: string;
  costClass: SamplingCostClass;
  riskLevel?: ToolRiskLevel;
  context?: SamplingMetadataContext;
}): SamplingMetadata {
  return buildSamplingMetadata({
    module: params.module,
    tool: params.tool,
    prompt_version: params.promptVersion,
    risk_level: params.riskLevel ?? 'read',
    cost_class: params.costClass,
    context: params.context,
  });
}
