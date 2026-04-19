import { describe, expect, it } from 'vitest';

import {
  CollectionSemanticGroupingSchema,
  MethodologyChallengeExtractionResultSchema,
  SemanticAssessmentProvenanceSchema,
} from '../index.js';

describe('SemanticAssessmentProvenanceSchema', () => {
  it('accepts semantic sampling provenance with optional audit fields', () => {
    const result = SemanticAssessmentProvenanceSchema.parse({
      backend: 'mcp_sampling',
      status: 'applied',
      authority: 'semantic_conclusion',
      reason_code: 'semantic_assessment',
      prompt_version: 'sem05_review_authority_v2',
      input_hash: 'abc123',
      model: 'test-model',
      signals: ['document_type'],
    });

    expect(result.backend).toBe('mcp_sampling');
    expect(result.signals).toEqual(['document_type']);
  });

  it('accepts unavailable diagnostic provenance', () => {
    const result = SemanticAssessmentProvenanceSchema.parse({
      backend: 'diagnostic',
      status: 'unavailable',
      authority: 'unavailable',
      reason_code: 'sampling_unavailable',
    });

    expect(result.status).toBe('unavailable');
    expect(result.authority).toBe('unavailable');
  });

  it('rejects empty reason codes', () => {
    expect(() =>
      SemanticAssessmentProvenanceSchema.parse({
        backend: 'metadata',
        status: 'diagnostic',
        authority: 'diagnostic_prior',
        reason_code: '',
      }),
    ).toThrow();
  });
});

describe('CollectionSemanticGroupingSchema', () => {
  it('accepts provider-neutral topic and method grouping output', () => {
    const result = CollectionSemanticGroupingSchema.parse({
      topic_groups: [{
        label: 'open_quantum_systems',
        keywords: ['lindblad', 'decoherence'],
        paper_ids: ['p1'],
        representative_papers: ['p1'],
        provenance: {
          mode: 'open_cluster',
          used_fallback: false,
          reason_code: 'shared_top_terms',
          confidence: 0.74,
          evidence: ['lindblad', 'decoherence'],
        },
      }],
      method_groups: [],
      topic_assignments: { p1: 'open_quantum_systems' },
      method_assignments: { p1: 'uncertain' },
      topic_assignment_details: {
        p1: {
          label: 'open_quantum_systems',
          provenance: {
            mode: 'open_cluster',
            used_fallback: false,
            reason_code: 'shared_top_terms',
            confidence: 0.74,
            evidence: ['lindblad', 'decoherence'],
          },
        },
      },
      method_assignment_details: {
        p1: {
          label: 'uncertain',
          provenance: {
            mode: 'uncertain',
            used_fallback: false,
            reason_code: 'no_semantic_signal',
            confidence: 0,
            evidence: [],
          },
        },
      },
      topic_fallback_rate: 0,
      method_fallback_rate: 1,
    });

    expect(result.topic_groups[0]?.label).toBe('open_quantum_systems');
    expect(result.method_assignment_details.p1.provenance.mode).toBe('uncertain');
  });
});

describe('MethodologyChallengeExtractionResultSchema', () => {
  it('accepts fail-closed challenge outputs without requiring heuristic fallback authority', () => {
    const result = MethodologyChallengeExtractionResultSchema.parse({
      status: 'uncertain',
      challenge_types: [],
      challenges: [],
      provenance: {
        mode: 'uncertain',
        used_fallback: false,
        reason_code: 'challenge_hints_without_open_evidence',
        evidence_count: 0,
      },
    });

    expect(result.challenge_types).toEqual([]);
    expect(result.provenance.mode).toBe('uncertain');
  });
});
