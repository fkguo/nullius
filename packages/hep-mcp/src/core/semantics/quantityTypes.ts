export type QuantityDecisionV1 = 'match' | 'split' | 'uncertain';

export type QuantityReasonCodeV1 =
  | 'same_quantity'
  | 'different_quantity'
  | 'unit_incompatible'
  | 'ambiguous_symbol'
  | 'insufficient_context'
  | 'invalid_response'
  | 'sampling_unavailable'
  | 'other';

export type QuantityMentionV1 = {
  quantity: string;
  context: string;
  unit?: string;
};

export type UnitNormalizationV1 = {
  a_unit?: string;
  b_unit?: string;
  canonical_unit?: string;
  unit_category?: string;
};

