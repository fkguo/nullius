import { CollectionSemanticGroupingSchema } from '@autoresearch/shared';
import { describe, expect, it } from 'vitest';

import { groupCollectionSemantics } from '../../src/tools/research/synthesis/collectionSemanticGrouping.js';

describe('groupCollectionSemantics', () => {
  it('does not promote terminology bridges into heuristic topic authority', () => {
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
    expect(grouping.topic_fallback_rate).toBe(0);
    expect(grouping.topic_assignment_details['1'].provenance.mode).not.toBe('heuristic_fallback');
    expect(grouping.topic_assignment_details['2'].provenance.mode).not.toBe('heuristic_fallback');
    expect(grouping.topic_assignments['1']).not.toBe('heavy_neutral_lepton');
    expect(grouping.topic_assignments['2']).not.toBe('heavy_neutral_lepton');
  });

  it('does not convert mixed-method hinting into authoritative method clusters', () => {
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
    expect(grouping.method_fallback_rate).toBe(0);
    expect(grouping.method_assignment_details['p9'].provenance.mode).not.toBe('heuristic_fallback');
    expect(grouping.method_assignment_details['p10'].provenance.mode).not.toBe('heuristic_fallback');
    expect(grouping.method_assignments['p9']).not.toBe('mixed_methods');
    expect(grouping.method_assignments['p10']).not.toBe('mixed_methods');
  });

  it('keeps bridge papers in non-authoritative generic buckets when shared evidence is too weak', () => {
    const grouping = groupCollectionSemantics([
      {
        recid: 'h4',
        title: 'Global SMEFT fits to flavor anomalies',
        abstract: 'Rare B-decay anomalies are interpreted in an operator language.',
        methodology: 'A global effective theory fit is used.',
      },
      {
        recid: 'h5',
        title: 'Lattice form factors for rare semileptonic decays',
        abstract: 'Hadronic form factors are computed nonperturbatively.',
        methodology: 'A lattice Monte Carlo calculation is presented.',
      },
      {
        recid: 'h6',
        title: 'Lattice-assisted effective-theory constraints',
        abstract: 'Rare-decay form factors feed into operator analyses.',
        methodology: 'Lattice inputs are matched onto an effective theory fit.',
      },
    ]);

    expect(grouping.topic_groups.every(group => group.provenance.mode !== 'heuristic_fallback')).toBe(true);
    expect(grouping.method_groups.every(group => group.provenance.mode !== 'heuristic_fallback')).toBe(true);
    expect(grouping.method_assignment_details['h6'].provenance.mode).toBe('uncertain');
    expect(grouping.method_assignment_details['h6'].provenance.used_fallback).toBe(false);
  });
});
