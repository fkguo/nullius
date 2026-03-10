import { CollectionSemanticGroupingSchema } from '@autoresearch/shared';
import { describe, expect, it } from 'vitest';

import { groupCollectionSemantics } from '../../src/tools/research/synthesis/collectionSemanticGrouping.js';

describe('groupCollectionSemantics', () => {
  it('marks terminology-bridging topic assignments as heuristic fallback instead of silent authority', () => {
    const grouping = groupCollectionSemantics([
      {
        recid: '1',
        title: 'HNL detector study',
        abstract: 'Heavy neutral lepton search with displaced vertices.',
        keywords: ['lifetime frontier'],
      },
      {
        recid: '2',
        title: 'Sterile-neutrino reinterpretation',
        abstract: 'Sterile neutrino sensitivity in long-lived lepton signatures.',
        keywords: ['long-lived leptons'],
      },
    ]);

    expect(() => CollectionSemanticGroupingSchema.parse(grouping)).not.toThrow();
    expect(grouping.topic_assignments['1']).toBe('heavy_neutral_lepton');
    expect(grouping.topic_assignment_details['1'].provenance.mode).toBe('heuristic_fallback');
    expect(grouping.topic_groups[0]?.keywords).toContain('heuristic_fallback');
  });

  it('keeps mixed methods explicit when multiple fallback families are combined', () => {
    const grouping = groupCollectionSemantics([
      {
        recid: 'p9',
        title: 'Lattice-informed EFT constraints',
        abstract: 'Flavor anomalies are studied by combining lattice inputs with Wilson-coefficient fits.',
        methodology: 'Lattice matrix elements are combined with an EFT operator analysis.',
      },
      {
        recid: 'p10',
        title: 'Detector-level EFT reinterpretation',
        abstract: 'Heavy neutral leptons are constrained with detector reinterpretation and operator fits.',
        methodology: 'Detector simulation is coupled to an effective theory parameter scan.',
      },
    ]);

    expect(() => CollectionSemanticGroupingSchema.parse(grouping)).not.toThrow();
    expect(grouping.method_assignments['p9']).toBe('mixed_methods');
    expect(grouping.method_assignment_details['p9'].provenance.reason_code).toBe('combined_method_signals');
    expect(grouping.method_groups[0]?.keywords).toContain('heuristic_fallback');
  });
});
