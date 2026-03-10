import { createHash } from 'crypto';

export {
  SemanticAssessmentBackendSchema,
  SemanticAssessmentStatusSchema,
  SemanticAssessmentProvenanceSchema,
  type SemanticAssessmentBackend,
  type SemanticAssessmentStatus,
  type SemanticAssessmentProvenance,
} from '@autoresearch/shared';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function withSignals(signals: string[]): string[] | undefined {
  const unique = [...new Set(signals.map(signal => signal.trim()).filter(Boolean))];
  return unique.length > 0 ? unique : undefined;
}
