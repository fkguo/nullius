import type { EvalResult } from '../../src/eval/index.js';
import type { ChallengeExtractionResult } from '../../src/tools/research/synthesis/challengeExtraction.js';

export type Sem13Input = {
  papers: Array<{ recid: string; title: string; methodology?: string }>;
  critical_results?: Array<{ paper_recid: string; integrated_assessment?: { key_concerns?: string[]; recommendations?: string[] } }>;
};
export type Sem13Expected = { status: 'detected' | 'no_challenge_detected' | 'uncertain'; challenge_types: string[] };
export type Sem13Actual = ChallengeExtractionResult;

function overlap(expected: string[], actual: string[]): { tp: number; fp: number; fn: number } {
  const exp = new Set(expected);
  const act = new Set(actual);
  const tp = [...act].filter(item => exp.has(item)).length;
  const fp = [...act].filter(item => !exp.has(item)).length;
  const fn = [...exp].filter(item => !act.has(item)).length;
  return { tp, fp, fn };
}

export function aggregateSem13(results: Array<EvalResult<Sem13Actual>>) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let exact = 0;
  let noChallengeTotal = 0;
  let noChallengeCorrect = 0;
  let falsePositives = 0;
  for (const result of results) {
    const expected = result.expected as Sem13Expected;
    const stats = overlap(expected.challenge_types, result.actual.challenge_types);
    tp += stats.tp;
    fp += stats.fp;
    fn += stats.fn;
    if (JSON.stringify([...expected.challenge_types].sort()) === JSON.stringify([...result.actual.challenge_types].sort()) && expected.status === result.actual.status) exact += 1;
    if (expected.status === 'no_challenge_detected' || expected.status === 'uncertain') {
      noChallengeTotal += 1;
      if (expected.status === result.actual.status) noChallengeCorrect += 1;
      if (result.actual.challenge_types.length > 0 || result.actual.status === 'detected') falsePositives += 1;
    }
  }
  const precision = tp === 0 ? 0 : tp / (tp + fp);
  const recall = tp === 0 ? 0 : tp / (tp + fn);
  return {
    challenge_precision_overall: precision,
    challenge_recall_overall: recall,
    taxonomy_exact_match: exact / Math.max(results.length, 1),
    no_challenge_uncertain_accuracy: noChallengeCorrect / Math.max(noChallengeTotal, 1),
    false_positive_rate: falsePositives / Math.max(noChallengeTotal, 1),
  };
}
