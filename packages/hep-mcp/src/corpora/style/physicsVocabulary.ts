/**
 * Physics Concept Vocabulary for HEP Literature
 * 
 * This module provides comprehensive vocabularies for recognizing physics concepts
 * in high energy physics and related fields.
 * 
 * Coverage: hep-ph, hep-ex, hep-lat, nucl-th, nucl-ex, hep-th
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Type Definitions
// ═══════════════════════════════════════════════════════════════════════════════

export interface PhysicsContext {
  /** Identified particles */
  particles?: string[];
  /** Identified resonances/exotic states */
  resonances?: string[];
  /** Identified symmetries */
  symmetries?: string[];
  /** Identified quantum numbers */
  quantum_numbers?: string[];
  /** Identified interactions/processes */
  interactions?: string[];
  processes?: string[];
  /** Identified methods/techniques */
  methods?: string[];
  /** Identified experiments/facilities */
  experiments?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2.1 Particles & Resonances
// ═══════════════════════════════════════════════════════════════════════════════

/** Basic Particles - Quarks */
export const QUARKS = [
  'up', 'down', 'strange', 'charm', 'bottom', 'top',
  'light quark', 'heavy quark', 'valence quark', 'sea quark',
  'constituent quark', 'current quark', 'quark', 'antiquark',
  'u quark', 'd quark', 's quark', 'c quark', 'b quark', 't quark',
];

/** Basic Particles - Leptons */
export const LEPTONS = [
  'electron', 'muon', 'tau', 'neutrino', 'lepton', 'charged lepton', 'neutral lepton',
  'electron neutrino', 'muon neutrino', 'tau neutrino',
  'νe', 'νμ', 'ντ', 'e-', 'e+', 'μ-', 'μ+', 'τ-', 'τ+',
  'positron', 'antimuon', 'antitau',
];

/** Basic Particles - Gauge Bosons */
export const GAUGE_BOSONS = [
  'photon', 'gluon', 'W boson', 'Z boson', 'weak boson', 'electroweak',
  'W+', 'W-', 'Z0', 'γ', 'gauge boson',
];

/** Basic Particles - Scalars */
export const SCALARS = [
  'Higgs', 'Higgs boson', 'scalar', 'pseudoscalar', 'dilaton',
  'scalar meson', 'pseudoscalar meson',
];

/** Light Mesons */
export const LIGHT_MESONS = [
  'pion', 'kaon', 'eta', "eta'", 'eta prime', 'rho', 'omega', 'phi',
  'a0', 'a1', 'a2', 'b1', 'f0', 'f1', 'f2', 'K*', 'K1', 'K2',
  'π', 'π+', 'π-', 'π0', 'K+', 'K-', 'K0', "K0bar", 'η', "η'",
  'ρ', 'ω', 'φ', 'f0(500)', 'f0(980)', 'f0(1370)', 'f0(1500)', 'f0(1710)',
  'a0(980)', 'a0(1450)', 'f2(1270)', "f2'(1525)", 'a2(1320)',
  'sigma', 'σ', 'kappa', 'κ',
];

/** Charm Mesons */
export const CHARM_MESONS = [
  'D meson', 'D*', 'Ds', 'Ds*', 'D0', 'D+', 'D-', 'D0bar',
  'etac', 'ηc', 'Jpsi', 'J/ψ', 'psi(2S)', 'ψ(2S)', 'chi_c', 'χc', 'h_c', 'hc',
  'psi(3770)', 'psi(4040)', 'psi(4160)', 'psi(4415)',
  'Y(4260)', 'Y(4360)', 'Y(4660)', 'ψ(3770)', 'ψ(4040)', 'ψ(4160)', 'ψ(4415)',
  'charmonium', 'charmonium-like', 'cc̄',
];

/** Bottom Mesons */
export const BOTTOM_MESONS = [
  'B meson', 'B*', 'Bs', 'Bc', 'B0', 'B+', 'B-', 'B0bar', 'Bs0',
  'Upsilon', 'Υ', 'chi_b', 'χb', 'h_b', 'hb', 'eta_b', 'ηb',
  'Υ(1S)', 'Υ(2S)', 'Υ(3S)', 'Υ(4S)', 'Υ(10860)', 'Υ(11020)',
  'Upsilon(1S)', 'Upsilon(2S)', 'Upsilon(3S)', 'Upsilon(4S)',
  'bottomonium', 'bottomonium-like', 'bb̄',
];

/** Exotic Mesons (XYZ states) */
export const EXOTIC_MESONS = [
  'X(3872)', 'X(3915)', 'X(3940)', 'X(4140)', 'X(4274)', 'X(4350)',
  'X(4500)', 'X(4700)', 'X(6900)', 'X(6600)',
  'Zc(3900)', 'Zc(4020)', 'Zc(4050)', 'Zc(4200)', 'Zc(4430)',
  'Zb(10610)', 'Zb(10650)', 'Zcs(3985)', 'Zcs(4000)', 'Zcs(4220)',
  'Y(4260)', 'Y(4360)', 'Y(4390)', 'Y(4660)',
  'XYZ states', 'XYZ',
];

/** Light Baryons */
export const LIGHT_BARYONS = [
  'nucleon', 'proton', 'neutron', 'Delta', 'Δ', 'N*', 'Δ*',
  'Lambda', 'Λ', 'Sigma', 'Σ', 'Xi', 'Ξ', 'Omega', 'Ω', 'hyperon',
  'Λ(1405)', 'Λ(1520)', 'Λ(1670)', 'Σ(1385)', 'Σ(1670)',
  'Ξ(1530)', 'Ω-', 'p', 'n',
];

/** Charm Baryons */
export const CHARM_BARYONS = [
  'Lambda_c', 'Λc', 'Sigma_c', 'Σc', 'Xi_c', 'Ξc', 'Omega_c', 'Ωc',
  'Xi_cc', 'Ξcc', 'Omega_cc', 'Ωcc', 'Ωccc',
  'charmed baryon', 'doubly charmed baryon', 'triply charmed baryon',
  'Λc(2595)', 'Λc(2625)', 'Σc(2455)', 'Σc(2520)',
  'Ξc(2790)', 'Ξc(2815)', 'Ωc(2770)',
];

/** Bottom Baryons */
export const BOTTOM_BARYONS = [
  'Lambda_b', 'Λb', 'Sigma_b', 'Σb', 'Xi_b', 'Ξb', 'Omega_b', 'Ωb',
  'Xi_bb', 'Ξbb', 'Omega_bb', 'Ωbb',
  'bottom baryon', 'doubly bottom baryon',
];

/** Pentaquarks */
export const PENTAQUARKS = [
  'Pc(4312)', 'Pc(4380)', 'Pc(4440)', 'Pc(4457)',
  'Pcs(4338)', 'Pcs(4459)',
  'pentaquark', 'hidden-charm pentaquark', 'hidden-strange pentaquark',
  'Pψs', 'PψΛ',
];

/** Tetraquarks */
export const TETRAQUARKS = [
  'tetraquark', 'Tcc(3875)', 'Tcs', 'Tbb',
  'full-charm tetraquark', 'fully charmed tetraquark',
  'doubly charmed tetraquark', 'compact tetraquark', 'molecular tetraquark',
  'Tcc', 'X(6900)',
];

/** Other Exotic States */
export const OTHER_EXOTICS = [
  'hexaquark', 'dibaryon', 'hybrid', 'hybrid meson', 'hybrid charmonium',
  'hybrid bottomonium', 'glueball', 'scalar glueball', 'tensor glueball',
  'pseudoscalar glueball', 'gluonic excitation', 'multiquark',
  'hadronic molecule', 'molecular state', 'deuteron-like', 'loosely bound',
  'threshold state', 'virtual state', 'cusp', 'flux tube', 'constituent gluon',
];

/** All particles combined */
export const ALL_PARTICLES = [
  ...QUARKS, ...LEPTONS, ...GAUGE_BOSONS, ...SCALARS,
  ...LIGHT_MESONS, ...CHARM_MESONS, ...BOTTOM_MESONS, ...EXOTIC_MESONS,
  ...LIGHT_BARYONS, ...CHARM_BARYONS, ...BOTTOM_BARYONS,
  ...PENTAQUARKS, ...TETRAQUARKS, ...OTHER_EXOTICS,
];

// ═══════════════════════════════════════════════════════════════════════════════
// 2.2 Symmetries & Quantum Numbers
// ═══════════════════════════════════════════════════════════════════════════════

/** Continuous Symmetries */
export const CONTINUOUS_SYMMETRIES = [
  'chiral symmetry', 'gauge symmetry', 'Lorentz symmetry', 'Poincaré symmetry',
  'Poincare symmetry', 'conformal symmetry', 'scale invariance', 'dilatation',
  'local symmetry', 'global symmetry', 'internal symmetry', 'spacetime symmetry',
];

/** Discrete Symmetries */
export const DISCRETE_SYMMETRIES = [
  'parity', 'charge conjugation', 'time reversal', 'CP', 'CPT',
  'G-parity', 'C-parity', 'P symmetry', 'T symmetry', 'CP symmetry',
  'parity violation', 'CP violation', 'T violation',
];

/** Flavor Symmetries */
export const FLAVOR_SYMMETRIES = [
  'SU(2) isospin', 'SU(3) flavor', 'SU(4) flavor', 'U(1) axial', 'U(1) baryon',
  'U(1) lepton', 'flavor symmetry breaking', 'isospin breaking', 'SU(3) breaking',
  'isospin symmetry', 'flavor SU(2)', 'flavor SU(3)', 'flavor SU(4)',
];

/** Heavy Quark Symmetries */
export const HEAVY_QUARK_SYMMETRIES = [
  'heavy quark symmetry', 'heavy quark spin symmetry', 'heavy quark flavor symmetry',
  'HQS', 'HQSS', '1/m_Q expansion', '1/mQ expansion', 'heavy quark limit',
];

/** Other Symmetries */
export const OTHER_SYMMETRIES = [
  'crossing symmetry', 'duality', 'Regge trajectory', 'chiral anomaly',
  'axial anomaly', 'trace anomaly', 'conformal anomaly',
  'supersymmetry', 'SUSY', 'R-symmetry',
];

/** All symmetries combined */
export const ALL_SYMMETRIES = [
  ...CONTINUOUS_SYMMETRIES, ...DISCRETE_SYMMETRIES, ...FLAVOR_SYMMETRIES,
  ...HEAVY_QUARK_SYMMETRIES, ...OTHER_SYMMETRIES,
];

/** Basic Quantum Numbers */
export const BASIC_QUANTUM_NUMBERS = [
  'spin', 'parity', 'charge', 'baryon number', 'lepton number',
  'isospin', 'strangeness', 'charm', 'bottom', 'top', 'flavor',
];

/** Combined Quantum Numbers */
export const COMBINED_QUANTUM_NUMBERS = [
  'J^PC', 'J^P', 'I^G', 'hypercharge', 'electric charge', 'color charge',
  'I=0', 'I=1', 'I=1/2', 'I=3/2',
];

/** Partial Wave Labels */
export const PARTIAL_WAVE_LABELS = [
  'S-wave', 'P-wave', 'D-wave', 'F-wave', 'G-wave',
  'partial wave', 'angular momentum', 'orbital angular momentum',
  'total angular momentum', 'L=0', 'L=1', 'L=2',
];

/** All quantum numbers combined */
export const ALL_QUANTUM_NUMBERS = [
  ...BASIC_QUANTUM_NUMBERS, ...COMBINED_QUANTUM_NUMBERS, ...PARTIAL_WAVE_LABELS,
];

// ═══════════════════════════════════════════════════════════════════════════════
// 2.3 Interactions & Processes
// ═══════════════════════════════════════════════════════════════════════════════

/** Strong Interactions */
export const STRONG_INTERACTIONS = [
  'strong interaction', 'QCD', 'color force', 'gluon exchange', 'quark-gluon',
  'asymptotic freedom', 'confinement', 'running coupling', 'αs',
];

/** Electroweak Interactions */
export const ELECTROWEAK_INTERACTIONS = [
  'weak interaction', 'electromagnetic', 'electroweak', 'charged current',
  'neutral current', 'W exchange', 'Z exchange', 'photon exchange',
  'electromagnetic interaction', 'weak decay',
];

/** Gravitational */
export const GRAVITATIONAL = [
  'gravitational', 'graviton', 'gravitational wave', 'gravity',
];

/** Elastic Scattering */
export const ELASTIC_SCATTERING = [
  'elastic scattering', 'Compton scattering', 'Coulomb scattering',
  'Mott scattering', 'Rutherford scattering',
];

/** Inelastic Scattering */
export const INELASTIC_SCATTERING = [
  'inelastic scattering', 'deep inelastic scattering', 'DIS',
  'semi-inclusive DIS', 'SIDIS', 'exclusive process',
];

/** Hadron Scattering */
export const HADRON_SCATTERING = [
  'pion-nucleon', 'kaon-nucleon', 'nucleon-nucleon', 'meson-baryon',
  'baryon-baryon', 'hyperon-nucleon', 'NN scattering', 'πN scattering',
  'KN scattering', 'ππ scattering', 'πK scattering',
];

/** Lepton Scattering */
export const LEPTON_SCATTERING = [
  'electron-proton', 'muon-proton', 'neutrino scattering', 'lepton-nucleon',
  'ep scattering', 'μp scattering', 'eN scattering',
];

/** Production Processes */
export const PRODUCTION_PROCESSES = [
  'pair production', 'associated production', 'photoproduction',
  'electroproduction', 'hadroproduction', 'exclusive production',
  'inclusive production', 'diffractive production',
];

/** Decay Processes */
export const DECAY_PROCESSES = [
  'leptonic decay', 'semileptonic decay', 'hadronic decay', 'radiative decay',
  'rare decay', 'invisible decay', 'weak decay', 'strong decay',
  'electromagnetic decay', 'two-body decay', 'three-body decay',
];

/** Special Processes */
export const SPECIAL_PROCESSES = [
  'annihilation', 'fragmentation', 'hadronization', 'recombination',
  'coalescence', 'fusion', 'fission',
];

/** Collision Types */
export const COLLISION_TYPES = [
  'electron-positron', 'proton-proton', 'proton-antiproton',
  'heavy-ion collision', 'nucleus-nucleus', 'proton-nucleus',
  'peripheral collision', 'central collision', 'ultraperipheral collision',
  'UPC', 'photon-photon', 'photon-nucleus', 'coherent production',
  'incoherent production', 'e+e-', 'pp', 'pp̄', 'AA', 'pA',
];

/** All interactions combined */
export const ALL_INTERACTIONS = [
  ...STRONG_INTERACTIONS, ...ELECTROWEAK_INTERACTIONS, ...GRAVITATIONAL,
];

/** All processes combined */
export const ALL_PROCESSES = [
  ...ELASTIC_SCATTERING, ...INELASTIC_SCATTERING, ...HADRON_SCATTERING,
  ...LEPTON_SCATTERING, ...PRODUCTION_PROCESSES, ...DECAY_PROCESSES,
  ...SPECIAL_PROCESSES, ...COLLISION_TYPES,
];

// ═══════════════════════════════════════════════════════════════════════════════
// 2.4 Methods & Techniques
// ═══════════════════════════════════════════════════════════════════════════════

/** QCD Methods */
export const QCD_METHODS = [
  'perturbative QCD', 'pQCD', 'non-perturbative QCD', 'soft QCD', 'hard QCD',
  'collinear factorization', 'kT factorization', 'k_T factorization', 'CGC',
  'color glass condensate',
];

/** Effective Theories */
export const EFFECTIVE_THEORIES = [
  'effective field theory', 'EFT', 'chiral perturbation theory', 'ChPT',
  'heavy quark effective theory', 'HQET', 'NRQCD', 'pNRQCD', 'vNRQCD',
  'SCET', 'soft-collinear effective theory', 'XEFT', 'pionless EFT',
  'pionful EFT', 'nuclear EFT', 'LaMET', 'large momentum effective theory',
];

/** Other Frameworks */
export const OTHER_FRAMEWORKS = [
  'Regge theory', 'Veneziano amplitude', 'dual resonance model',
  'string theory', 'holographic QCD', 'AdS/CFT', 'gauge/gravity duality',
];

/** Perturbative Methods */
export const PERTURBATIVE_METHODS = [
  'perturbation theory', 'loop expansion', 'NLO', 'NNLO', 'N3LO', 'N4LO',
  'leading order', 'LO', 'next-to-leading order', 'fixed-order', 'all-order',
  'Feynman diagram', 'loop integral',
];

/** Non-Perturbative Methods */
export const NON_PERTURBATIVE_METHODS = [
  'lattice QCD', 'LQCD', 'Monte Carlo', 'Dyson-Schwinger', 'Bethe-Salpeter',
  'functional renormalization group', 'FRG', 'quark model', 'bag model',
  'potential model', 'Skyrme model',
];

/** Resummation Methods */
export const RESUMMATION_METHODS = [
  'resummation', 'threshold resummation', 'transverse momentum resummation',
  'Sudakov resummation', 'BFKL', 'DGLAP', 'ERBL', 'CSS formalism',
  'TMD evolution', 'small-x resummation', 'soft gluon resummation',
];

/** Sum Rules */
export const SUM_RULES = [
  'QCD sum rules', 'SVZ sum rules', 'light-cone sum rules', 'LCSR',
  'finite energy sum rules', 'FESR', 'Borel sum rules', 'moment sum rules',
];

/** Dispersion Methods */
export const DISPERSION_METHODS = [
  'dispersion relation', 'subtracted dispersion relation',
  'unsubtracted dispersion relation', 'Omnès function', 'Muskhelishvili-Omnès',
  'Roy equation', 'Roy-Steiner equation', 'GKPY equation',
];

/** Unitarity Methods */
export const UNITARITY_METHODS = [
  'unitarity', 'partial-wave unitarity', 'elastic unitarity',
  'two-body unitarity', 'three-body unitarity', 'optical theorem',
  'Cutkosky rules', 'unitarized amplitude',
];

/** Analytic Methods */
export const ANALYTIC_METHODS = [
  'analytic continuation', 'Riemann sheet', 'complex plane', 'pole position',
  'residue', 'branch cut', 'threshold branch point', 'anomalous threshold',
];

/** Amplitude Analysis Methods */
export const AMPLITUDE_METHODS = [
  'partial wave analysis', 'PWA', 'amplitude analysis', 'Dalitz plot',
  'isobar model', 'K-matrix', 'P-vector', 'T-matrix', 'S-matrix',
  'coupled-channel analysis', 'Dalitz plot analysis',
];

/** Lattice Methods */
export const LATTICE_METHODS = [
  'lattice QCD', 'Wilson fermion', 'staggered fermion', 'twisted mass fermion',
  'domain wall fermion', 'overlap fermion', 'HISQ action', 'clover action',
  'Lüscher method', 'Luscher method', 'HAL QCD method', 'potential method',
  'finite volume', 'moving frame', 'distillation', 'variational method', 'GEVP',
  'quenched approximation', 'dynamical fermion', 'physical pion mass',
  'chiral extrapolation', 'continuum limit', 'thermodynamic limit',
];

/** Experimental Methods */
export const EXPERIMENTAL_METHODS = [
  'tracking', 'calorimetry', 'particle identification', 'PID',
  'vertex reconstruction', 'jet reconstruction', 'missing energy',
  'missing momentum', 'invariant mass', 'Dalitz analysis', 'amplitude fit',
  'moment analysis', 'angular analysis', 'helicity formalism', 'partial wave fit',
  'maximum likelihood', 'chi-square fit', 'Bayesian', 'frequentist',
  'confidence interval', 'significance', 'p-value', 'look-elsewhere effect',
];

/** All methods combined */
export const ALL_METHODS = [
  ...QCD_METHODS, ...EFFECTIVE_THEORIES, ...OTHER_FRAMEWORKS,
  ...PERTURBATIVE_METHODS, ...NON_PERTURBATIVE_METHODS, ...RESUMMATION_METHODS,
  ...SUM_RULES, ...DISPERSION_METHODS, ...UNITARITY_METHODS,
  ...ANALYTIC_METHODS, ...AMPLITUDE_METHODS, ...LATTICE_METHODS,
  ...EXPERIMENTAL_METHODS,
];

// ═══════════════════════════════════════════════════════════════════════════════
// 2.5-2.7 Domain-Specific Vocabularies
// ═══════════════════════════════════════════════════════════════════════════════

/** Nucleon Structure */
export const NUCLEON_STRUCTURE_VOCAB = [
  // Form Factors
  'electromagnetic form factor', 'Dirac form factor', 'Pauli form factor',
  'Sachs form factor', 'electric form factor', 'magnetic form factor',
  'charge radius', 'magnetic radius', 'Zemach radius',
  'gravitational form factor', 'GFF', 'D-term', 'A-form factor', 'J-form factor',
  'mass radius', 'mechanical radius', 'pressure distribution', 'shear force',
  'axial form factor', 'induced pseudoscalar form factor', 'axial radius',
  'axial coupling', 'g_A', 'gA',
  'scalar form factor', 'sigma term', 'pion-nucleon sigma term',
  'strangeness content',
  // Parton Physics
  'parton distribution function', 'PDF', 'unpolarized PDF', 'polarized PDF',
  'helicity PDF', 'transversity', 'gluon PDF', 'sea quark PDF', 'valence PDF',
  'generalized parton distribution', 'GPD', 'Compton form factor', 'CFF',
  'skewness', 'DVCS', 'TCS', 'HEMP',
  'transverse momentum dependent', 'TMD', 'TMD PDF', 'TMD FF',
  'Sivers function', 'Boer-Mulders function', 'Collins function',
  'worm-gear function', 'pretzelosity',
  'fragmentation function', 'FF', 'collinear FF', 'TMD FF', 'dihadron FF',
  'jet function', 'distribution amplitude', 'DA', 'light-cone distribution amplitude',
  'LCDA', 'twist-2', 'twist-3', 'twist-4',
  // Spin Physics
  'spin structure', 'spin sum rule', 'Bjorken sum rule', 'Ellis-Jaffe sum rule',
  'spin crisis', 'proton spin puzzle', 'spin asymmetry', 'single spin asymmetry',
  'SSA', 'double spin asymmetry', 'DSA', 'transverse spin', 'longitudinal spin',
  'orbital angular momentum', 'OAM', 'Ji sum rule', 'Jaffe-Manohar decomposition',
  'canonical OAM', 'kinetic OAM',
  // Mass Decomposition
  'mass decomposition', 'trace anomaly', 'proton mass', 'QCD trace anomaly',
  'gluon condensate', 'quark condensate', 'sigma term',
  'energy-momentum tensor', 'EMT', 'gravitational form factor',
  'pressure', 'shear', 'D-term',
];

/** Heavy Ion & QGP */
export const HEAVY_ION_VOCAB = [
  // QGP Properties
  'quark-gluon plasma', 'QGP', 'sQGP', 'wQGP', 'strongly coupled QGP',
  'deconfinement', 'chiral restoration', 'perfect fluid', 'hot QCD',
  'finite temperature', 'finite density', 'hadronization', 'hadron gas',
  'chemical freezeout', 'kinetic freezeout', 'thermal model',
  'statistical hadronization', 'transport coefficient', 'shear viscosity',
  'bulk viscosity', 'η/s', 'ζ/s', 'electrical conductivity', 'thermal conductivity',
  // Collective Motion
  'collective flow', 'elliptic flow', 'v2', 'triangular flow', 'v3',
  'directed flow', 'v1', 'higher harmonics', 'vn', 'anisotropic flow',
  'initial state fluctuation', 'eccentricity', 'participant plane', 'event plane',
  'flow fluctuation', 'non-flow', 'two-particle correlation', 'ridge',
  'away-side', 'near-side', 'jet quenching', 'di-hadron correlation',
  // Special Effects
  'chiral magnetic effect', 'CME', 'chiral vortical effect', 'CVE',
  'chiral separation effect', 'CSE', 'magnetic field',
  'global polarization', 'local polarization', 'spin alignment',
  'Λ polarization', 'vorticity',
  'jet suppression', 'R_AA', 'RAA', 'I_AA', 'IAA', 'di-jet asymmetry',
  'photon-jet', 'Z-jet', 'medium modification',
  // Heavy Flavor
  'heavy flavor', 'charm production', 'bottom production', 'J/ψ suppression',
  'sequential suppression', 'regeneration', 'recombination',
  'heavy quark energy loss', 'radiative energy loss', 'collisional energy loss',
  'dead cone effect', 'Langevin', 'Boltzmann',
];

/** Precision & Weak Interactions */
export const PRECISION_VOCAB = [
  // CKM Matrix
  'CKM matrix', 'Vud', 'Vus', 'Vub', 'Vcd', 'Vcs', 'Vcb', 'Vtd', 'Vts', 'Vtb',
  'unitarity triangle', 'Wolfenstein parameterization', 'Cabibbo angle',
  'CKM unitarity', 'first-row unitarity', 'Vcb puzzle', 'Vub puzzle',
  'exclusive |Vcb|', 'inclusive |Vcb|',
  // CP Violation
  'direct CP violation', 'indirect CP violation', 'mixing-induced CP violation',
  'CP asymmetry', 'epsilon', "epsilon'", 'ε', "ε'", 'penguin pollution',
  'tree-penguin interference',
  // Rare Decays
  'B → K* ll', 'B → K ll', 'Bs → μμ', 'B → Xs γ', 'B → D* τ ν',
  'R(D)', 'R(D*)', 'R(K)', 'R(K*)', 'lepton universality', 'LFU',
  'K → πνν', 'KL → π0 νν', 'K+ → π+ νν', 'εK',
  'lepton flavor violation', 'LFV', 'μ → eγ', 'τ → μγ', 'μ → 3e',
  'τ → 3μ', 'μ-e conversion',
  // Precision Measurements
  'anomalous magnetic moment', 'g-2', 'muon g-2', 'electron g-2',
  'hadronic vacuum polarization', 'HVP', 'hadronic light-by-light', 'HLbL',
  'electric dipole moment', 'EDM', 'neutron EDM', 'electron EDM',
  'proton EDM', 'atomic EDM',
  'Standard Model test', 'electroweak precision', 'W mass', 'sin²θW',
  'ρ parameter', 'S parameter', 'T parameter', 'oblique correction',
];

// ═══════════════════════════════════════════════════════════════════════════════
// 2.8 Experiments & Facilities
// ═══════════════════════════════════════════════════════════════════════════════

/** LHC Experiments */
export const LHC_EXPERIMENTS = [
  'ATLAS', 'CMS', 'LHCb', 'ALICE', 'TOTEM', 'LHCf', 'MoEDAL', 'FASER',
  'LHC', 'Large Hadron Collider',
];

/** Other Collider Experiments */
export const OTHER_COLLIDERS = [
  'Belle', 'Belle II', 'BaBar', 'BESIII', 'CLEO', 'CDF', 'D0', 'DZero',
  'LEP', 'SLD', 'HERA', 'ZEUS', 'H1', 'DELPHI', 'ALEPH', 'L3', 'OPAL',
  'Tevatron', 'TRISTAN', 'PETRA', 'PEP', 'DORIS', 'SPEAR', 'CESR',
  'KEKB', 'SuperKEKB', 'BEPCII',
];

/** Future Facilities */
export const FUTURE_FACILITIES = [
  'FCC', 'CEPC', 'ILC', 'CLIC', 'EIC', 'EicC', 'STCF',
  'Super tau-charm factory', 'Muon Collider', 'FCC-ee', 'FCC-hh',
  'HL-LHC', 'High Luminosity LHC',
];

/** Fixed Target - Hadron Physics */
export const FIXED_TARGET_HADRON = [
  'COMPASS', 'GlueX', 'CLAS', 'CLAS12', 'JLab', 'J-PARC', 'PANDA',
  'Jefferson Lab', 'Hall A', 'Hall B', 'Hall C', 'Hall D',
  'HERMES', 'SELEX', 'LASS', 'Crystal Barrel',
];

/** Fixed Target - Neutrino */
export const FIXED_TARGET_NEUTRINO = [
  'NOvA', 'DUNE', 'T2K', 'MicroBooNE', 'MiniBooNE', 'MINOS', 'MINOS+',
  'Super-Kamiokande', 'Super-K', 'Hyper-Kamiokande', 'Hyper-K',
  'SNO', 'SNO+', 'JUNO', 'Daya Bay', 'Double Chooz', 'RENO',
  'IceCube', 'KamLAND', 'Borexino',
];

/** Fixed Target - Precision */
export const FIXED_TARGET_PRECISION = [
  'Muon g-2', 'g-2 experiment', 'Mu2e', 'COMET', 'MEG', 'MEG II',
  'nEDM', 'SNS nEDM', 'PSI', 'TRIUMF', 'Fermilab',
];

/** Heavy Ion Facilities */
export const HEAVY_ION_FACILITIES = [
  'RHIC', 'STAR', 'PHENIX', 'BRAHMS', 'PHOBOS',
  'NA49', 'NA61/SHINE', 'NA60', 'NA60+', 'CBM',
  'FAIR', 'NICA', 'HIAF', 'J-PARC-HI', 'GSI',
];

/** Dark Matter Experiments */
export const DARK_MATTER_EXPERIMENTS = [
  'XENON', 'XENONnT', 'XENON1T', 'LUX', 'LZ', 'PandaX', 'CDEX',
  'CRESST', 'SuperCDMS', 'DarkSide', 'DEAP', 'PICO',
  'CAST', 'ADMX', 'IAXO', 'ABRACADABRA',
];

/** All experiments combined */
export const ALL_EXPERIMENTS = [
  ...LHC_EXPERIMENTS, ...OTHER_COLLIDERS, ...FUTURE_FACILITIES,
  ...FIXED_TARGET_HADRON, ...FIXED_TARGET_NEUTRINO, ...FIXED_TARGET_PRECISION,
  ...HEAVY_ION_FACILITIES, ...DARK_MATTER_EXPERIMENTS,
];

// ═══════════════════════════════════════════════════════════════════════════════
// Pattern Building and Matching Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a word-boundary regex pattern from a list of terms
 */
function buildVocabPattern(terms: string[]): RegExp {
  const escaped = terms.map(escapeRegex);
  // Sort by length (longest first) to ensure longer matches take precedence
  escaped.sort((a, b) => b.length - a.length);
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi');
}

// Pre-compiled patterns for each vocabulary
const particlePattern = buildVocabPattern(ALL_PARTICLES);
const symmetryPattern = buildVocabPattern(ALL_SYMMETRIES);
const quantumNumberPattern = buildVocabPattern(ALL_QUANTUM_NUMBERS);
const interactionPattern = buildVocabPattern(ALL_INTERACTIONS);
const processPattern = buildVocabPattern(ALL_PROCESSES);
const methodPattern = buildVocabPattern(ALL_METHODS);
const experimentPattern = buildVocabPattern(ALL_EXPERIMENTS);

// Resonance-specific patterns (need special handling for parenthesized names)
const resonanceTerms = [
  ...EXOTIC_MESONS, ...PENTAQUARKS, ...TETRAQUARKS,
  // Include specific resonance patterns
  'X\\(\\d{4}\\)', 'Y\\(\\d{4}\\)', 'Z[cb]?\\(\\d{4,5}\\)',
  'Pc\\(\\d{4}\\)', 'Pcs\\(\\d{4}\\)', 'Tcc\\(\\d{4}\\)',
];
const resonancePattern = new RegExp(`\\b(?:${resonanceTerms.map(escapeRegex).join('|')})\\b`, 'gi');

/**
 * Extract unique matches from text using a pattern
 */
function extractMatches(text: string, pattern: RegExp): string[] {
  const matches = text.match(pattern);
  if (!matches) return [];
  // Deduplicate and normalize
  const unique = new Set<string>();
  for (const m of matches) {
    unique.add(m.toLowerCase());
  }
  return Array.from(unique).sort();
}

/**
 * Extract physics context from text
 * 
 * @param text - Input text to analyze
 * @returns PhysicsContext object with identified concepts
 */
export function extractPhysicsContext(text: string): PhysicsContext {
  const context: PhysicsContext = {};
  
  // Extract particles
  const particles = extractMatches(text, particlePattern);
  if (particles.length > 0) {
    context.particles = particles;
  }
  
  // Extract resonances (keep original case for names like X(3872))
  const resonanceMatches = text.match(resonancePattern);
  if (resonanceMatches && resonanceMatches.length > 0) {
    const uniqueResonances = new Set<string>();
    for (const m of resonanceMatches) {
      uniqueResonances.add(m);
    }
    context.resonances = Array.from(uniqueResonances).sort();
  }
  
  // Extract symmetries
  const symmetries = extractMatches(text, symmetryPattern);
  if (symmetries.length > 0) {
    context.symmetries = symmetries;
  }
  
  // Extract quantum numbers
  const qnumbers = extractMatches(text, quantumNumberPattern);
  if (qnumbers.length > 0) {
    context.quantum_numbers = qnumbers;
  }
  
  // Extract interactions
  const interactions = extractMatches(text, interactionPattern);
  if (interactions.length > 0) {
    context.interactions = interactions;
  }
  
  // Extract processes
  const processes = extractMatches(text, processPattern);
  if (processes.length > 0) {
    context.processes = processes;
  }
  
  // Extract methods
  const methods = extractMatches(text, methodPattern);
  if (methods.length > 0) {
    context.methods = methods;
  }
  
  // Extract experiments
  const experiments = extractMatches(text, experimentPattern);
  if (experiments.length > 0) {
    context.experiments = experiments;
  }
  
  return context;
}

/**
 * Check if text contains any physics concept from a specific category
 */
export function hasPhysicsConcept(text: string, category: keyof PhysicsContext): boolean {
  const patterns: Record<keyof PhysicsContext, RegExp> = {
    particles: particlePattern,
    resonances: resonancePattern,
    symmetries: symmetryPattern,
    quantum_numbers: quantumNumberPattern,
    interactions: interactionPattern,
    processes: processPattern,
    methods: methodPattern,
    experiments: experimentPattern,
  };
  
  const pattern = patterns[category];
  return pattern ? pattern.test(text) : false;
}

/**
 * Count physics concepts in text
 */
export function countPhysicsConcepts(text: string): number {
  const context = extractPhysicsContext(text);
  let count = 0;
  for (const key of Object.keys(context) as Array<keyof PhysicsContext>) {
    const arr = context[key];
    if (arr) count += arr.length;
  }
  return count;
}
