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
      used_fallback: false,
      reason_code: 'semantic_assessment',
      prompt_version: 'sem05_review_authority_v2',
      input_hash: 'abc123',
      model: 'test-model',
      signals: ['document_type'],
    });

    expect(result.backend).toBe('mcp_sampling');
    expect(result.signals).toEqual(['document_type']);
  });

  it('accepts unavailable fallback provenance', () => {
    const result = SemanticAssessmentProvenanceSchema.parse({
      backend: 'diagnostic_fallback',
      status: 'unavailable',
      used_fallback: true,
      reason_code: 'sampling_unavailable',
    });

    expect(result.status).toBe('unavailable');
    expect(result.used_fallback).toBe(true);
  });

  it('rejects empty reason codes', () => {
    expect(() =>
      SemanticAssessmentProvenanceSchema.parse({
        backend: 'metadata',
        status: 'metadata',
        used_fallback: false,
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
            used_fallback: true,
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
  it('accepts challenge outputs without freezing provider-local taxonomy', () => {
    const result = MethodologyChallengeExtractionResultSchema.parse({
      status: 'detected',
      challenge_types: ['systematic_uncertainty', 'instrument_drift'],
      challenges: [{
        type: 'instrument_drift',
        summary: 'Calibration drift dominates the uncertainty budget.',
        confidence: 0.8,
        evidence: ['Calibration drift dominates the uncertainty budget.'],
        provenance: {
          mode: 'heuristic_fallback',
          used_fallback: true,
          reason_code: 'normalization_hint_match',
        },
      }],
      provenance: {
        mode: 'heuristic_fallback',
        used_fallback: true,
        reason_code: 'fallback_normalization_hints',
        evidence_count: 1,
      },
    });

    expect(result.challenge_types).toContain('instrument_drift');
    expect(result.challenges[0]?.provenance.mode).toBe('heuristic_fallback');
  });
});
