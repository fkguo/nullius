import { CollectionSemanticGroupingSchema } from '@autoresearch/shared';
import { describe, expect, it } from 'vitest';

import { groupCollectionSemantics } from '../../src/tools/research/synthesis/collectionSemanticGrouping.js';
import { normalizeGrouping } from './sem10EvalSupport.js';

describe('eval: SEM-10 topic/method grouping authority cleanup (local-proof-only)', () => {
  it('does not emit heuristic-fallback authority or public taxonomy labels for terminology-drift cases', () => {
    const grouping = CollectionSemanticGroupingSchema.parse(
      groupCollectionSemantics([
        { recid: 'p1', title: 'Heavy neutral lepton sensitivity with displaced vertices', abstract: 'We study sterile-neutrino discovery potential at the lifetime frontier.', keywords: ['lifetime frontier'], methodology: 'Detector-response emulation and pseudoexperiment template fits are used.', citation_count: 35 },
        { recid: 'p2', title: 'Sterile-neutrino reinterpretation in long-lived lepton searches', abstract: 'The heavy neutral lepton signal is modeled with response templates.', keywords: ['long-lived leptons'], methodology: 'Fast detector simulation and signal extraction templates are employed.', citation_count: 28 },
      ]),
    );
    const normalized = normalizeGrouping(grouping);

    expect(grouping.topic_fallback_rate).toBe(0);
    expect(grouping.method_fallback_rate).toBe(0);
    expect(grouping.topic_groups.every(group => group.provenance.mode !== 'heuristic_fallback')).toBe(true);
    expect(grouping.method_groups.every(group => group.provenance.mode !== 'heuristic_fallback')).toBe(true);
    expect(normalized.public_keyword_leak_rate).toBe(0);
    expect(normalized.public_label_leak_rate).toBe(0);
  });

  it('keeps cross-cutting and sparse-keyword cases in generic open-cluster or uncertain buckets only', () => {
    const grouping = CollectionSemanticGroupingSchema.parse(
      groupCollectionSemantics([
        { recid: 'p9', title: 'Lattice-informed EFT constraints for rare decays', abstract: 'Flavor anomalies are studied by combining lattice inputs with Wilson-coefficient fits.', keywords: ['rare decays'], methodology: 'Lattice matrix elements are combined with an EFT operator analysis.', citation_count: 19 },
        { recid: 'p10', title: 'Detector-level EFT reinterpretation of displaced signatures', abstract: 'Heavy neutral leptons are constrained with detector reinterpretation and operator fits.', keywords: ['long-lived leptons'], methodology: 'Detector simulation is coupled to an effective theory parameter scan.', citation_count: 17 },
        { recid: 'p11', title: 'Benchmark detector study for long-lived neutrinos', abstract: 'Heavy neutral leptons are searched for with displaced-vertex strategies.', keywords: ['lifetime frontier'], methodology: 'A dedicated detector simulation with template fits is used.', citation_count: 14 },
      ]),
    );

    const detailModes = [
      ...Object.values(grouping.topic_assignment_details).map(detail => detail.provenance.mode),
      ...Object.values(grouping.method_assignment_details).map(detail => detail.provenance.mode),
    ];

    expect(detailModes).not.toContain('heuristic_fallback');
    expect(detailModes.some(mode => mode === 'uncertain')).toBe(true);
  });
});
