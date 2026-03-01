/**
 * Writing type definitions shared between KEEP modules.
 *
 * Extracted from tools/writing/types.ts for use by renderLatex.ts
 * without depending on the writing pipeline types module.
 */

export type SentenceType =
  | 'fact'
  | 'definition'
  | 'comparison'
  | 'interpretation'
  | 'transition'
  | 'limitation'
  | 'future_work';

export interface SentenceAttribution {
  sentence: string;
  sentence_index: number;
  claim_ids: string[];
  evidence_ids: string[];
  evidence_fingerprints?: string[];
  citations: string[];
  type: SentenceType;
  is_grounded: boolean;
  sentence_latex?: string;
}
