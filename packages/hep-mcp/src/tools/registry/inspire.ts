import { getHepToolRiskLevel } from '../../tool-risk.js';
import type { ToolSpec } from './types.js';
import { RAW_INSPIRE_SEARCH_TOOL_SPECS } from './inspireSearch.js';
import { RAW_INSPIRE_RESEARCH_TOOL_SPECS } from './inspireResearch.js';

const RAW_INSPIRE_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = [
  ...RAW_INSPIRE_SEARCH_TOOL_SPECS,
  ...RAW_INSPIRE_RESEARCH_TOOL_SPECS,
];

export const INSPIRE_TOOL_SPECS: ToolSpec[] = RAW_INSPIRE_TOOL_SPECS.map(spec => ({
  ...spec,
  riskLevel: getHepToolRiskLevel(spec.name),
}));
