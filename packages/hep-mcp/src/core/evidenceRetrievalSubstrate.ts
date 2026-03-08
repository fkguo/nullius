export type RetrievalMetricName =
  | 'precision_at_5'
  | 'precision_at_10'
  | 'recall_at_5'
  | 'recall_at_10'
  | 'mrr_at_10'
  | 'fallback_rate'
  | 'latency_p50_ms'
  | 'latency_p95_ms'
  | 'noise_gold_hit_rate_at_10';

export type RetrievalSubstrateDecisionV1 = {
  version: 1;
  decision_id: 'new_sem_06_infra_v1';
  stage: 'NEW-SEM-06-INFRA';
  baseline_locked: 'SEM-06a';
  next_stage: 'NEW-SEM-06b';
  embedding: {
    mode: 'local_sparse_hashing';
    model_pattern: 'hashing_fnv1a32_dim*_v1';
    hosted_boundary: 'defer_until_sem06b_or_later';
  };
  index: {
    store: 'run_artifact_jsonl';
    vector_store: 'artifact_jsonl';
    late_interaction_path: 'planned_not_implemented';
    strong_reranker_path: 'canonical_paper_llm_listwise_v1';
  };
  dependencies: {
    canonical_identity: 'NEW-DISC-01';
    must_finish_before_next_stage: ['NEW-DISC-01', 'NEW-SEM-06-INFRA'];
  };
  eval_protocol: {
    comparison_method: 'absolute_delta_and_relative_gain';
    primary_metrics: RetrievalMetricName[];
    regression_metrics: RetrievalMetricName[];
    notes: string[];
  };
};

export const EVIDENCE_RETRIEVAL_SUBSTRATE_DECISION_V1: RetrievalSubstrateDecisionV1 = {
  version: 1,
  decision_id: 'new_sem_06_infra_v1',
  stage: 'NEW-SEM-06-INFRA',
  baseline_locked: 'SEM-06a',
  next_stage: 'NEW-SEM-06b',
  embedding: {
    mode: 'local_sparse_hashing',
    model_pattern: 'hashing_fnv1a32_dim*_v1',
    hosted_boundary: 'defer_until_sem06b_or_later',
  },
  index: {
    store: 'run_artifact_jsonl',
    vector_store: 'artifact_jsonl',
    late_interaction_path: 'planned_not_implemented',
    strong_reranker_path: 'canonical_paper_llm_listwise_v1',
  },
  dependencies: {
    canonical_identity: 'NEW-DISC-01',
    must_finish_before_next_stage: ['NEW-DISC-01', 'NEW-SEM-06-INFRA'],
  },
  eval_protocol: {
    comparison_method: 'absolute_delta_and_relative_gain',
    primary_metrics: ['recall_at_10', 'mrr_at_10', 'fallback_rate', 'latency_p95_ms'],
    regression_metrics: ['precision_at_5', 'precision_at_10', 'recall_at_5', 'noise_gold_hit_rate_at_10', 'latency_p50_ms'],
    notes: [
      'Keep hashing_fnv1a32_dim*_v1 as the locked baseline until NEW-SEM-06b lands.',
      'Do not hard-fork provider-local identities before NEW-DISC-01 closeout.',
      'Late-interaction remains deferred, while the canonical-paper strong reranker lands in NEW-SEM-06b.',
    ],
  },
};

export function buildRetrievalSubstrateSnapshot(params: {
  active_model: string;
  embedding_dim: number;
  semantic_implemented: boolean;
}) {
  return {
    ...EVIDENCE_RETRIEVAL_SUBSTRATE_DECISION_V1,
    active_runtime: {
      semantic_implemented: params.semantic_implemented,
      active_model: params.active_model,
      embedding_dim: params.embedding_dim,
    },
  };
}
