import { describe, expect, it } from 'vitest';

import { groupByMethodology } from '../../src/tools/research/synthesis/grouping.js';

describe('groupByMethodology', () => {
  it('keeps public method groups generic while surfacing fallback evidence in descriptions', () => {
    const groups = groupByMethodology([
      {
        recid: '1',
        title: 'Lattice-informed EFT constraints',
        success: true,
        methodology: 'Lattice inputs are matched onto an effective field theory operator fit.',
        structure: { title: 'Lattice-informed EFT constraints', authors: [], abstract: 'Rare decays are analyzed through lattice and EFT inputs.', sections: [] },
      },
      {
        recid: '2',
        title: 'Detector reinterpretation of HNL signals',
        success: true,
        methodology: 'Detector simulation and template fits benchmark the search.',
        structure: { title: 'Detector reinterpretation of HNL signals', authors: [], abstract: 'Heavy neutral lepton sensitivity is evaluated with detector emulation.', sections: [] },
      },
    ], 5);

    expect(groups.every(group => /^Method cluster \d+$/.test(group.name))).toBe(true);
    expect(groups.some(group => group.description.includes('provider-local fallback signals'))).toBe(true);
    expect(groups.some(group => group.description.includes('Evidence terms:'))).toBe(true);
    expect(groups.some(group => group.description.includes('Mixed methods'))).toBe(false);
    expect(groups.some(group => group.description.includes('Experimental simulation'))).toBe(false);
  });
});
