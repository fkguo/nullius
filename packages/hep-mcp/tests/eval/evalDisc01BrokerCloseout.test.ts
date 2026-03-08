import { describe, expect, it } from 'vitest';

import {
  compareWithBaseline,
  loadBaseline,
  runEvalSet,
  type EvalCase,
} from '../../src/eval/index.js';
import { BASELINES_DIR, readEvalSetFixture } from './evalSnapshots.js';
import { runFederatedDiscovery, type DiscoveryProviderExecutors } from '../../src/tools/research/federatedDiscovery.js';
import type { CanonicalCandidate, DiscoveryProviderId, DiscoveryQueryIntent } from '@autoresearch/shared';

type Disc01Input = {
  query: string;
  intent: DiscoveryQueryIntent;
  preferred_providers?: DiscoveryProviderId[];
  providers: Partial<Record<DiscoveryProviderId, CanonicalCandidate[]>>;
};

type Disc01Expected = {
  selected_providers: DiscoveryProviderId[];
  provider_hit_providers: DiscoveryProviderId[];
  canonical_count: number;
  confident_merges: number;
  uncertain_groups: number;
  primary_identifier: string | null;
};

type Disc01Actual = Awaited<ReturnType<typeof runFederatedDiscovery>>;

function buildExecutors(input: Disc01Input): DiscoveryProviderExecutors {
  const build = (provider: DiscoveryProviderId) => async (request: { query: string }) => ({
    provider,
    query: request.query,
    candidates: input.providers[provider] ?? [],
    result_count: input.providers[provider]?.length ?? 0,
  });
  return {
    inspire: build('inspire'),
    openalex: build('openalex'),
    arxiv: build('arxiv'),
  };
}

function hasPrimaryIdentifier(actual: Disc01Actual, expected: Disc01Expected): boolean {
  if (!expected.primary_identifier) return true;
  return actual.papers.some(paper =>
    [paper.identifiers.doi, paper.identifiers.arxiv_id, paper.identifiers.recid, paper.identifiers.openalex_id]
      .filter((value): value is string => typeof value === 'string')
      .includes(expected.primary_identifier!),
  );
}

describe('NEW-DISC-01 broker eval closeout', () => {
  it('locks deterministic broker metrics against the baseline', async () => {
    const evalSet = readEvalSetFixture('disc01_broker_eval.json');
    const report = await runEvalSet<Disc01Input, Disc01Actual>(evalSet, {
      run: async input => runFederatedDiscovery({
        query: input.query,
        intent: input.intent,
        preferred_providers: input.preferred_providers,
        limit: 10,
        executors: buildExecutors(input),
      }),
      judge: (expected, actual) => {
        const exp = expected as Disc01Expected;
        const selectedProviders = actual.query_plan.selected_providers;
        const hitProviders = actual.provider_results.filter(r => r.result_count > 0).map(r => r.provider);
        const exactSelected = JSON.stringify(selectedProviders) === JSON.stringify(exp.selected_providers);
        const exactHits = JSON.stringify(hitProviders) === JSON.stringify(exp.provider_hit_providers);
        const canonicalOk = actual.papers.length === exp.canonical_count;
        const dedupOk = actual.dedup.confident_merges.length === exp.confident_merges
          && actual.dedup.uncertain_groups.length === exp.uncertain_groups;
        const identifierOk = hasPrimaryIdentifier(actual, exp);
        const uncertainOk = exp.uncertain_groups > 0
          ? actual.papers.every(paper => paper.merge_state === 'uncertain_match')
          : actual.dedup.uncertain_groups.length === 0;
        const passed = exactSelected && exactHits && canonicalOk && dedupOk && identifierOk && uncertainOk;
        return {
          passed,
          metrics: {
            provider_recall: exactHits ? 1 : 0,
            provider_precision: exactSelected ? 1 : 0,
            known_item_hit_rate: identifierOk ? 1 : 0,
            canonicalization_accuracy: canonicalOk ? 1 : 0,
            dedup_accuracy: dedupOk ? 1 : 0,
            uncertain_preservation_rate: uncertainOk ? 1 : 0,
          },
        };
      },
      aggregate: results => {
        const avg = (name: string) => results.reduce((sum, result) => sum + (result.metrics[name] ?? 0), 0) / results.length;
        return {
          provider_recall_overall: avg('provider_recall'),
          provider_precision_overall: avg('provider_precision'),
          known_item_hit_rate_overall: avg('known_item_hit_rate'),
          canonicalization_accuracy_overall: avg('canonicalization_accuracy'),
          dedup_accuracy_overall: avg('dedup_accuracy'),
          uncertain_preservation_rate_overall: avg('uncertain_preservation_rate'),
        };
      },
    });

    const baseline = loadBaseline(evalSet.name, BASELINES_DIR);
    const comparison = compareWithBaseline(report, baseline);

    expect(report.summary.failed).toBe(0);
    expect(report.aggregateMetrics.provider_recall_overall).toBe(1);
    expect(report.aggregateMetrics.provider_precision_overall).toBe(1);
    expect(report.aggregateMetrics.known_item_hit_rate_overall).toBe(1);
    expect(report.aggregateMetrics.canonicalization_accuracy_overall).toBe(1);
    expect(report.aggregateMetrics.dedup_accuracy_overall).toBe(1);
    expect(report.aggregateMetrics.uncertain_preservation_rate_overall).toBe(1);
    expect(comparison.isFirstRun).toBe(false);
    expect(Object.values(comparison.deltas).every(delta => delta.current >= delta.baseline)).toBe(true);
  });

  const holdoutIt = process.env.EVAL_INCLUDE_HOLDOUT === '1' ? it : it.skip;

  holdoutIt('passes the holdout broker slice', async () => {
    const evalSet = readEvalSetFixture('disc01_broker_eval_holdout.json');
    const report = await runEvalSet<Disc01Input, Disc01Actual>(evalSet, {
      run: async input => runFederatedDiscovery({
        query: input.query,
        intent: input.intent,
        preferred_providers: input.preferred_providers,
        limit: 10,
        executors: buildExecutors(input),
      }),
      judge: (expected, actual) => {
        const exp = expected as Disc01Expected;
        const hitProviders = actual.provider_results.filter(r => r.result_count > 0).map(r => r.provider);
        const identifierOk = hasPrimaryIdentifier(actual, exp);
        const dedupOk = actual.dedup.confident_merges.length === exp.confident_merges
          && actual.dedup.uncertain_groups.length === exp.uncertain_groups;
        return {
          passed: JSON.stringify(hitProviders) === JSON.stringify(exp.provider_hit_providers) && identifierOk && dedupOk,
          metrics: {
            provider_recall: JSON.stringify(hitProviders) === JSON.stringify(exp.provider_hit_providers) ? 1 : 0,
            known_item_hit_rate: identifierOk ? 1 : 0,
            dedup_accuracy: dedupOk ? 1 : 0,
          },
        };
      },
      aggregate: results => {
        const avg = (name: string) => results.reduce((sum, result) => sum + (result.metrics[name] ?? 0), 0) / results.length;
        return {
          provider_recall_overall: avg('provider_recall'),
          known_item_hit_rate_overall: avg('known_item_hit_rate'),
          dedup_accuracy_overall: avg('dedup_accuracy'),
        };
      },
    });

    expect(report.summary.failed).toBe(0);
    expect(report.aggregateMetrics.provider_recall_overall ?? 0).toBeGreaterThanOrEqual(1);
    expect(report.aggregateMetrics.dedup_accuracy_overall ?? 0).toBeGreaterThanOrEqual(1);
  });
});
