import { ORCH_TOOL_SPECS as GENERIC_ORCH_TOOL_SPECS } from '@autoresearch/orchestrator';
import type { ToolSpec } from '../registry.js';

type RawToolSpec = Omit<ToolSpec, 'riskLevel'>;

export const ORCH_TOOL_SPECS: RawToolSpec[] = GENERIC_ORCH_TOOL_SPECS as RawToolSpec[];
