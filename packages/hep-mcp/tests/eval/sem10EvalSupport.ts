import type { EvalResult } from '../../src/eval/index.js';
import type {
  CollectionSemanticGrouping,
  GroupingPaper,
} from '../../src/tools/research/synthesis/collectionSemanticGrouping.js';

export type Sem10Input = { papers: GroupingPaper[] };
export type Sem10Expected = {
  topic_clusters: string[][];
  method_clusters: string[][];
};
export type Sem10Actual = {
  topic_assignments: Record<string, string>;
  method_assignments: Record<string, string>;
  fallback_rate: number;
  permutation_stability: number;
  public_keyword_leak_rate: number;
  public_label_leak_rate: number;
};

const PUBLIC_AUTHORITY_LABELS = new Set([
  'heavy_neutral_lepton',
  'exotic_hadron_spectroscopy',
  'flavor_anomalies',
  'hadronic_form_factors',
  'experimental_simulation',
  'dispersive_amplitude',
  'effective_field_theory',
  'lattice_nonperturbative',
  'mixed_methods',
  'heuristic_fallback',
]);

function canonicalText(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function clustersToAssignments(clusters: string[][]): Record<string, string> {
  const normalizedClusters = clusters
    .map(cluster => [...cluster].sort())
    .sort((left, right) => left[0].localeCompare(right[0]) || left.length - right.length);
  return Object.fromEntries(
    normalizedClusters.flatMap((cluster, index) =>
      cluster.map(recid => [recid, `cluster_${index + 1}`]),
    ),
  );
}

function normalizeActualAssignments(
  assignments: Record<string, string>,
): Record<string, string> {
  const groups = new Map<string, string[]>();
  for (const [recid, label] of Object.entries(assignments)) {
    groups.set(label, [...(groups.get(label) ?? []), recid]);
  }
  return clustersToAssignments([...groups.values()]);
}

function pairwiseF1(assignments: Record<string, string>): Set<string> {
  const keys = Object.keys(assignments).sort();
  const pairs = new Set<string>();
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      if (assignments[keys[i]] === assignments[keys[j]]) {
        pairs.add(`${keys[i]}::${keys[j]}`);
      }
    }
  }
  return pairs;
}

function f1(expected: Record<string, string>, actual: Record<string, string>): number {
  const expectedPairs = pairwiseF1(expected);
  const actualPairs = pairwiseF1(actual);
  if (expectedPairs.size === 0 && actualPairs.size === 0) {
    return exactAccuracy(expected, actual);
  }
  const truePositives = [...actualPairs].filter(pair =>
    expectedPairs.has(pair),
  ).length;
  const precision = actualPairs.size === 0 ? 0 : truePositives / actualPairs.size;
  const recall = expectedPairs.size === 0 ? 0 : truePositives / expectedPairs.size;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function exactAccuracy(expected: Record<string, string>, actual: Record<string, string>): number {
  const keys = Object.keys(expected);
  return keys.filter(key => expected[key] === actual[key]).length / Math.max(keys.length, 1);
}

export function shufflePapers(papers: GroupingPaper[], seed: number): GroupingPaper[] {
  const copy = [...papers];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = (seed + index * 7) % (index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

export function normalizeExpected(
  expected: Sem10Expected,
): Pick<Sem10Actual, 'topic_assignments' | 'method_assignments'> {
  return {
    topic_assignments: clustersToAssignments(expected.topic_clusters),
    method_assignments: clustersToAssignments(expected.method_clusters),
  };
}

function publicKeywordLeakRate(result: CollectionSemanticGrouping): number {
  const groups = [...result.topic_groups, ...result.method_groups];
  if (groups.length === 0) return 0;
  const leaking = groups.filter(group =>
    group.keywords.some(keyword => PUBLIC_AUTHORITY_LABELS.has(canonicalText(keyword))),
  ).length;
  return leaking / groups.length;
}

function publicLabelLeakRate(result: CollectionSemanticGrouping): number {
  const labels = [
    ...result.topic_groups.map(group => group.label),
    ...result.method_groups.map(group => group.label),
    ...Object.values(result.topic_assignments),
    ...Object.values(result.method_assignments),
    ...Object.values(result.topic_assignment_details).map(detail => detail.label),
    ...Object.values(result.method_assignment_details).map(detail => detail.label),
  ];
  if (labels.length === 0) return 0;
  const leaking = labels.filter(label =>
    PUBLIC_AUTHORITY_LABELS.has(canonicalText(label)),
  ).length;
  return leaking / labels.length;
}

export function normalizeGrouping(result: CollectionSemanticGrouping): Sem10Actual {
  return {
    topic_assignments: normalizeActualAssignments(result.topic_assignments),
    method_assignments: normalizeActualAssignments(result.method_assignments),
    fallback_rate: (result.topic_fallback_rate + result.method_fallback_rate) / 2,
    permutation_stability: 1,
    public_keyword_leak_rate: publicKeywordLeakRate(result),
    public_label_leak_rate: publicLabelLeakRate(result),
  };
}

export function aggregateSem10(results: Array<EvalResult<Sem10Actual>>) {
  const topicF1 = results.reduce((sum, result) => {
    const expected = normalizeExpected(result.expected as Sem10Expected);
    return sum + f1(expected.topic_assignments, result.actual.topic_assignments);
  }, 0) / Math.max(results.length, 1);

  const methodF1 = results.reduce((sum, result) => {
    const expected = normalizeExpected(result.expected as Sem10Expected);
    return sum + f1(expected.method_assignments, result.actual.method_assignments);
  }, 0) / Math.max(results.length, 1);

  const hard = results.filter(
    result =>
      result.tags.includes('sparse_keywords') ||
      result.tags.includes('terminology_drift'),
  );
  const hardF1 = hard.reduce((sum, result) => {
    const expected = normalizeExpected(result.expected as Sem10Expected);
    return sum + (f1(expected.topic_assignments, result.actual.topic_assignments) + f1(expected.method_assignments, result.actual.method_assignments)) / 2;
  }, 0) / Math.max(hard.length, 1);

  return {
    topic_pairwise_f1: topicF1,
    method_pairwise_f1: methodF1,
    grouping_f1_overall: (topicF1 + methodF1) / 2,
    exact_assignment_accuracy: results.reduce((sum, result) => {
      const expected = normalizeExpected(result.expected as Sem10Expected);
      return sum + (exactAccuracy(expected.topic_assignments, result.actual.topic_assignments) + exactAccuracy(expected.method_assignments, result.actual.method_assignments)) / 2;
    }, 0) / Math.max(results.length, 1),
    hard_subset_f1: hardF1,
    permutation_stability_overall: results.reduce(
      (sum, result) => sum + result.actual.permutation_stability,
      0,
    ) / Math.max(results.length, 1),
    fallback_rate_overall: results.reduce(
      (sum, result) => sum + result.actual.fallback_rate,
      0,
    ) / Math.max(results.length, 1),
    public_keyword_leak_rate: results.reduce(
      (sum, result) => sum + result.actual.public_keyword_leak_rate,
      0,
    ) / Math.max(results.length, 1),
    public_label_leak_rate: results.reduce(
      (sum, result) => sum + result.actual.public_label_leak_rate,
      0,
    ) / Math.max(results.length, 1),
  };
}
