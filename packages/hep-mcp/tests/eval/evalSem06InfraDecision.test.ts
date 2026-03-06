import { describe, expect, it } from 'vitest';

import { buildRetrievalSubstrateSnapshot, EVIDENCE_RETRIEVAL_SUBSTRATE_DECISION_V1 } from '../../src/core/evidenceRetrievalSubstrate.js';
import { absoluteDelta, relativeGain } from '../../src/eval/index.js';

describe('eval: SEM-06-INFRA substrate decision', () => {
  it('locks the hashing baseline and blocks SEM-06b on NEW-DISC-01', () => {
    expect(EVIDENCE_RETRIEVAL_SUBSTRATE_DECISION_V1.baseline_locked).toBe('SEM-06a');
    expect(EVIDENCE_RETRIEVAL_SUBSTRATE_DECISION_V1.embedding.model_pattern).toBe('hashing_fnv1a32_dim*_v1');
    expect(EVIDENCE_RETRIEVAL_SUBSTRATE_DECISION_V1.dependencies.canonical_identity).toBe('NEW-DISC-01');
    expect(EVIDENCE_RETRIEVAL_SUBSTRATE_DECISION_V1.dependencies.must_finish_before_next_stage).toEqual(['NEW-DISC-01', 'NEW-SEM-06-INFRA']);
    expect(EVIDENCE_RETRIEVAL_SUBSTRATE_DECISION_V1.next_stage).toBe('NEW-SEM-06b');
  });

  it('builds a runtime snapshot for the current local sparse baseline', () => {
    const snapshot = buildRetrievalSubstrateSnapshot({
      active_model: 'hashing_fnv1a32_dim256_v1',
      embedding_dim: 256,
      semantic_implemented: true,
    });

    expect(snapshot.active_runtime.active_model).toBe('hashing_fnv1a32_dim256_v1');
    expect(snapshot.active_runtime.embedding_dim).toBe(256);
    expect(snapshot.index.late_interaction_path).toBe('planned_not_implemented');
    expect(snapshot.eval_protocol.comparison_method).toBe('absolute_delta_and_relative_gain');
  });

  it('uses the shared absolute-delta + relative-gain comparison protocol', () => {
    expect(absoluteDelta(0.85, 0.52)).toBeCloseTo(0.33, 6);
    expect(relativeGain(0.65, 0.5)).toBeCloseTo(0.3, 6);
  });
});
