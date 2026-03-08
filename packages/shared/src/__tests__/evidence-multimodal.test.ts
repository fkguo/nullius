import { describe, expect, it } from 'vitest';

import { EvidenceMultimodalArtifactSchema } from '../index.js';

describe('evidence multimodal artifact', () => {
  it('parses applied page-native fusion telemetry', () => {
    const artifact = EvidenceMultimodalArtifactSchema.parse({
      version: 1,
      status: 'applied',
      requested_unit: 'figure',
      reason_codes: ['visual_signal_applied'],
      promoted_evidence_ids: ['ev_pdf_region_1'],
      telemetry: {
        fusion_passes: 1,
        visual_candidates_scanned: 6,
        supplemented_candidates: 2,
        boosted_hits: 1,
        latency_ms: 4,
      },
    });

    expect(artifact.status).toBe('applied');
    expect(artifact.requested_unit).toBe('figure');
    expect(artifact.promoted_evidence_ids).toEqual(['ev_pdf_region_1']);
  });

  it('parses unsupported and disabled multimodal states', () => {
    const unsupported = EvidenceMultimodalArtifactSchema.parse({
      version: 1,
      status: 'unsupported',
      reason_codes: ['pdf_visual_surface_missing'],
      telemetry: {
        fusion_passes: 0,
        visual_candidates_scanned: 0,
        supplemented_candidates: 0,
        boosted_hits: 0,
        latency_ms: 0,
      },
    });
    const disabled = EvidenceMultimodalArtifactSchema.parse({
      version: 1,
      status: 'disabled',
      reason_codes: ['policy_disabled'],
      telemetry: {
        fusion_passes: 0,
        visual_candidates_scanned: 0,
        supplemented_candidates: 0,
        boosted_hits: 0,
        latency_ms: 0,
      },
    });

    expect(unsupported.reason_codes).toContain('pdf_visual_surface_missing');
    expect(disabled.reason_codes).toContain('policy_disabled');
  });
});
