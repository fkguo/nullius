export interface SemanticConcept {
  label: string;
  aliases: string[];
}

export const TOPIC_CONCEPTS: SemanticConcept[] = [
  { label: 'heavy_neutral_lepton', aliases: ['heavy neutral lepton', 'heavy neutral leptons', 'sterile neutrino', 'hnl', 'long lived neutrino', 'long lived lepton', 'long lived leptons', 'displaced vertex', 'lifetime frontier'] },
  { label: 'exotic_hadron_spectroscopy', aliases: ['exotic hadron', 'tetraquark', 'pentaquark', 'hadron spectroscopy', 'line shape', 'pole structure'] },
  { label: 'flavor_anomalies', aliases: ['flavor anomaly', 'flavor anomalies', 'semileptonic anomaly', 'rare b decay', 'rare b decays', 'rare decay', 'wilson coefficient', 'b anomaly'] },
  { label: 'hadronic_form_factors', aliases: ['hadronic form factor', 'hadronic form factors', 'form factor', 'matrix element', 'semileptonic matrix element', 'correlator', 'gauge field ensemble'] },
];

export const METHOD_CONCEPTS: SemanticConcept[] = [
  { label: 'experimental_simulation', aliases: ['detector simulation', 'response emulation', 'template fit', 'profile likelihood', 'event selection', 'pseudoexperiment', 'control region'] },
  { label: 'dispersive_amplitude', aliases: ['dispersion relation', 'dispersive', 'unitarity', 'amplitude analysis', 'partial wave', 'analytic continuation', 'bootstrap'] },
  { label: 'effective_field_theory', aliases: ['effective field theory', 'eft', 'smeft', 'operator basis', 'wilson coefficient', 'matching'] },
  { label: 'lattice_nonperturbative', aliases: ['lattice', 'gauge field ensemble', 'finite volume', 'nonperturbative', 'lattice qcd', 'correlator'] },
];

export const HUMANIZED_LABELS: Record<string, string> = {
  heavy_neutral_lepton: 'Heavy neutral lepton',
  exotic_hadron_spectroscopy: 'Exotic hadron spectroscopy',
  flavor_anomalies: 'Flavor anomalies',
  hadronic_form_factors: 'Hadronic form factors',
  experimental_simulation: 'Experimental simulation',
  dispersive_amplitude: 'Dispersive amplitude',
  effective_field_theory: 'Effective field theory',
  lattice_nonperturbative: 'Lattice nonperturbative',
  cross_cutting: 'Cross-cutting methods',
  uncertain: 'Uncertain',
};
