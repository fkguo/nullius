import { describe, it, expect } from 'vitest';

import { normalizeTextPreserveUnits } from '../../src/utils/textNormalization.js';

describe('normalizeTextPreserveUnits', () => {
  it('preserves case-sensitive energy units (meV vs MeV)', () => {
    expect(normalizeTextPreserveUnits('Energy 1 MeV')).toBe('energy 1 MeV');
    expect(normalizeTextPreserveUnits('Energy 1 meV')).toBe('energy 1 meV');
    expect(normalizeTextPreserveUnits('Energy 1 keV')).toBe('energy 1 keV');
    expect(normalizeTextPreserveUnits('Energy 1 GeV')).toBe('energy 1 GeV');
    expect(normalizeTextPreserveUnits('Energy 1 TeV')).toBe('energy 1 TeV');
    expect(normalizeTextPreserveUnits('Energy 1 eV')).toBe('energy 1 eV');
  });

  it('handles units adjacent to digits and punctuation', () => {
    expect(normalizeTextPreserveUnits('125MeV')).toBe('125MeV');
    expect(normalizeTextPreserveUnits('13TeV-scale')).toBe('13TeV-scale');
    expect(normalizeTextPreserveUnits('m=0.511MeV')).toBe('m=0.511MeV');
  });

  it('preserves composite units with c, c², and c^2', () => {
    expect(normalizeTextPreserveUnits('p = 1 GeV/c')).toBe('p = 1 GeV/c');
    expect(normalizeTextPreserveUnits('m = 0.511 MeV/c^2')).toBe('m = 0.511 MeV/c^2');
    expect(normalizeTextPreserveUnits('m = 0.511 MeV/c²')).toBe('m = 0.511 MeV/c²');
    expect(normalizeTextPreserveUnits('m = 0.1 meV/c²')).toBe('m = 0.1 meV/c²');
  });

  it('avoids matching inside longer words', () => {
    expect(normalizeTextPreserveUnits('SomeMeVLikeToken')).toBe('somemevliketoken');
  });
});

