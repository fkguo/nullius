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
    expect(grouping.topic_assignment_details['1'].provenance.mode).toBe('heuristic_fallback');
    const sharedTopicGroup = grouping.topic_groups.find(group => group.paper_ids.includes('1') && group.paper_ids.includes('2'));
    expect(sharedTopicGroup?.keywords).toBeDefined();
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
    expect(grouping.method_assignment_details['p9'].provenance.reason_code).toBe('combined_method_signals');
    const mixedMethodGroup = grouping.method_groups.find(group => group.paper_ids.includes('p9') && group.paper_ids.includes('p10'));
    expect(mixedMethodGroup?.keywords).toBeDefined();
    expect(mixedMethodGroup?.keywords).not.toContain('mixed_methods');
    expect(mixedMethodGroup?.keywords).not.toContain('heuristic_fallback');
  });
});
