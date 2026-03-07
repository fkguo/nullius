import type { EvalResult } from '../../src/eval/index.js';
import type { CollectionSemanticGrouping, GroupingPaper } from '../../src/tools/research/synthesis/collectionSemanticGrouping.js';

export type Sem10Input = { papers: GroupingPaper[] };
export type Sem10Expected = { topic_assignments: Record<string, string>; method_assignments: Record<string, string> };
export type Sem10Actual = Sem10Expected & { fallback_rate: number; permutation_stability: number };

const TOPIC_ALIASES: Record<string, string[]> = {
  heavy_neutral_lepton: ['heavy_neutral_lepton', 'sterile_neutrino', 'hnl', 'long_lived_neutrino'],
  exotic_hadron_spectroscopy: ['exotic_hadron_spectroscopy', 'tetraquark', 'line_shapes', 'hadron'],
  flavor_anomalies: ['flavor_anomalies', 'semileptonic', 'rare_decay', 'wilson'],
  hadronic_form_factors: ['hadronic_form_factors', 'form_factor', 'matrix_element'],
  uncertain: ['general', 'uncertain'],
};

const METHOD_ALIASES: Record<string, string[]> = {
  experimental_simulation: ['experimental_simulation', 'simulation', 'detector', 'template', 'response'],
  dispersive_amplitude: ['dispersive_amplitude', 'dispersion', 'unitarity', 'amplitude', 'bootstrap'],
  effective_field_theory: ['effective_field_theory', 'effective theory', 'eft', 'smeft', 'operator'],
  lattice_nonperturbative: ['lattice_nonperturbative', 'lattice', 'finite_volume', 'nonperturbative'],
  cross_cutting: ['cross_cutting', 'mixed'],
  uncertain: ['general', 'uncertain'],
};

function canonicalize(label: string, aliases: Record<string, string[]>): string {
  const text = label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (Object.hasOwn(aliases, text)) return text;
  for (const [canonical, variants] of Object.entries(aliases)) {
    if (variants.some(variant => text.includes(variant))) return canonical;
  }
  return 'uncertain';
}

function pairwiseF1(assignments: Record<string, string>): Set<string> {
  const keys = Object.keys(assignments).sort();
  const pairs = new Set<string>();
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      if (assignments[keys[i]] === assignments[keys[j]]) pairs.add(`${keys[i]}::${keys[j]}`);
    }
  }
  return pairs;
}

function f1(expected: Record<string, string>, actual: Record<string, string>): number {
  const expectedPairs = pairwiseF1(expected);
  const actualPairs = pairwiseF1(actual);
  const truePositives = [...actualPairs].filter(pair => expectedPairs.has(pair)).length;
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

export function normalizeGrouping(result: CollectionSemanticGrouping): Sem10Actual {
  return {
    topic_assignments: Object.fromEntries(Object.entries(result.topic_assignments).map(([recid, label]) => [recid, canonicalize(label, TOPIC_ALIASES)])),
    method_assignments: Object.fromEntries(Object.entries(result.method_assignments).map(([recid, label]) => [recid, canonicalize(label, METHOD_ALIASES)])),
    fallback_rate: (result.topic_fallback_rate + result.method_fallback_rate) / 2,
    permutation_stability: 1,
  };
}

export function aggregateSem10(results: Array<EvalResult<Sem10Actual>>) {
  const topicF1 = results.reduce((sum, result) => sum + f1((result.expected as Sem10Expected).topic_assignments, result.actual.topic_assignments), 0) / Math.max(results.length, 1);
  const methodF1 = results.reduce((sum, result) => sum + f1((result.expected as Sem10Expected).method_assignments, result.actual.method_assignments), 0) / Math.max(results.length, 1);
  const hard = results.filter(result => result.tags.includes('sparse_keywords') || result.tags.includes('terminology_drift'));
  const hardF1 = hard.reduce((sum, result) => sum + (f1((result.expected as Sem10Expected).topic_assignments, result.actual.topic_assignments) + f1((result.expected as Sem10Expected).method_assignments, result.actual.method_assignments)) / 2, 0) / Math.max(hard.length, 1);
  return {
    topic_pairwise_f1: topicF1,
    method_pairwise_f1: methodF1,
    grouping_f1_overall: (topicF1 + methodF1) / 2,
    exact_assignment_accuracy: results.reduce((sum, result) => sum + (exactAccuracy((result.expected as Sem10Expected).topic_assignments, result.actual.topic_assignments) + exactAccuracy((result.expected as Sem10Expected).method_assignments, result.actual.method_assignments)) / 2, 0) / Math.max(results.length, 1),
    hard_subset_f1: hardF1,
    permutation_stability_overall: results.reduce((sum, result) => sum + result.actual.permutation_stability, 0) / Math.max(results.length, 1),
    fallback_rate_overall: results.reduce((sum, result) => sum + result.actual.fallback_rate, 0) / Math.max(results.length, 1),
  };
}
