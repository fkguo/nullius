import { accuracy, f1, type EvalResult } from '../../src/eval/index.js';
import { analyzeCitationStance, extractTopicWords } from '../../src/core/semantics/citationStanceHeuristics.js';
import type { ClaimStanceV1, ExtractedClaimV1 } from '../../src/core/semantics/claimTypes.js';

export type Sem02Input = {
  claim_text: string;
  evidence_items: Array<{ evidence_ref: string; evidence_text: string }>;
  mock_responses: Array<Record<string, unknown> | 'INVALID'>;
};

export type Sem02Expected = { stance: ClaimStanceV1 };

export type Sem02Actual = {
  stance: ClaimStanceV1;
  usedFallback: boolean;
  abstained: boolean;
};

export function buildClaim(caseId: string, claimText: string): ExtractedClaimV1 {
  return {
    claim_id: caseId,
    claim_text: claimText,
    source_context: { before: '', after: '' },
    evidence_level: 'evidence',
    provenance: {
      backend: 'heuristic',
      used_fallback: false,
      prompt_version: 'eval',
      input_hash: `eval:${caseId}`,
    },
    used_fallback: false,
  };
}

export function baselineGrade(input: Sem02Input): Sem02Actual {
  const stances = input.evidence_items.map(item => analyzeCitationStance(item.evidence_text, extractTopicWords(input.claim_text)).stance);
  const hasSupport = stances.includes('confirming');
  const hasConflict = stances.includes('contradicting');
  const stance: ClaimStanceV1 = hasSupport && hasConflict ? 'mixed' : hasConflict ? 'conflicting' : hasSupport ? 'supported' : 'not_supported';
  return { stance, usedFallback: true, abstained: stance === 'not_supported' };
}

function macroF1(results: Array<EvalResult<Sem02Actual>>): number {
  const labels: ClaimStanceV1[] = ['supported', 'weak_support', 'not_supported', 'mixed', 'conflicting'];
  const scores = labels.map(label => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const result of results) {
      if (!result.actual) continue;
      const expected = (result.expected as Sem02Expected).stance;
      const predicted = result.actual.stance;
      if (predicted === label && expected === label) tp += 1;
      else if (predicted === label && expected !== label) fp += 1;
      else if (predicted !== label && expected === label) fn += 1;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    return f1(precision, recall);
  });
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

export function aggregateMetrics(
  results: Array<EvalResult<Sem02Actual>>,
  filter: (result: EvalResult<Sem02Actual>) => boolean,
) {
  const scoped = results.filter(filter).filter((result): result is EvalResult<Sem02Actual> & { actual: Sem02Actual } => result.actual !== null);
  const correct = scoped.filter(result => result.actual.stance === (result.expected as Sem02Expected).stance).length;
  return {
    accuracy: accuracy(correct, scoped.length),
    macro_f1: macroF1(scoped),
    fallback_rate: scoped.length > 0 ? scoped.filter(result => result.actual.usedFallback).length / scoped.length : 0,
    abstention_rate: scoped.length > 0 ? scoped.filter(result => result.actual.abstained).length / scoped.length : 0,
  };
}
