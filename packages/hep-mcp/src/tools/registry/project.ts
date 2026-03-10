import { getHepToolRiskLevel } from '../../tool-risk.js';
import type { ToolSpec } from './types.js';
import { RAW_PROJECT_CORE_TOOL_SPECS } from './projectCore.js';
import { RAW_PROJECT_CITATION_TOOL_SPECS } from './projectCitation.js';
import { RAW_PROJECT_EXTENSION_TOOL_SPECS } from './projectExtensions.js';

function withRiskLevel(spec: Omit<ToolSpec, 'riskLevel'>): ToolSpec {
  return {
    ...spec,
    riskLevel: getHepToolRiskLevel(spec.name),
  };
}

export const PROJECT_CORE_TOOL_SPECS: ToolSpec[] = RAW_PROJECT_CORE_TOOL_SPECS.map(withRiskLevel);

export const PROJECT_CITATION_TOOL_SPECS: ToolSpec[] = RAW_PROJECT_CITATION_TOOL_SPECS.map(withRiskLevel);

export const PROJECT_EXTENSION_TOOL_SPECS: ToolSpec[] = RAW_PROJECT_EXTENSION_TOOL_SPECS.map(withRiskLevel);

export const PROJECT_TOOL_SPECS: ToolSpec[] = [
  ...PROJECT_CORE_TOOL_SPECS,
  ...PROJECT_CITATION_TOOL_SPECS,
  ...PROJECT_EXTENSION_TOOL_SPECS,
];
