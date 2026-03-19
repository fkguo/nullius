import { CollectionSemanticGroupingSchema } from '@autoresearch/shared';
import { describe, expect, it } from 'vitest';

import { groupCollectionSemantics } from '../../src/tools/research/synthesis/collectionSemanticGrouping.js';

describe('groupCollectionSemantics', () => {
  it('keeps terminology-bridging fallback as diagnostic while public keywords stay evidence-first', () => {
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
    expect(grouping.topic_assignments['1']).toBe(grouping.topic_assignments['2']);
    expect(grouping.topic_assignments['1']).toMatch(/^fallback_cluster_\d+$/);
    expect(grouping.topic_assignment_details['1'].provenance.mode).toBe('heuristic_fallback');
    expect(grouping.topic_assignment_details['1'].provenance.canonical_hint).toBe('heavy_neutral_lepton');
    expect(grouping.topic_assignment_details['1'].label).toBe(grouping.topic_assignments['1']);
    const sharedTopicGroup = grouping.topic_groups.find(group => group.paper_ids.includes('1') && group.paper_ids.includes('2'));
    expect(sharedTopicGroup?.label).toMatch(/^fallback_cluster_\d+$/);
    expect(sharedTopicGroup?.keywords).toBeDefined();
    expect(sharedTopicGroup?.label).not.toBe('heavy_neutral_lepton');
    expect(sharedTopicGroup?.keywords).not.toContain('heavy_neutral_lepton');
    expect(sharedTopicGroup?.keywords).not.toContain('heuristic_fallback');
  });

  it('keeps mixed-method fallback as diagnostic while public method keywords stay evidence-first', () => {
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
    expect(grouping.method_assignments['p9']).toBe(grouping.method_assignments['p10']);
    expect(grouping.method_assignments['p9']).toMatch(/^fallback_cluster_\d+$/);
    expect(grouping.method_assignment_details['p9'].provenance.reason_code).toBe('combined_method_signals');
    expect(grouping.method_assignment_details['p9'].provenance.canonical_hint).toBe('mixed_methods');
    expect(grouping.method_assignment_details['p9'].label).toBe(grouping.method_assignments['p9']);
    const mixedMethodGroup = grouping.method_groups.find(group => group.paper_ids.includes('p9') && group.paper_ids.includes('p10'));
    expect(mixedMethodGroup?.label).toMatch(/^fallback_cluster_\d+$/);
    expect(mixedMethodGroup?.keywords).toBeDefined();
    expect(mixedMethodGroup?.label).not.toBe('mixed_methods');
    expect(mixedMethodGroup?.keywords).not.toContain('mixed_methods');
    expect(mixedMethodGroup?.keywords).not.toContain('heuristic_fallback');
  });

  it('keeps cross-topic and mixed-method membership aligned for the SEM-10 holdout bridge paper', () => {
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

    expect(grouping.topic_assignments['h4']).toBe(grouping.topic_assignments['h6']);
    expect(grouping.topic_assignments['h4']).not.toBe(grouping.topic_assignments['h5']);
    expect(grouping.method_assignments['h4']).not.toBe(grouping.method_assignments['h6']);
    expect(grouping.method_assignments['h5']).not.toBe(grouping.method_assignments['h6']);
    expect(grouping.method_assignment_details['h6'].provenance.canonical_hint).toBe('mixed_methods');
    expect(grouping.method_assignment_details['h6'].provenance.reason_code).toBe('combined_method_signals');
  });
});
