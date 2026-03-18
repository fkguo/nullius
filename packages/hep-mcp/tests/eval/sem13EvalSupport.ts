import type { EvalResult } from '../../src/eval/index.js';
import type { ChallengeExtractionResult } from '../../src/tools/research/synthesis/challengeExtraction.js';

export type Sem13Input = {
  papers: Array<{ recid: string; title: string; methodology?: string }>;
  critical_results?: Array<{
    paper_recid: string;
    integrated_assessment?: {
      key_concerns?: string[];
      recommendations?: string[];
    };
  }>;
};
export type Sem13Expected = {
  status: 'detected' | 'no_challenge_detected' | 'uncertain';
  challenge_markers: string[];
};
export type Sem13Actual = ChallengeExtractionResult & { rendered_summary?: string };

const TAXONOMY_WORDING = [
  'systematic uncertainty control',
  'acceptance or coverage limits',
  'cross-cutting methodological tension',
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function challengeHaystack(actual: Sem13Actual): string[] {
  return [
    ...actual.challenges.map(challenge => challenge.summary),
    ...actual.challenges.flatMap(challenge => challenge.evidence),
    actual.rendered_summary ?? '',
  ]
    .map(normalize)
    .filter(Boolean);
}

export function evaluateSem13(
  expected: Sem13Expected,
  actual: Sem13Actual,
): {
  matchedMarkers: string[];
  taxonomyLeak: boolean;
  passed: boolean;
} {
  const haystack = challengeHaystack(actual);
  const matchedMarkers = expected.challenge_markers.filter(marker => {
    const normalized = normalize(marker);
    return haystack.some(text => text.includes(normalized));
  });
  const taxonomyLeak = TAXONOMY_WORDING.some(wording =>
    normalize(actual.rendered_summary ?? '').includes(normalize(wording)),
  );
  const passed =
    expected.status === actual.status &&
    (expected.challenge_markers.length === 0
      ? actual.status !== 'detected' && actual.challenges.length === 0
      : matchedMarkers.length === expected.challenge_markers.length) &&
    !taxonomyLeak;
  return { matchedMarkers, taxonomyLeak, passed };
}

export function aggregateSem13(results: Array<EvalResult<Sem13Actual>>) {
  let matchedMarkers = 0;
  let expectedMarkers = 0;
  let exactStatus = 0;
  let noChallengeTotal = 0;
  let noChallengeCorrect = 0;
  let falsePositives = 0;
  let taxonomyLeaks = 0;

  for (const result of results) {
    const expected = result.expected as Sem13Expected;
    const evaluated = evaluateSem13(expected, result.actual);
    matchedMarkers += evaluated.matchedMarkers.length;
    expectedMarkers += expected.challenge_markers.length;
    if (expected.status === result.actual.status) exactStatus += 1;
    if (evaluated.taxonomyLeak) taxonomyLeaks += 1;
    if (
      expected.status === 'no_challenge_detected' ||
      expected.status === 'uncertain'
    ) {
      noChallengeTotal += 1;
      if (expected.status === result.actual.status) noChallengeCorrect += 1;
      if (
        result.actual.challenge_types.length > 0 ||
        result.actual.status === 'detected'
      ) {
        falsePositives += 1;
      }
    }
  }

  return {
    challenge_marker_coverage: matchedMarkers / Math.max(expectedMarkers, 1),
    status_accuracy: exactStatus / Math.max(results.length, 1),
    no_challenge_uncertain_accuracy:
      noChallengeCorrect / Math.max(noChallengeTotal, 1),
    false_positive_rate: falsePositives / Math.max(noChallengeTotal, 1),
    taxonomy_wording_leak_rate:
      taxonomyLeaks / Math.max(results.length, 1),
  };
}
