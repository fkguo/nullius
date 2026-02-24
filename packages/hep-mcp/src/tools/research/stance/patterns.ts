/**
 * Stance Detection Patterns
 *
 * Pattern rules for citation stance detection.
 * Based on the design document: docs/STANCE_DETECTION_IMPROVEMENT_PLAN.md
 */

import type { PatternRule, HedgePattern } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Confirming Patterns
// ─────────────────────────────────────────────────────────────────────────────

export const CONFIRMING_PATTERNS: PatternRule[] = [
  // ─── Strong confirmation (weight: 3) ───
  {
    id: 'confirm_strong_agreement',
    stance: 'confirming',
    weight: 3,
    pattern: /\b(?:strongly|clearly|definitively)\s+(?:confirms?|supports?|validates?)\b/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Strong explicit confirmation',
  },
  {
    id: 'confirm_excellent_agreement',
    stance: 'confirming',
    weight: 3,
    pattern: /\b(?:in\s+excellent\s+agreement\s+with|fully\s+consistent\s+with)\b/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Excellent agreement expression',
  },
  {
    id: 'confirm_verified',
    stance: 'confirming',
    weight: 2,
    pattern: /\b(?:verified|reproduced|validated|corroborated)\b/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Verification language',
  },

  // ─── Standard confirmation (weight: 1-2) ───
  {
    id: 'confirm_consistent',
    stance: 'confirming',
    weight: 1,
    pattern: /\b(?:consistent\s+with|compatible\s+with)\b/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Standard consistency expression',
  },
  {
    id: 'confirm_agreement',
    stance: 'confirming',
    weight: 1,
    pattern: /\b(?:in\s+(?:good\s+)?agreement\s+with|agrees?\s+with)\b/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Agreement expression',
  },
  {
    id: 'confirm_supports',
    stance: 'confirming',
    weight: 1,
    pattern: /\b(?:supports?|in\s+line\s+with|in\s+accord\s+with)\b/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Support expression',
  },
  {
    id: 'confirm_confirms',
    stance: 'confirming',
    weight: 2,
    pattern: /\b(?:confirms?|corroborates?)\b/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Confirmation verb',
  },

  // ─── HEP-specific quantified confirmation (weight: 2) ───
  {
    id: 'confirm_within_sigma',
    stance: 'confirming',
    weight: 2,
    pattern: /\bconsistent\s+within\s+\d+\s*[σ\\sigma]/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Consistency within N sigma',
  },
  {
    id: 'confirm_compatible_cl',
    stance: 'confirming',
    weight: 2,
    pattern: /\bcompatible\s+at\s+the\s+\d+%?\s*(?:CL|C\.L\.|confidence\s+level)\b/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Compatible at confidence level',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Contradicting Patterns
// ─────────────────────────────────────────────────────────────────────────────

export const CONTRADICTING_PATTERNS: PatternRule[] = [
  // ─── Strong contradiction (weight: 3) ───
  {
    id: 'contra_rules_out',
    stance: 'contradicting',
    weight: 3,
    pattern: /\b(?:rules?\s+out|excludes?|ruled\s+out|excluded)\b/i,
    negatable: true,
    negationBehavior: 'neutral', // "cannot rule out" → neutral
    description: 'Rules out / excludes',
  },
  {
    id: 'contra_refutes',
    stance: 'contradicting',
    weight: 3,
    pattern: /\b(?:refutes?|disproves?|falsifies?)\b/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Refutation language',
  },

  // ─── Medium contradiction (weight: 2) ───
  {
    id: 'contra_inconsistent',
    stance: 'contradicting',
    weight: 2,
    pattern: /\b(?:inconsistent\s+with|incompatible\s+with)\b/i,
    negatable: true,
    negationBehavior: 'weak_confirm', // "not inconsistent" → weak confirm
    description: 'Inconsistency expression',
  },
  {
    id: 'contra_conflicts',
    stance: 'contradicting',
    weight: 2,
    pattern: /\b(?:conflicts?\s+with|contradicts?|contrary\s+to)\b/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Conflict expression',
  },
  {
    id: 'contra_disagrees',
    stance: 'contradicting',
    weight: 2,
    pattern: /\b(?:disagrees?\s+with|at\s+variance\s+with)\b/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Disagreement expression',
  },

  // ─── Weak contradiction (weight: 1) ───
  {
    id: 'contra_tension',
    stance: 'contradicting',
    weight: 1,
    pattern: /\b(?:in\s+tension\s+with|at\s+odds\s+with)\b/i,
    negatable: true,
    negationBehavior: 'weak_confirm', // "no tension" → weak confirm
    description: 'Tension expression',
  },
  {
    id: 'contra_disfavors',
    stance: 'contradicting',
    weight: 1,
    pattern: /\b(?:disfavou?rs?|challenges?)\b/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Disfavor/challenge expression',
  },
  {
    id: 'contra_deviates',
    stance: 'contradicting',
    weight: 1,
    pattern: /\b(?:deviates?\s+from|differs?\s+from)\b/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Deviation expression',
  },

  // ─── Patterns with built-in negation (not negatable) ───
  {
    id: 'contra_fails_to',
    stance: 'contradicting',
    weight: 2,
    pattern: /\b(?:fails?\s+to\s+(?:confirm|support|reproduce))\b/i,
    negatable: false,
    description: 'Fails to confirm/support',
  },
  {
    id: 'contra_does_not_support',
    stance: 'contradicting',
    weight: 2,
    pattern: /\b(?:does\s+not\s+support|do\s+not\s+support)\b/i,
    negatable: false,
    description: 'Does not support',
  },
  {
    id: 'contra_no_evidence',
    stance: 'contradicting',
    weight: 1,
    pattern: /\b(?:no\s+evidence\s+for|find\s+no\s+evidence)\b/i,
    negatable: false,
    description: 'No evidence found',
  },

  // ─── HEP-specific update/supersede (weight: 1) ───
  {
    id: 'contra_supersedes',
    stance: 'contradicting',
    weight: 1,
    pattern: /\b(?:supersedes?|updates?|revises?)\b/i,
    negatable: true,
    negationBehavior: 'flip',
    description: 'Supersedes/updates previous work',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Exception Patterns (special negation phrases, higher priority)
// ─────────────────────────────────────────────────────────────────────────────

export const EXCEPTION_PATTERNS: PatternRule[] = [
  {
    id: 'exception_not_inconsistent',
    stance: 'confirming',
    weight: 1,
    pattern: /\bnot\s+inconsistent\s+with\b/i,
    negatable: false, // Cannot be flipped again
    isHedge: true,    // Reduces confidence
    description: 'Double negation: not inconsistent',
  },
  {
    id: 'exception_no_tension',
    stance: 'confirming',
    weight: 1,
    pattern: /\bno\s+(?:significant\s+)?tension\s+(?:with|between)\b/i,
    negatable: false,
    description: 'No tension expression',
  },
  {
    id: 'exception_cannot_rule_out',
    stance: 'neutral',
    weight: 0,
    pattern: /\b(?:cannot|can\s*not|could\s*not)\s+(?:be\s+)?(?:rule[d]?\s+out|exclude[d]?)\b/i,
    negatable: false,
    description: 'Cannot rule out - triggers LLM review',
  },
  {
    id: 'exception_not_excluded',
    stance: 'neutral',
    weight: 0,
    pattern: /\b(?:is\s+)?not\s+(?:excluded|ruled\s+out)\b/i,
    negatable: false,
    description: 'Not excluded/ruled out',
  },
  {
    id: 'exception_no_evidence_found',
    stance: 'neutral',
    weight: 0,
    pattern: /\bno\s+evidence\s+(?:is\s+)?found\b/i,
    negatable: false,
    description: 'No evidence found (passive)',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Hedge Patterns
// ─────────────────────────────────────────────────────────────────────────────

export const HEDGE_PATTERNS: HedgePattern[] = [
  // Modal verbs
  { pattern: /\b(?:may|might|could)\b/i, downgrade: 0.3 },
  { pattern: /\b(?:would|should)\b/i, downgrade: 0.2 },

  // Weak verbs
  { pattern: /\b(?:suggests?|indicates?|implies?)\b/i, downgrade: 0.2 },
  { pattern: /\b(?:appears?\s+to|seems?\s+to)\b/i, downgrade: 0.25 },

  // Qualifiers
  { pattern: /\b(?:tentative|preliminary|potential)\b/i, downgrade: 0.3 },
  { pattern: /\b(?:marginal|weak|slight)\b/i, downgrade: 0.2 },
  { pattern: /\b(?:possible|possibly|probable|probably)\b/i, downgrade: 0.25 },

  // Uncertainty expressions
  { pattern: /\b(?:within\s+(?:large\s+)?uncertainties)\b/i, downgrade: 0.2 },
  { pattern: /\b(?:within\s+errors?)\b/i, downgrade: 0.15 },
  { pattern: /\b(?:given\s+the\s+(?:large\s+)?uncertainties)\b/i, downgrade: 0.25 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Methodological Patterns (force neutral for tool/method citations)
// ─────────────────────────────────────────────────────────────────────────────

export const METHODOLOGICAL_PATTERNS: RegExp[] = [
  /\b(?:using|via|with|implemented\s+in|generated\s+by|simulated\s+with)\s+(?:\\cite|Ref)/i,
  /\b(?:PYTHIA|GEANT4|ROOT|MADGRAPH|SHERPA|POWHEG|EvtGen|PHOTOS)\b/i,
  /\b(?:following\s+the\s+(?:method|procedure|approach)\s+(?:of|in))\b/i,
  /\b(?:as\s+described\s+in|detailed\s+in)\b/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// Constraint/Limit Patterns (neutral - not stance)
// ─────────────────────────────────────────────────────────────────────────────

export const CONSTRAINT_PATTERNS: RegExp[] = [
  /\bset\s+(?:upper\s+)?limits?\s+on\b/i,
  /\bplace\s+constraints?\s+on\b/i,
  /\bobtain\s+(?:upper\s+)?bounds?\s+on\b/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// Disclaimer Patterns (neutral - out of scope)
// ─────────────────────────────────────────────────────────────────────────────

export const DISCLAIMER_PATTERNS: RegExp[] = [
  /\bwe\s+do\s+not\s+(?:attempt|address)\b/i,
  /\bbeyond\s+the\s+scope\b/i,
  /\boutside\s+the\s+scope\b/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// Negation Words (academic style)
// ─────────────────────────────────────────────────────────────────────────────

export const NEGATION_WORDS: string[] = [
  'not', 'no', 'never', 'neither', 'none',
  'cannot', "can't", "don't", "doesn't", "didn't",
  'without', 'lack', 'absence', 'fails', 'unable', 'unlikely',
];

// ─────────────────────────────────────────────────────────────────────────────
// Ownership Markers
// ─────────────────────────────────────────────────────────────────────────────

export const OWNERSHIP_MARKERS = {
  ours: [
    'we', 'our', 'this work', 'present work', 'present study',
    'this analysis', 'this measurement', 'this paper',
    'here', 'report',
  ],
  theirs: [
    'they', 'their', 'Ref.', 'et al.', 'reported', 'measured', 'observed',
    'previous', 'earlier', 'prior', 'former', 'in ref', 'reference',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Experiment Names (for ownership detection)
// ─────────────────────────────────────────────────────────────────────────────

export const EXPERIMENT_NAMES: string[] = [
  'ATLAS', 'CMS', 'LHCb', 'ALICE', 'Belle', 'Belle II', 'BaBar',
  'Planck', 'BESIII', 'CLEO', 'D0', 'CDF', 'NA62', 'KLOE', 'COMPASS',
  'DELPHI', 'OPAL', 'L3', 'ALEPH', 'SLD', 'BES', 'CLAS', 'GlueX',
];

// ─────────────────────────────────────────────────────────────────────────────
// Contrast Markers
// ─────────────────────────────────────────────────────────────────────────────

export const CONTRAST_MARKERS: string[] = [
  'however', 'but', 'nevertheless', 'nonetheless', 'yet',
  'in contrast', 'on the other hand', 'conversely', 'although',
  'while', 'whereas', 'unlike', 'on the contrary',
];

// ─────────────────────────────────────────────────────────────────────────────
// Statistical Significance Patterns
// ─────────────────────────────────────────────────────────────────────────────

export const SIGMA_PATTERNS: RegExp[] = [
  /(\d+\.?\d*)\s*[σ\\sigma]/i,
  /(\d+\.?\d*)\s*sigma/i,
  /(\d+\.?\d*)\s*standard\s+deviations?/i,
  /significance\s+of\s+(\d+\.?\d*)/i,
  /(\d+\.?\d*)\s*%\s*(?:CL|C\.L\.|confidence\s+level)/i,
];
