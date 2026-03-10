import { createHash } from 'crypto';

export type SemanticAssessmentBackend = 'mcp_sampling' | 'metadata' | 'diagnostic_fallback';
export type SemanticAssessmentStatus = 'applied' | 'metadata' | 'fallback' | 'abstained' | 'invalid' | 'unavailable';

export interface SemanticAssessmentProvenance {
  backend: SemanticAssessmentBackend;
  status: SemanticAssessmentStatus;
  used_fallback: boolean;
  reason_code: string;
  prompt_version?: string;
  input_hash?: string;
  model?: string;
  signals?: string[];
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function withSignals(signals: string[]): string[] | undefined {
  const unique = [...new Set(signals.map(signal => signal.trim()).filter(Boolean))];
  return unique.length > 0 ? unique : undefined;
}
