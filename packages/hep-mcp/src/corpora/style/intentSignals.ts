/**
 * Intent Signal Words for Physics Context Classification
 * 
 * This module provides data-driven intent classification for HEP literature.
 * Each intent is defined by a set of signal words/patterns that trigger matching.
 * 
 * Coverage: hep-ph, hep-ex, hep-lat, nucl-th, nucl-ex, hep-th
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Intent Signal Configuration Type
// ═══════════════════════════════════════════════════════════════════════════════

export interface IntentSignalConfig {
  /** Intent identifier */
  intent: string;
  /** Primary signal words (any match triggers) */
  signals: string[];
  /** Optional secondary signals (require context) */
  contextSignals?: string[];
  /** Optional exclusion patterns */
  exclusions?: string[];
  /** Whether to match case-sensitively for some terms */
  caseSensitiveTerms?: string[];
  /** Minimum text length for this intent to apply */
  minLength?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1.1 Dispersion Relations & Analytic Methods (7 types)
// ═══════════════════════════════════════════════════════════════════════════════

export const DISPERSION_ANALYTIC_INTENTS: IntentSignalConfig[] = [
  {
    intent: 'dispersion_relation',
    signals: [
      'dispersion relation', 'dispersive', 'subtraction', 'subtracted dispersion',
      'unsubtracted dispersion', 'spectral function', 'Omnès', 'Muskhelishvili-Omnès',
      'dispersion integral', 'Cauchy principal value', 'once-subtracted', 'twice-subtracted',
      'dispersion representation', 'Cauchy integral', 'spectral representation',
    ],
    caseSensitiveTerms: ['Omnès', 'Muskhelishvili'],
  },
  {
    intent: 'unitarity_analysis',
    signals: [
      'unitarity', 'partial-wave unitarity', 'elastic unitarity', 'two-body unitarity',
      'three-body unitarity', 'optical theorem', 'IAM', 'Cutkosky rules', 'discontinuity',
      'absorptive part', 'imaginary part', 'unitarity cut', 'unitarity constraint',
      'unitarity bound', 'unitarization', 'unitarized amplitude',
    ],
    caseSensitiveTerms: ['IAM'],
  },
  {
    intent: 'analyticity_constraint',
    signals: [
      'analyticity', 'analytic continuation', 'Riemann sheet', 'crossing symmetry',
      'analytic structure', 'complex s-plane', 'crossing relation', 'Mandelstam representation',
      'analytic property', 'analytic properties', 'second sheet', 'first sheet',
      'sheet structure', 'complex plane',
    ],
    caseSensitiveTerms: ['Riemann', 'Mandelstam'],
  },
  {
    intent: 'partial_wave_analysis',
    signals: [
      'partial wave', 'PWA', 'S-wave', 'P-wave', 'D-wave', 'F-wave', 'angular momentum',
      'amplitude analysis', 'Dalitz plot analysis', 'isobar model', 'K-matrix', 'T-matrix',
      'S-matrix', 'unitarized amplitude', 'partial-wave expansion', 'Legendre polynomial',
      'helicity amplitude', 'helicity formalism',
    ],
    caseSensitiveTerms: ['PWA', 'S-wave', 'P-wave', 'D-wave', 'F-wave'],
  },
  {
    intent: 'pole_extraction',
    signals: [
      'pole position', 'resonance pole', 'pole residue', 'coupling constant', 'virtual state',
      'bound state', 'second sheet pole', 'complex pole', 'width from pole', 'pole mass',
      'pole width', 'coupling from pole', 'pole extraction', 'pole determination',
    ],
  },
  {
    intent: 'kinematic_singularity',
    signals: [
      'triangle singularity', 'threshold cusp', 'cusp effect', 'Landau singularity',
      'anomalous threshold', 'branch point', 'branch cut', 'endpoint singularity',
      'pinch singularity', 'kinematic singularity', 'triangular singularity',
      'kinematic effect', 'kinematic enhancement',
    ],
    caseSensitiveTerms: ['Landau'],
  },
  {
    intent: 'roy_steiner_analysis',
    signals: [
      'Roy equation', 'Roy-Steiner', 'GKPY', 'pipi scattering', 'piK scattering',
      'pion-nucleon', 'Froissart-Gribov', 'fixed-t dispersion', 'Roy-like',
      'πK scattering', 'ππ scattering', 'πN scattering',
    ],
    caseSensitiveTerms: ['Roy', 'GKPY', 'Froissart', 'Gribov'],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 1.2 Nucleon Structure & Form Factors (5 types)
// ═══════════════════════════════════════════════════════════════════════════════

export const NUCLEON_STRUCTURE_INTENTS: IntentSignalConfig[] = [
  {
    intent: 'nucleon_structure',
    signals: [
      'nucleon structure', 'proton structure', 'neutron structure', 'internal structure',
      'nucleon spin', 'spin structure', 'spin puzzle', 'spin crisis', 'mass decomposition',
      'proton mass', 'trace anomaly', 'gluon momentum fraction', 'quark momentum fraction',
      'sea quark', 'valence quark', 'proton spin puzzle',
    ],
  },
  {
    intent: 'form_factor',
    signals: [
      'form factor', 'GFF', 'electromagnetic form factor', 'Dirac form factor',
      'Pauli form factor', 'Sachs form factor', 'gravitational form factor', 'D-term',
      'A-form factor', 'J-form factor', 'meson form factor', 'transition form factor',
      'timelike form factor', 'spacelike form factor', 'nucleon polarizability',
      'Compton scattering', 'real Compton', 'virtual Compton', 'electric form factor',
      'magnetic form factor', 'axial form factor', 'scalar form factor',
    ],
    caseSensitiveTerms: ['GFF', 'Dirac', 'Pauli', 'Sachs', 'Compton'],
  },
  {
    intent: 'parton_distribution',
    signals: [
      'parton distribution', 'PDF', 'unpolarized PDF', 'polarized PDF', 'helicity PDF',
      'transversity', 'GPD', 'generalized parton distribution', 'Compton form factor',
      'CFF', 'skewness', 'TMD', 'transverse momentum dependent', 'Sivers function',
      'Boer-Mulders', 'Collins function', 'quasi-PDF', 'pseudo-PDF', 'LaMET',
      'large momentum effective theory', 'fragmentation function', 'dihadron FF',
      'distribution amplitude', 'LCDA', 'light-cone distribution amplitude',
    ],
    caseSensitiveTerms: ['PDF', 'GPD', 'TMD', 'CFF', 'LCDA', 'LaMET', 'Sivers', 'Collins', 'Boer-Mulders'],
  },
  {
    intent: 'radius_measurement',
    signals: [
      'charge radius', 'proton radius', 'proton radius puzzle', 'muonic hydrogen',
      'ep scattering', 'mass radius', 'mechanical radius', 'magnetic radius',
      'Zemach radius', 'rms radius', 'electron-proton scattering', 'proton size',
      'neutron radius', 'nuclear radius',
    ],
    caseSensitiveTerms: ['Zemach'],
  },
  {
    intent: 'dis_process',
    signals: [
      'deep inelastic scattering', 'DIS', 'inclusive DIS', 'semi-inclusive DIS', 'SIDIS',
      'exclusive process', 'DVCS', 'deeply virtual Compton', 'TCS', 'timelike Compton',
      'DVMP', 'Drell-Yan', 'Sullivan process', 'pion structure', 'meson cloud',
      'structure function', 'Bjorken scaling',
    ],
    caseSensitiveTerms: ['DIS', 'SIDIS', 'DVCS', 'DVMP', 'TCS', 'Drell-Yan', 'Sullivan', 'Bjorken'],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 1.3 Hadron Spectroscopy & Structure (6 types)
// ═══════════════════════════════════════════════════════════════════════════════

export const HADRON_SPECTROSCOPY_INTENTS: IntentSignalConfig[] = [
  {
    intent: 'hadron_spectroscopy',
    signals: [
      'hadron spectroscopy', 'baryon spectroscopy', 'meson spectroscopy', 'charmonium',
      'charmonium-like', 'bottomonium', 'bottomonium-like', 'light meson', 'light baryon',
      'strange baryon', 'charmed baryon', 'bottom baryon', 'doubly charmed',
      'N* spectroscopy', 'Δ spectroscopy', 'Λ spectroscopy', 'Σ spectroscopy',
      'Ξ spectroscopy', 'missing resonance', 'quark model', 'hadron spectrum',
    ],
    caseSensitiveTerms: ['N*', 'Δ', 'Λ', 'Σ', 'Ξ', 'Ωccc'],
  },
  {
    intent: 'exotic_state',
    signals: [
      'tetraquark', 'pentaquark', 'hexaquark', 'dibaryon', 'hybrid', 'hybrid meson',
      'hybrid charmonium', 'glueball', 'scalar glueball', 'tensor glueball', 'XYZ states',
      'X(3872)', 'X(3915)', 'X(3940)', 'X(4140)', 'X(4274)', 'X(4500)', 'X(4700)', 'X(6900)',
      'Zc(3900)', 'Zc(4020)', 'Zc(4430)', 'Zb(10610)', 'Zb(10650)', 'Zcs(3985)',
      'Pc(4312)', 'Pc(4440)', 'Pc(4457)', 'Pcs(4459)', 'Tcc(3875)', 'multiquark',
      'compact multiquark', 'diquark-antidiquark', 'fully charmed tetraquark',
      'exotic hadron', 'exotic state', 'hidden-charm pentaquark',
    ],
    caseSensitiveTerms: ['XYZ', 'Zc', 'Zb', 'Pc', 'Pcs', 'Tcc', 'Zcs'],
  },
  {
    intent: 'molecular_interpretation',
    signals: [
      'hadronic molecule', 'molecular state', 'meson-meson molecule', 'meson-baryon molecule',
      'loosely bound', 'threshold state', 'deuteron-like', 'isospin partner', 'spin partner',
      'heavy quark spin symmetry partner', 'binding energy', 'compositeness',
      'wave function at origin', 'molecular interpretation', 'molecular picture',
    ],
  },
  {
    intent: 'coupled_channel',
    signals: [
      'coupled channel', 'coupled-channel analysis', 'K-matrix', 'T-matrix', 'P-vector',
      'chiral unitary', 'unitarized ChPT', 'IAM', 'inverse amplitude method', 'N/D method',
      'final state interaction', 'FSI', 'rescattering', 'coupled-channel unitarity',
      'Bethe-Salpeter equation', 'coupled-channel dynamics',
    ],
    caseSensitiveTerms: ['IAM', 'FSI', 'ChPT', 'Bethe-Salpeter'],
  },
  {
    intent: 'scattering_length',
    signals: [
      'scattering length', 'effective range', 'effective range expansion', 'scattering volume',
      'Luescher method', 'Luescher formula', 'HAL QCD', 'potential method', 'finite volume',
      'lattice scattering', 'phase shift', 'inelasticity', 'Lüscher method',
    ],
    caseSensitiveTerms: ['Luescher', 'Lüscher', 'HAL QCD'],
  },
  {
    intent: 'threshold_dynamics',
    signals: [
      'threshold effect', 'threshold enhancement', 'threshold state', 'cusp effect',
      'threshold cusp', 'Flatté effect', 'triangle singularity', 'triangular singularity',
      'kinematic singularity', 'threshold production', 'near-threshold', 'above-threshold',
      'below-threshold', 'threshold behavior', 'threshold anomaly',
    ],
    caseSensitiveTerms: ['Flatté'],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 1.4 Symmetry & Chiral Dynamics (4 types)
// ═══════════════════════════════════════════════════════════════════════════════

export const SYMMETRY_CHIRAL_INTENTS: IntentSignalConfig[] = [
  {
    intent: 'flavor_symmetry_analysis',
    signals: [
      'SU(2) isospin', 'SU(3) flavor', 'SU(4) flavor', 'isospin', 'isospin breaking',
      'isospin symmetry', 'strangeness', 'charm quantum number', 'flavor breaking',
      'flavor symmetry breaking', 'Gell-Mann-Okubo', 'GMO relation', 'equal spacing rule',
      'mass formula', 'U-spin', 'V-spin', 'G-parity', 'isospin multiplet', 'flavor SU(3)',
    ],
    caseSensitiveTerms: ['GMO', 'SU(2)', 'SU(3)', 'SU(4)', 'Gell-Mann', 'Okubo'],
  },
  {
    intent: 'chiral_dynamics',
    signals: [
      'chiral perturbation', 'ChPT', 'SU(2) ChPT', 'SU(3) ChPT', 'BChPT', 'HBChPT',
      'covariant ChPT', 'infrared regularization', 'EOMS scheme', 'pion mass', 'kaon mass',
      'chiral limit', 'chiral symmetry', 'chiral symmetry breaking', 'spontaneous symmetry breaking',
      'explicit symmetry breaking', 'chiral condensate', 'quark condensate', 'pion decay constant',
      'low-energy constant', 'LEC', 'Gasser-Leutwyler', 'chiral unitary', 'unitarized ChPT',
      'Goldstone boson', 'pseudo-Goldstone', 'chiral expansion', 'chiral order',
    ],
    caseSensitiveTerms: ['ChPT', 'BChPT', 'HBChPT', 'EOMS', 'LEC', 'Gasser', 'Leutwyler'],
  },
  {
    intent: 'heavy_quark_symmetry',
    signals: [
      'heavy quark symmetry', 'HQS', 'heavy quark spin symmetry', 'HQSS',
      'heavy quark flavor symmetry', 'spin partner', 'flavor partner', 'HQET',
      'heavy quark effective theory', 'NRQCD', 'pNRQCD', 'vNRQCD', 'Born-Oppenheimer',
      'BO approximation', 'heavy quark expansion', '1/mQ expansion', 'heavy quark limit',
      "Luke's theorem", 'Isgur-Wise function',
    ],
    caseSensitiveTerms: ['HQS', 'HQSS', 'HQET', 'NRQCD', 'pNRQCD', 'vNRQCD', 'Isgur-Wise', 'Luke'],
  },
  {
    intent: 'chiral_anomaly',
    signals: [
      'chiral anomaly', 'axial anomaly', 'ABJ anomaly', 'triangle anomaly',
      'Wess-Zumino-Witten', 'WZW term', 'anomaly matching', "η-η' mixing",
      'U(1)_A problem', 'topological susceptibility', 'Adler-Bell-Jackiw',
    ],
    caseSensitiveTerms: ['ABJ', 'WZW', 'Wess-Zumino', 'Witten', 'Adler', 'Bell', 'Jackiw'],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 1.5 QCD Foundations (5 types)
// ═══════════════════════════════════════════════════════════════════════════════

export const QCD_FOUNDATIONS_INTENTS: IntentSignalConfig[] = [
  {
    intent: 'yang_mills',
    signals: [
      'Yang-Mills', 'YM theory', 'non-Abelian gauge theory', 'gauge field', 'gauge invariance',
      'gauge transformation', 'field strength tensor', 'gluon field', 'color charge',
      'color SU(3)', 'adjoint representation', 'fundamental representation', 'gauge boson',
      'self-interaction', 'triple gluon vertex', 'four-gluon vertex', 'Gribov copy',
      'Gribov horizon', 'gauge fixing', 'Faddeev-Popov', 'ghost field', 'BRST symmetry',
      'Slavnov-Taylor identity', 'gauge orbit',
    ],
    caseSensitiveTerms: ['Yang-Mills', 'Gribov', 'Faddeev-Popov', 'BRST', 'Slavnov-Taylor'],
  },
  {
    intent: 'confinement',
    signals: [
      'confinement', 'color confinement', 'quark confinement', 'linear potential',
      'string tension', 'flux tube', 'color flux tube', 'dual superconductor',
      'monopole condensation', 'Abelian projection', 'center vortex', 'center symmetry',
      'Polyakov loop', 'Wilson loop', 'area law', 'perimeter law', 'string breaking',
      'Regge trajectory', 'confinement scale', 'confinement mechanism', 'infrared slavery',
      'Gribov-Zwanziger', 'Kugo-Ojima', 'BRST quartet mechanism',
    ],
    caseSensitiveTerms: ['Polyakov', 'Wilson', 'Regge', 'Gribov-Zwanziger', 'Kugo-Ojima'],
  },
  {
    intent: 'mass_gap',
    signals: [
      'mass gap', 'Yang-Mills mass gap', 'glueball mass', 'lowest glueball',
      'millennium problem', 'non-perturbative mass generation', 'dynamical mass generation',
      'gluon mass', 'gluon propagator', 'infrared behavior', 'Schwinger mechanism',
      'dimensional transmutation', 'ΛQCD', 'QCD scale', 'asymptotic freedom',
      'infrared fixed point', 'conformal window', 'walking technicolor', 'Banks-Zaks',
    ],
    caseSensitiveTerms: ['ΛQCD', 'Schwinger', 'Banks-Zaks'],
  },
  {
    intent: 'instanton',
    signals: [
      'instanton', 'anti-instanton', 'instanton liquid', 'instanton gas', 'instanton vacuum',
      'topological charge', 'topological susceptibility', 'winding number', 'Pontryagin index',
      'θ vacuum', 'θ term', 'CP violation from θ', 'BPST instanton', 'instanton size',
      'instanton density', "'t Hooft vertex", "'t Hooft determinant", 'zero mode',
      'fermion zero mode', 'instanton-induced interaction', 'U(1)A anomaly resolution',
      "η' mass", 'Witten-Veneziano formula', 'sphaleron', 'electroweak sphaleron',
      'baryon number violation', 'caloron', 'finite-temperature instanton', 'instanton-dyon',
    ],
    caseSensitiveTerms: ['BPST', 'Pontryagin', 'Witten-Veneziano', "'t Hooft"],
  },
  {
    intent: 'chiral_symmetry_breaking',
    signals: [
      'chiral symmetry breaking', 'spontaneous chiral symmetry breaking', 'SCSB',
      'dynamical chiral symmetry breaking', 'DCSB', 'chiral condensate', 'quark condensate',
      'order parameter', 'Goldstone theorem', 'Nambu-Goldstone boson', 'pion as Goldstone',
      'Gell-Mann-Oakes-Renner', 'GMOR relation', 'pion decay constant', 'chiral restoration',
      'chiral transition', 'critical temperature', 'Columbia plot', 'Banks-Casher relation',
      'Dirac spectrum', 'eigenvalue density', 'NJL model', 'Nambu-Jona-Lasinio',
      'linear sigma model', 'Schwinger-Dyson', 'gap equation', 'constituent quark mass',
      'current quark mass',
    ],
    caseSensitiveTerms: ['SCSB', 'DCSB', 'GMOR', 'NJL', 'Nambu-Goldstone', 'Banks-Casher', 'Schwinger-Dyson'],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 1.6 QCD Dynamics & Computation (7 types)
// ═══════════════════════════════════════════════════════════════════════════════

export const QCD_DYNAMICS_INTENTS: IntentSignalConfig[] = [
  {
    intent: 'qcd_phase',
    signals: [
      'phase transition', 'QCD phase diagram', 'phase boundary', 'deconfinement',
      'deconfinement transition', 'chiral restoration', 'chiral phase transition',
      'crossover', 'first-order transition', 'critical endpoint', 'CEP',
      'critical temperature', 'critical density', 'baryon chemical potential',
      'Columbia plot', 'imaginary chemical potential', 'Taylor expansion',
      'fugacity expansion', 'reweighting', 'sign problem', 'complex Langevin',
      'Lefschetz thimble',
    ],
    caseSensitiveTerms: ['CEP', 'Columbia', 'Lefschetz'],
  },
  {
    intent: 'qgp_property',
    signals: [
      'quark-gluon plasma', 'QGP', 'sQGP', 'wQGP', 'strongly coupled QGP', 'perfect fluid',
      'hot/dense matter', 'hot QCD', 'finite temperature', 'finite density', 'hadronization',
      'hadron gas', 'chemical freezeout', 'kinetic freezeout', 'thermal model',
      'statistical hadronization', 'transport coefficient', 'shear viscosity',
      'bulk viscosity', 'η/s', 'ζ/s', 'jet quenching parameter', 'heavy quark diffusion',
      'electrical conductivity', 'thermal conductivity', 'relaxation time', 'equilibration',
    ],
    caseSensitiveTerms: ['QGP', 'sQGP', 'wQGP'],
  },
  {
    intent: 'lattice_result',
    signals: [
      'lattice QCD', 'LQCD', 'lattice calculation', 'lattice simulation', 'Monte Carlo',
      'Markov chain Monte Carlo', 'MCMC', 'hybrid Monte Carlo', 'HMC', 'Wilson fermion',
      'staggered fermion', 'domain wall fermion', 'DWF', 'overlap fermion', 'twisted mass',
      'clover action', 'HISQ action', 'smearing', 'HYP smearing', 'APE smearing',
      'Wuppertal smearing', 'distillation', 'physical pion mass', 'chiral extrapolation',
      'continuum extrapolation', 'continuum limit', 'finite volume effect', 'Luescher formula',
      'lattice spacing', 'scale setting', 'ensemble', 'configuration', 'gauge configuration',
      'quenched', 'Nf=2', 'Nf=2+1', 'Nf=2+1+1', 'isospin breaking', 'QED correction',
    ],
    caseSensitiveTerms: ['LQCD', 'MCMC', 'HMC', 'DWF', 'HISQ', 'HYP', 'APE', 'Wuppertal', 'Luescher'],
  },
  {
    intent: 'effective_theory',
    signals: [
      'effective field theory', 'EFT', 'power counting', 'Weinberg counting', 'KSW counting',
      'naturalness', 'matching', 'low-energy effective theory', 'ChPT', 'HQET', 'NRQCD',
      'pNRQCD', 'vNRQCD', 'SCET', 'soft-collinear effective theory', 'XEFT', 'pionless EFT',
      'nuclear EFT', 'large momentum effective theory', 'LaMET', 'quasi-distribution',
      'pseudo-distribution', 'current-current correlator', 'short-distance coefficient',
      'Wilson coefficient', 'operator basis', 'evanescent operator', 'scheme transformation',
    ],
    caseSensitiveTerms: ['EFT', 'ChPT', 'HQET', 'NRQCD', 'SCET', 'XEFT', 'LaMET', 'Weinberg', 'KSW'],
  },
  {
    intent: 'factorization',
    signals: [
      'factorization', 'collinear factorization', 'kT factorization', 'high-energy factorization',
      'TMD factorization', 'soft-collinear factorization', 'NRQCD factorization',
      'generalized factorization', 'QCD factorization', 'QCDF', 'factorization breaking',
      'factorization proof', 'factorization scale', 'hard function', 'soft function',
      'jet function', 'beam function', 'shape function', 'Glauber gluon',
      'spectator interaction', 'endpoint singularity', 'rapidity regulator',
      'Collins regulator', 'η regulator',
    ],
    caseSensitiveTerms: ['TMD', 'QCDF', 'NRQCD', 'Glauber', 'Collins'],
  },
  {
    intent: 'renormalization',
    signals: [
      'renormalization', 'renormalization group', 'RGE', 'Callan-Symanzik equation',
      'running coupling', 'αs', 'αs(MZ)', 'αs running', 'asymptotic freedom', 'Landau pole',
      'anomalous dimension', 'beta function', 'β function', 'one-loop', 'two-loop',
      'three-loop', 'four-loop', 'five-loop', 'MS-bar', 'MSbar scheme', 'on-shell scheme',
      'MOM scheme', 'RI/MOM', 'RI/SMOM', 'pole mass', 'MS mass', 'kinetic mass', 'PS mass',
      '1S mass', 'threshold mass', 'scale dependence', 'scheme dependence', 'scheme conversion',
      'DGLAP evolution', 'ERBL evolution', 'BFKL evolution', 'CSS evolution',
      'Collins-Soper kernel', 'rapidity evolution', 'rapidity anomalous dimension',
    ],
    caseSensitiveTerms: ['RGE', 'MS-bar', 'MSbar', 'MOM', 'DGLAP', 'ERBL', 'BFKL', 'CSS', 'Collins-Soper', 'Callan-Symanzik', 'Landau'],
  },
  {
    intent: 'sum_rule',
    signals: [
      'QCD sum rules', 'SVZ sum rules', 'Shifman-Vainshtein-Zakharov', 'Borel sum rules',
      'Borel transform', 'Borel window', 'light-cone sum rules', 'LCSR',
      'finite energy sum rules', 'FESR', 'moment sum rules', 'inverse moment sum rules',
      'Laplace sum rules', 'Gaussian sum rules', 'duality', 'quark-hadron duality',
      'local duality', 'global duality', 'semi-local duality', 'OPE',
      'operator product expansion', 'twist expansion', 'Wilson OPE', 'short-distance expansion',
      'condensate', 'vacuum condensate', 'quark condensate', 'gluon condensate',
      'four-quark condensate', 'mixed condensate', 'dimension-6', 'dimension-8',
      'continuum threshold', 'Borel mass',
    ],
    caseSensitiveTerms: ['SVZ', 'LCSR', 'FESR', 'OPE', 'Borel', 'Shifman', 'Vainshtein', 'Zakharov'],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 1.7 Precision Calculations & SM Tests (5 types)
// ═══════════════════════════════════════════════════════════════════════════════

export const PRECISION_SM_INTENTS: IntentSignalConfig[] = [
  {
    intent: 'precision_sm_test',
    signals: [
      'precision calculation', 'precision test', 'Standard Model test', 'electroweak precision',
      'Z-pole', 'W mass', 'sin²θ_W', 'Weinberg angle', 'ρ parameter', 'S/T/U parameter',
      'oblique correction', 'electroweak fit', 'global fit', 'CKM matrix', 'Vud', 'Vus',
      'Vcb', 'Vub', 'unitarity triangle', 'CKM unitarity', 'Cabibbo angle', 'Wolfenstein',
      'rare decay', 'rare B decay', 'rare K decay', 'B → Xs γ', 'B → K* ll', 'Bs → μμ',
      'K → πνν', 'electroweak radiative correction',
    ],
    caseSensitiveTerms: ['CKM', 'Cabibbo', 'Wolfenstein', 'Weinberg'],
  },
  {
    intent: 'cp_violation',
    signals: [
      'CP violation', 'CPV', 'direct CP violation', 'indirect CP violation', 'CP asymmetry',
      'mixing-induced CP violation', "ε'/ε", 'CPT', 'CPT violation', 'CPT test',
      'strong CP problem', 'θ_QCD', 'theta term', 'PQ symmetry', 'Peccei-Quinn',
      'penguin pollution', 'tree-penguin interference', 'isospin analysis', 'SU(3) analysis',
    ],
    caseSensitiveTerms: ['CPV', 'CPT', 'Peccei-Quinn'],
  },
  {
    intent: 'edm_calculation',
    signals: [
      'electric dipole moment', 'EDM', 'neutron EDM', 'nEDM', 'proton EDM', 'electron EDM',
      'eEDM', 'atomic EDM', 'molecular EDM', 'diamagnetic EDM', 'paramagnetic EDM',
      'nuclear Schiff moment', 'MQM', 'chromo-EDM', 'Weinberg operator', 'CEDM', 'quark EDM',
      'θ-term contribution', 'T-violation', 'CP-odd',
    ],
    caseSensitiveTerms: ['EDM', 'nEDM', 'eEDM', 'CEDM', 'MQM', 'Schiff'],
  },
  {
    intent: 'anomaly_discussion',
    signals: [
      'g-2', 'muon g-2', '(g-2)μ', 'electron g-2', '(g-2)e', 'anomalous magnetic moment',
      'hadronic vacuum polarization', 'HVP', 'hadronic light-by-light', 'HLbL',
      'window observable', 'R-ratio', 'e+e- → hadrons', 'τ decay', 'MUonE', 'lattice HVP',
      'BMW', 'B anomaly', 'B physics anomaly', 'R(K)', 'R(K*)', 'R(D)', 'R(D*)',
      'lepton universality', 'lepton flavor universality', 'LFU violation', 'b → sll', 'b → cτν',
      'muon anomalous magnetic moment',
    ],
    caseSensitiveTerms: ['HVP', 'HLbL', 'MUonE', 'BMW', 'LFU'],
  },
  {
    intent: 'axion_coupling',
    signals: [
      'axion', 'QCD axion', 'ALPs', 'axion-like particle', 'pseudo-scalar',
      'axion-photon coupling', 'gaγγ', 'axion-nucleon coupling', 'axion-electron coupling',
      'invisible decay', 'η → invisible', 'π → invisible', 'light dark sector', 'dark photon',
      'hidden sector', 'portal', 'axion dark matter', 'axion helioscope', 'axion haloscope',
      'CAST', 'ADMX', 'IAXO',
    ],
    caseSensitiveTerms: ['ALPs', 'CAST', 'ADMX', 'IAXO'],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 1.8 Beyond Standard Model (4 types)
// ═══════════════════════════════════════════════════════════════════════════════

export const BSM_INTENTS: IntentSignalConfig[] = [
  {
    intent: 'dark_matter',
    signals: [
      'dark matter', 'DM', 'WIMP', 'weakly interacting massive particle', 'direct detection',
      'indirect detection', 'relic abundance', 'thermal relic', 'freeze-out', 'freeze-in',
      'FIMP', 'asymmetric dark matter', 'self-interacting dark matter', 'SIDM', 'dark sector',
      'dark photon', 'sterile neutrino', 'dark Higgs', 'co-annihilation', 'Sommerfeld enhancement',
    ],
    caseSensitiveTerms: ['WIMP', 'FIMP', 'SIDM', 'Sommerfeld'],
  },
  {
    intent: 'supersymmetry',
    signals: [
      'supersymmetry', 'SUSY', 'MSSM', 'NMSSM', 'CMSSM', 'sparticle', 'superpartner',
      'squark', 'slepton', 'gluino', 'neutralino', 'chargino', 'Higgsino', 'wino', 'bino',
      'LSP', 'lightest supersymmetric particle', 'naturalness', 'fine-tuning', 'μ problem',
      'soft SUSY breaking', 'gauge mediation', 'gravity mediation', 'anomaly mediation',
    ],
    caseSensitiveTerms: ['SUSY', 'MSSM', 'NMSSM', 'CMSSM', 'LSP', 'Higgsino'],
  },
  {
    intent: 'bsm_search',
    signals: [
      'beyond standard model', 'BSM', 'new physics', 'NP', 'effective operator', 'SMEFT',
      'dimension-6', 'Wilson coefficient', 'anomalous coupling', 'composite Higgs',
      'extra dimension', 'warped extra dimension', 'Randall-Sundrum', 'ADD', 'KK mode',
      "Z'", "W'", 'heavy neutral lepton', 'HNL', 'leptoquark', 'diquark', 'coloron',
      'excited fermion',
    ],
    caseSensitiveTerms: ['BSM', 'SMEFT', 'Randall-Sundrum', 'ADD', 'HNL'],
  },
  {
    intent: 'flavor_violation',
    signals: [
      'lepton flavor violation', 'LFV', 'μ → eγ', 'τ → μγ', 'μ → 3e', 'τ → 3μ',
      'μ-e conversion', 'μN → eN', 'CLFV', 'charged LFV', 'MEG', 'Mu2e', 'COMET', 'Mu3e',
      'FCNC', 'flavor-changing neutral current', 'b → sγ', 'b → dγ', 'K-K̄ mixing',
      'B-B̄ mixing', 'D-D̄ mixing', 'Bs-B̄s mixing', 'neutral meson mixing', 'ΔF=2', 'box diagram',
    ],
    caseSensitiveTerms: ['LFV', 'CLFV', 'FCNC', 'MEG', 'Mu2e', 'COMET', 'Mu3e'],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 1.9 Nuclear Physics Cross-cutting (9 types)
// ═══════════════════════════════════════════════════════════════════════════════

export const NUCLEAR_PHYSICS_INTENTS: IntentSignalConfig[] = [
  {
    intent: 'neutron_star',
    signals: [
      'neutron star', 'NS', 'pulsar', 'magnetar', 'equation of state', 'EoS', 'nuclear EoS',
      'tidal deformability', 'Love number', 'mass-radius relation', 'TOV equation',
      'maximum mass', 'NS merger', 'GW170817', 'GW190425', 'kilonova', 'r-process',
      'neutron star matter', 'β-equilibrium', 'hyperon puzzle', 'quark core', 'hybrid star',
      'strange star',
    ],
    caseSensitiveTerms: ['TOV', 'GW170817', 'GW190425'],
  },
  {
    intent: 'heavy_ion',
    signals: [
      'heavy ion', 'heavy-ion collision', 'HIC', 'Au+Au', 'Pb+Pb', 'Cu+Cu', 'p+Pb', 'd+Au',
      'collision geometry', 'centrality', 'impact parameter', 'Npart', 'Ncoll', 'Glauber model',
      'collective flow', 'anisotropic flow', 'elliptic flow', 'v2', 'triangular flow', 'v3',
      'directed flow', 'v1', 'higher harmonics', 'vn', 'flow coefficient', 'initial state',
      'eccentricity', 'participant plane', 'event plane', 'non-flow', 'jet correlation',
      'strangeness production', 'strangeness enhancement', 'canonical suppression',
      'thermal model', 'statistical hadronization',
    ],
    caseSensitiveTerms: ['HIC', 'Glauber'],
  },
  {
    intent: 'nuclear_force',
    signals: [
      'nuclear force', 'nucleon-nucleon', 'NN interaction', 'NN scattering', 'NN potential',
      'chiral nuclear force', 'N3LO', 'three-body force', '3NF', 'three-nucleon force',
      'four-nucleon force', 'nuclear matter', 'symmetric nuclear matter', 'pure neutron matter',
      'nuclear saturation', 'saturation density', 'saturation energy', 'incompressibility',
      'symmetry energy', 'slope parameter L', 'Skyrme', 'Gogny', 'relativistic mean field',
      'RMF', 'Brueckner', 'BHF', 'variational Monte Carlo', 'Green\'s function Monte Carlo',
      'GFMC', 'lattice nuclear', 'lattice EFT', 'pionless EFT nuclear',
    ],
    caseSensitiveTerms: ['N3LO', '3NF', 'RMF', 'BHF', 'GFMC', 'Skyrme', 'Gogny', 'Brueckner'],
  },
  {
    intent: 'hypernuclei',
    signals: [
      'hypernuclei', 'hypernuclear', 'Λ hypernucleus', 'Σ hypernucleus', 'Ξ hypernucleus',
      'double Λ hypernucleus', 'hyperon-nucleon', 'YN interaction', 'hyperon-hyperon',
      'YY interaction', 'SU(3) baryon', 'strangeness nuclear physics', 'few-body hadron',
      'few-body system', 'Faddeev', 'Yakubovsky', 'variational calculation',
    ],
    caseSensitiveTerms: ['Faddeev', 'Yakubovsky'],
  },
  {
    intent: 'chiral_magnetic',
    signals: [
      'chiral magnetic effect', 'CME', 'chiral vortical effect', 'CVE', 'chiral separation effect',
      'CSE', 'chiral magnetic wave', 'CMW', 'magnetic field', 'eBz', 'isobar run', 'Ru+Ru',
      'Zr+Zr', 'charge separation', 'charge-dependent correlation', 'γ correlator', 'δ correlator',
      'vorticity', 'thermal vorticity', 'kinematic vorticity', 'global polarization',
      'local polarization', 'Λ polarization', 'Ξ polarization', 'spin alignment',
      'ρ(770) spin alignment', 'φ(1020) spin alignment', 'K* spin alignment',
    ],
    caseSensitiveTerms: ['CME', 'CVE', 'CSE', 'CMW'],
  },
  {
    intent: 'ultraperipheral',
    signals: [
      'ultraperipheral collision', 'UPC', 'photon-photon', 'γγ', 'photon-nucleus', 'γA',
      'photoproduction', 'exclusive production', 'coherent production', 'incoherent production',
      'Primakoff', 'light-by-light scattering', 'γγ → γγ', 'vector meson photoproduction',
      'J/ψ photoproduction', 'Υ photoproduction', 'ρ photoproduction', 'nuclear breakup',
      'electromagnetic dissociation', 'Coulomb excitation', 'Weizsäcker-Williams',
      'equivalent photon approximation', 'EPA',
    ],
    caseSensitiveTerms: ['UPC', 'EPA', 'Primakoff', 'Weizsäcker-Williams'],
  },
  {
    intent: 'nucleosynthesis',
    signals: [
      'nucleosynthesis', 'r-process', 'rapid neutron capture', 's-process', 'slow neutron capture',
      'p-process', 'rp-process', 'νp-process', 'BBN', 'Big Bang nucleosynthesis',
      'stellar nucleosynthesis', 'supernova nucleosynthesis', 'neutron star merger nucleosynthesis',
      'kilonova', 'nuclear reaction rate', 'Gamow window', 'S-factor', 'astrophysical S-factor',
      'reaction cross section', 'thermonuclear reaction', 'CNO cycle', 'pp chain', 'triple-alpha',
    ],
    caseSensitiveTerms: ['BBN', 'CNO', 'Gamow'],
  },
  {
    intent: 'gravitational_wave',
    signals: [
      'gravitational wave', 'GW', 'LIGO', 'Virgo', 'KAGRA', 'binary merger', 'binary neutron star',
      'BNS', 'neutron star-black hole', 'NSBH', 'binary black hole', 'BBH', 'GW170817', 'GW190425',
      'multi-messenger', 'electromagnetic counterpart', 'tidal deformability', 'post-merger',
      'equation of state constraint', 'inspiral', 'ringdown', 'waveform', 'template matching',
    ],
    caseSensitiveTerms: ['LIGO', 'Virgo', 'KAGRA', 'BNS', 'NSBH', 'BBH', 'GW170817', 'GW190425'],
  },
  {
    intent: 'superheavy_nuclei',
    signals: [
      'superheavy element', 'SHE', 'superheavy nuclei', 'transactinide', 'transfermium',
      'island of stability', 'magic number', 'doubly magic', 'Z=114', 'Z=120', 'Z=126', 'N=184',
      'shell closure', 'shell correction', 'Strutinsky', 'liquid drop model',
      'macroscopic-microscopic', 'fission barrier', 'spontaneous fission', 'alpha decay chain',
      'half-life', 'decay mode', 'synthesis', 'hot fusion', 'cold fusion', '48Ca beam',
      'actinide target', 'compound nucleus', 'evaporation residue', 'cross section',
      'excitation function', 'SHIP', 'TASCA', 'DGFRS', 'RIKEN', 'GSI', 'Dubna',
      'Oganesson', 'Tennessine', 'Flerovium', 'Nihonium', 'relativistic effect',
      'nuclear DFT', 'Skyrme-Hartree-Fock', 'covariant DFT',
    ],
    caseSensitiveTerms: ['SHE', 'SHIP', 'TASCA', 'DGFRS', 'RIKEN', 'GSI', 'Dubna', 'Strutinsky'],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 1.10 Jet Physics & Energy Correlators (3 types)
// ═══════════════════════════════════════════════════════════════════════════════

export const JET_PHYSICS_INTENTS: IntentSignalConfig[] = [
  {
    intent: 'energy_correlator',
    signals: [
      'energy correlator', 'EEC', 'energy-energy correlator', 'EEEC', 'three-point energy correlator',
      'projected N-point correlator', 'celestial block', 'collinear limit', 'back-to-back limit',
      'squeezed limit', 'OPE limit', 'track function', 'charge correlator', 'jet substructure observable',
      'shape variable', 'angularity', 'jet mass', 'thrust', 'N-subjettiness', 'τN', 'D2', 'C2', 'N2', 'M2',
      'light-ray OPE', 'contact term', 'detector function',
    ],
    caseSensitiveTerms: ['EEC', 'EEEC', 'OPE'],
  },
  {
    intent: 'jet_substructure',
    signals: [
      'jet substructure', 'jet algorithm', 'anti-kT', 'Cambridge/Aachen', 'kT algorithm',
      'jet clustering', 'jet reconstruction', 'jet shape', 'jet function', 'angularity',
      'planar flow', 'pull angle', 'jet charge', 'grooming', 'soft drop', 'trimming', 'pruning',
      'filtering', 'modified mass drop', 'MMDT', 'Y-splitter', 'recursive soft drop',
      'iterated soft drop', 'Lund jet plane', 'Lund diagram', 'primary Lund', 'secondary Lund',
      'decluster', 'splitting function', 'splitting history', 'jet fragmentation',
      'hadronization correction',
    ],
    caseSensitiveTerms: ['MMDT', 'Lund', 'Cambridge/Aachen'],
  },
  {
    intent: 'resummation',
    signals: [
      'resummation', 'all-order', 'Sudakov', 'Sudakov resummation', 'threshold resummation',
      'recoil resummation', 'transverse momentum resummation', 'pT resummation', 'small-R resummation',
      'non-global logarithm', 'NGL', 'super-leading logarithm', 'clustering logarithm',
      'rapidity logarithm', 'N3LL', 'NNLL', 'NLL', 'LL', 'leading logarithm',
      'next-to-leading logarithm', 'matching', 'NLO+NLL', 'NNLO+NNLL', 'profile scale',
      'canonical scale', 'CSS formalism', 'b-space', 'qT resummation', 'joint resummation',
      'SCET resummation',
    ],
    caseSensitiveTerms: ['N3LL', 'NNLL', 'NLL', 'LL', 'NGL', 'CSS', 'SCET', 'Sudakov'],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 1.11 Femtoscopy & Correlation Measurements (3 types)
// ═══════════════════════════════════════════════════════════════════════════════

export const FEMTOSCOPY_INTENTS: IntentSignalConfig[] = [
  {
    intent: 'femtoscopy_analysis',
    signals: [
      'femtoscopy', 'correlation function', 'momentum correlation', 'two-particle correlation',
      'Lednicky-Lyuboshitz', 'Lednicky model', 'Koonin-Pratt', 'source size', 'source radius',
      'Gaussian source', 'Gaussian radius', 'source function', 'emission source',
      'correlation strength', 'λ parameter', 'purity', 'pair purity', 'residual correlation',
      'misidentification', 'feed-down correction', 'final state interaction', 'FSI effect',
      'Coulomb correction', 'Gamow factor', 'strong FSI', 'CATS', 'correlation analysis tool',
      'genuine correlation', 'non-femtoscopic background', 'mini-jet', 'jet correlation',
    ],
    caseSensitiveTerms: ['Lednicky', 'Lyuboshitz', 'Koonin-Pratt', 'CATS', 'Gamow'],
  },
  {
    intent: 'hbt_correlation',
    signals: [
      'HBT', 'Hanbury-Brown-Twiss', 'Bose-Einstein correlation', 'BEC', 'quantum statistics',
      'identical particle correlation', 'pion correlation', 'kaon correlation', 'proton correlation',
      'HBT radii', 'Rout', 'Rside', 'Rlong', 'out-side-long', 'Bertsch-Pratt',
      'Yano-Koonin-Podgoretsky', 'YKP', 'imaging', 'source imaging', '3D HBT',
      'azimuthally-sensitive HBT', 'HBT puzzle', 'Rout/Rside ratio',
    ],
    caseSensitiveTerms: ['HBT', 'BEC', 'YKP', 'Bertsch-Pratt', 'Hanbury-Brown-Twiss'],
  },
  {
    intent: 'space_time_emission',
    signals: [
      'emission source', 'source function', 'space-time', 'space-time evolution',
      'emission duration', 'emission time', 'lifetime', 'homogeneity region',
      'freeze-out hypersurface', 'blast-wave', 'thermal source', 'collective expansion',
      'radial flow', 'mT scaling', 'kT dependence', 'centrality dependence',
      'multiplicity dependence', 'system size dependence', 'coalescence', 'deuteron production',
      'light nuclei', 'coalescence parameter B2', 'B3',
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 1.12 General Physics Methods (12 types)
// ═══════════════════════════════════════════════════════════════════════════════

export const GENERAL_METHODS_INTENTS: IntentSignalConfig[] = [
  {
    intent: 'derivation',
    signals: [
      'we derive', 'we show that', 'it follows that', 'starting from', 'one obtains',
      'using Eq.', 'substituting', 'after integration', 'by definition', 'from first principles',
      'straightforward calculation', 'lengthy calculation', 'tedious but straightforward',
      'explicit calculation', 'algebraic manipulation', 'Taylor expansion', 'perturbative expansion',
      'series expansion', 'asymptotic expansion', 'saddle point', 'steepest descent',
      'stationary phase', 'Laplace method', 'WKB approximation', 'Born approximation',
      'eikonal approximation', 'semiclassical', 'variational principle', 'Euler-Lagrange',
      'Hamilton-Jacobi', 'path integral', 'functional integral', 'Feynman diagram',
      'diagrammatic calculation', 'cutting rules', 'reduction', 'IBP', 'integration-by-parts',
      'Laporta algorithm', 'master integral', 'differential equation method', 'canonical basis',
      'symbol', 'coproduct', 'polylogarithm', 'multiple polylogarithm', 'MPL',
      'harmonic polylogarithm', 'HPL', 'iterated integral', 'Chen iterated integral',
    ],
    caseSensitiveTerms: ['IBP', 'MPL', 'HPL', 'Laporta', 'WKB', 'Born', 'Euler-Lagrange', 'Hamilton-Jacobi', 'Feynman', 'Chen'],
  },
  {
    intent: 'calculation',
    signals: [
      'we calculate', 'we compute', 'we evaluate', 'the result is', 'evaluating',
      'numerical calculation', 'numerical evaluation', 'numerical integration',
      'Monte Carlo integration', 'adaptive integration', 'analytic result', 'closed-form expression',
      'explicit expression', 'compact expression', 'final result', 'leading contribution',
      'leading order', 'LO', 'subleading correction', 'NLO', 'NNLO', 'N3LO', 'higher-order',
      'loop correction', 'one-loop', 'two-loop', 'multi-loop', 'radiative correction',
      'QED correction', 'QCD correction', 'electroweak correction', 'finite-size correction',
      'finite-volume correction', 'kinematic correction', 'recoil correction',
      'relativistic correction', 'binding correction', 'Coulomb correction', 'vacuum polarization',
      'self-energy', 'vertex correction', 'box diagram', 'triangle diagram', 'bubble diagram',
      'tadpole', 'counterterm', 'renormalized result', 'scheme-independent', 'RG-improved',
      'resummed result',
    ],
    caseSensitiveTerms: ['LO', 'NLO', 'NNLO', 'N3LO', 'QED', 'QCD', 'RG'],
  },
  {
    intent: 'approximation',
    signals: [
      'approximation', 'approximate', 'leading approximation', 'first approximation',
      'crude approximation', 'good approximation', 'valid approximation', 'heavy quark limit',
      'static limit', 'non-relativistic limit', 'chiral limit', 'large-N', 'large-Nc',
      "'t Hooft limit", 'planar limit', 'narrow width', 'narrow resonance', 'Breit-Wigner',
      'zero-width approximation', 'on-shell approximation', 'soft approximation',
      'collinear approximation', 'eikonal', 'Regge limit', 'high-energy limit', 'low-energy limit',
      'threshold expansion', 'near-threshold', 'small parameter', 'expansion parameter',
      'power counting', 'power suppressed', 'twist suppressed', '1/m suppressed', 'α_s suppressed',
      'truncation', 'truncation error', 'missing higher-order', 'scale uncertainty',
      'parametric uncertainty',
    ],
    caseSensitiveTerms: ["'t Hooft", 'Breit-Wigner', 'Regge'],
  },
  {
    intent: 'numerical_method',
    signals: [
      'numerical', 'numerically', 'numerical solution', 'numerical result', 'Monte Carlo',
      'MC simulation', 'importance sampling', 'Metropolis', 'Metropolis-Hastings', 'MCMC',
      'Markov chain', 'autocorrelation', 'thermalization', 'equilibration', 'statistical error',
      'systematic error', 'finite-difference', 'finite-element', 'FEM', 'spectral method',
      'Gaussian quadrature', 'Clenshaw-Curtis', 'extrapolation', 'Richardson extrapolation',
      'Padé approximant', 'conformal mapping', 'Borel resummation', 'Borel-Padé',
      'asymptotic series', 'divergent series', 'renormalon', 'IR renormalon', 'UV renormalon',
      'OPE renormalon', 'ambiguity', 'non-perturbative ambiguity', 'power correction', '1/Q correction',
    ],
    caseSensitiveTerms: ['MCMC', 'FEM', 'Metropolis', 'Richardson', 'Padé', 'Borel', 'OPE', 'Clenshaw-Curtis'],
  },
  {
    intent: 'data_analysis',
    signals: [
      'fit', 'fitting', 'least-squares', 'χ²', 'chi-square', 'goodness of fit', 'χ²/ndf',
      'degrees of freedom', 'p-value', 'confidence level', 'CL', 'CLs', 'confidence interval',
      'credible interval', 'error bar', 'uncertainty band', 'error propagation', 'likelihood',
      'maximum likelihood', 'MLE', 'log-likelihood', 'profile likelihood', 'extended likelihood',
      'unbinned likelihood', 'binned likelihood', 'template fit', 'sPlot', 'Bayesian',
      'posterior', 'prior', 'flat prior', 'informative prior', 'Jeffreys prior', 'evidence',
      'marginal likelihood', 'Bayes factor', 'model comparison', 'model selection', 'AIC', 'BIC',
      'systematic uncertainty', 'systematic error', 'statistical uncertainty', 'statistical error',
      'total uncertainty', 'dominant uncertainty', 'subdominant', 'pull distribution', 'pull',
      'residual', 'normalized residual', 'tension', 'compatibility', 'covariance matrix',
      'correlation matrix', 'correlation coefficient', 'nuisance parameter', 'profiling',
      'marginalization', 'bootstrap', 'jackknife', 'cross-validation', 'k-fold', 'overfitting',
      'regularization', 'penalty term', 'constraint', 'Gaussian constraint',
    ],
    caseSensitiveTerms: ['MLE', 'AIC', 'BIC', 'CLs', 'sPlot', 'Bayesian', 'Jeffreys'],
  },
  {
    intent: 'uncertainty_analysis',
    signals: [
      'uncertainty', 'error analysis', 'error budget', 'error breakdown', 'dominant source',
      'theoretical uncertainty', 'experimental uncertainty', 'scale uncertainty', 'PDF uncertainty',
      'parametric uncertainty', 'model uncertainty', 'method uncertainty', 'systematic uncertainty',
      'correlated uncertainty', 'uncorrelated uncertainty', 'bin-to-bin correlation',
      'point-to-point correlation', 'normalization uncertainty', 'shape uncertainty',
      'asymmetric error', 'upper limit', 'lower limit', '90% CL', '95% CL', 'exclusion limit',
      'sensitivity', 'expected limit', 'observed limit', 'Brazil band', '±1σ band', '±2σ band',
      'discovery potential', '5σ discovery', 'sensitivity reach',
    ],
  },
  {
    intent: 'model_comparison',
    signals: [
      'comparison', 'compare', 'comparison between', 'comparison of', 'model A vs model B',
      'alternative model', 'competing model', 'rival interpretation', 'different approach',
      'various approaches', 'several models', 'model-independent', 'model-dependent',
      'advantages', 'disadvantages', 'pros and cons', 'strengths', 'weaknesses', 'limitations',
      'drawbacks', 'shortcomings', 'improvement', 'better description', 'worse description',
      'equally good', 'indistinguishable', 'cannot discriminate', 'discriminating power',
      'distinguishing feature', 'characteristic signature', 'benchmark', 'benchmark scenario',
      'reference point',
    ],
    contextSignals: ['versus', 'vs', 'vs.'],
  },
  {
    intent: 'interpretation_debate',
    signals: [
      'interpretation', 'physical interpretation', 'alternative interpretation',
      'different interpretation', 'conventional interpretation', 'standard interpretation',
      'our interpretation', 'this interpretation', 'interpretation as', 'interpreted as',
      'can be interpreted', 'should be interpreted', 'molecular vs compact',
      'molecule or tetraquark', 'triangle singularity or resonance', 'dynamical or kinematical',
      'genuine state', 'non-resonant', 'artifact', 'experimental artifact', 'analysis artifact',
      'threshold artifact', 'cusp vs resonance', 'bound state vs virtual state', 'controversial',
      'debated', 'disputed', 'under debate', 'open question', 'unresolved', 'remains unclear',
      'not yet settled', 'consensus', 'no consensus', 'general agreement', 'widely accepted',
      'commonly believed', 'textbook', 'established',
    ],
  },
  {
    intent: 'theoretical_disagreement',
    signals: [
      'disagreement', 'discrepancy', 'inconsistency', 'contradiction', 'conflict',
      'tension between', 'at odds with', 'incompatible', 'inconsistent with', 'contradicts',
      'different prediction', 'opposite prediction', 'opposite conclusion', 'our result differs',
      'in contrast to', 'contrary to', 'unlike', 'on the other hand', 'however', 'but',
      'nevertheless', 'nonetheless', 'we disagree', 'we find instead', 'improved calculation shows',
      'more careful analysis', 'reanalysis', 'updated analysis', 'revisited', 'reconsidered',
      'corrected', 'error in', 'mistake in', 'flaw', 'overlooked', 'neglected',
      'missing contribution', 'incomplete treatment', 'oversimplified', 'too naive',
      'more realistic', 'refined treatment', 'systematic treatment',
    ],
  },
  {
    intent: 'assumption_discussion',
    signals: [
      'assumption', 'assume', 'assuming', 'under the assumption', 'if we assume',
      'key assumption', 'crucial assumption', 'strong assumption', 'mild assumption',
      'reasonable assumption', 'questionable assumption', 'unjustified assumption',
      'without loss of generality', 'for simplicity', 'simplified', 'idealized', 'in the limit',
      'in the approximation', 'neglecting', 'ignoring', 'dropping', 'setting to zero',
      'treating as small', 'validity', 'validity range', 'range of validity', 'applicable',
      'breaks down', 'no longer valid', 'beyond the scope', 'outside the range', 'extrapolation',
      'interpolation', 'extension', 'generalization', 'relaxing', 'relaxing the assumption',
      'more general', 'general case', 'special case', 'limiting case', 'extreme case',
    ],
  },
  {
    intent: 'tension_discussion',
    signals: [
      'tension', 'discrepancy', 'deviation', 'anomaly', 'puzzle', 'mystery', 'problem',
      'crisis', 'inconsistency', 'disagreement', 'conflict', 'mismatch', 'gap', 'σ tension',
      '2σ', '3σ', '4σ', '5σ', 'nσ discrepancy', 'statistical significance', 'significance level',
      'local significance', 'global significance', 'look-elsewhere effect', 'LEE', 'trials factor',
      'penalized significance', 'Hubble tension', 'H0 tension', 'S8 tension', 'σ8 tension',
      'muon g-2', '(g-2)μ discrepancy', 'Cabibbo angle anomaly', 'CKM unitarity',
      'first-row unitarity', 'Vud puzzle', 'B anomalies', 'flavor anomalies', 'R(K) anomaly',
      'R(D*) anomaly', 'LFUV', 'lepton universality violation', 'W mass anomaly', 'CDF W mass',
      'Lamb shift', 'proton radius puzzle', 'theory-experiment comparison', 'SM prediction vs measurement',
    ],
    caseSensitiveTerms: ['LEE', 'LFUV', 'CKM', 'CDF'],
  },
  {
    intent: 'puzzle_resolution',
    signals: [
      'resolution', 'solution', 'explanation', 'possible explanation', 'potential solution',
      'proposed solution', 'candidate explanation', 'resolves', 'solves', 'explains',
      'accounts for', 'can explain', 'could explain', 'might explain', 'one possibility',
      'another possibility', 'alternative explanation', 'trivial explanation', 'mundane explanation',
      'exciting explanation', 'new physics explanation', 'SM explanation', 'hadronic explanation',
      'nuclear effect', 'radiative correction', 'higher-order effect', 'threshold effect',
      'statistical fluctuation', 'systematic effect', 'experimental issue', 'analysis issue',
      'input issue', 'tension reduced', 'tension remains', 'tension persists', 'tension exacerbated',
      'makes tension worse', 'alleviates tension', 'compatible within 1σ', 'agreement restored',
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 1.13 Emerging Technologies (3 types)
// ═══════════════════════════════════════════════════════════════════════════════

export const EMERGING_TECH_INTENTS: IntentSignalConfig[] = [
  {
    intent: 'machine_learning',
    signals: [
      'machine learning', 'ML', 'artificial intelligence', 'AI', 'neural network', 'NN',
      'deep learning', 'DNN', 'deep neural network', 'CNN', 'convolutional neural network',
      'RNN', 'recurrent neural network', 'LSTM', 'long short-term memory', 'GNN',
      'graph neural network', 'transformer', 'attention mechanism', 'self-attention',
      'multi-head attention', 'autoencoder', 'VAE', 'variational autoencoder', 'GAN',
      'generative adversarial network', 'normalizing flow', 'diffusion model', 'score matching',
      'denoising', 'reinforcement learning', 'RL', 'classification', 'regression', 'clustering',
      'anomaly detection', 'event classification', 'jet tagging', 'particle identification',
      'track reconstruction', 'vertex finding', 'pile-up mitigation', 'fast simulation',
      'surrogate model', 'emulator', 'dimensionality reduction', 'feature extraction',
      'representation learning', 'embedding', 'hyperparameter tuning', 'hyperparameter optimization',
      'Bayesian optimization', 'training', 'validation', 'test set', 'train-test split',
      'overfitting', 'underfitting', 'regularization', 'L1', 'L2', 'dropout', 'batch normalization',
      'layer normalization', 'activation function', 'ReLU', 'sigmoid', 'softmax', 'loss function',
      'cross-entropy', 'MSE', 'optimizer', 'SGD', 'Adam', 'gradient descent', 'backpropagation',
      'physics-informed neural network', 'PINN', 'physics-guided ML', 'equivariant network',
      'Lorentz-equivariant', 'permutation-equivariant', 'symbolic regression', 'interpretable ML',
      'explainable AI', 'XAI', 'attention visualization', 'feature importance', 'SHAP', 'LIME',
      'uncertainty quantification', 'Bayesian neural network', 'ensemble', 'calibration',
    ],
    caseSensitiveTerms: ['ML', 'AI', 'DNN', 'CNN', 'RNN', 'LSTM', 'GNN', 'VAE', 'GAN', 'RL', 'PINN', 'XAI', 'SHAP', 'LIME', 'SGD', 'Adam', 'ReLU', 'MSE'],
  },
  {
    intent: 'quantum_computing',
    signals: [
      'quantum computing', 'quantum computer', 'quantum algorithm', 'quantum circuit',
      'quantum gate', 'CNOT', 'Hadamard', 'Toffoli', 'qubit', 'quantum register', 'superposition',
      'entanglement', 'quantum interference', 'quantum simulation', 'digital quantum simulation',
      'analog quantum simulation', 'Hamiltonian simulation', 'Trotterization', 'product formula',
      'variational quantum eigensolver', 'VQE', 'quantum approximate optimization', 'QAOA',
      'quantum phase estimation', 'QPE', 'quantum machine learning', 'QML', 'quantum kernel',
      'quantum feature map', 'quantum error correction', 'QEC', 'surface code', 'color code',
      'fault-tolerant quantum computing', 'FTQC', 'logical qubit', 'physical qubit', 'error rate',
      'gate fidelity', 'coherence time', 'T1', 'T2', 'noisy intermediate-scale quantum', 'NISQ',
      'error mitigation', 'zero-noise extrapolation', 'probabilistic error cancellation',
      'trapped ion', 'superconducting qubit', 'transmon', 'photonic quantum computing',
      'cold atom', 'neutral atom', 'Rydberg atom', 'quantum dot', 'NV center', 'quantum advantage',
      'quantum supremacy', 'classical simulation', 'tensor network', 'MPS', 'matrix product state',
      'PEPS', 'projected entangled pair state', 'MERA', 'multiscale entanglement renormalization',
      'DMRG', 'density matrix renormalization group', 'iTEBD', 'TEBD', 'quantum Monte Carlo',
      'QMC', 'variational Monte Carlo', 'VMC', 'diffusion Monte Carlo', 'DMC',
      'auxiliary-field QMC', 'AFQMC', 'sign problem', 'phase problem', 'fermion sign problem',
      'complex action problem',
    ],
    caseSensitiveTerms: ['VQE', 'QAOA', 'QPE', 'QML', 'QEC', 'FTQC', 'NISQ', 'MPS', 'PEPS', 'MERA', 'DMRG', 'TEBD', 'iTEBD', 'QMC', 'VMC', 'DMC', 'AFQMC', 'CNOT', 'Hadamard', 'Toffoli', 'Rydberg'],
  },
  {
    intent: 'entanglement_study',
    signals: [
      'entanglement entropy', 'von Neumann entropy', 'Renyi entropy', 'α-Renyi', 'mutual information',
      'conditional mutual information', 'entanglement spectrum', 'entanglement Hamiltonian',
      'modular Hamiltonian', 'modular flow', 'area law', 'volume law', 'logarithmic correction',
      'topological entanglement entropy', 'entanglement negativity', 'entanglement suppression',
      'disentangling', 'quantum decoherence', 'decoherence time', 'environment-induced decoherence',
      'Bell inequality', 'Bell test', 'Bell violation', 'CHSH', 'CHSH inequality', 'loophole',
      'loophole-free', 'local realism', 'hidden variable', 'quantum nonlocality', 'steering',
      'quantum correlation', 'quantum discord', 'classical correlation', 'quantum information',
      'quantum communication', 'quantum cryptography', 'QKD', 'quantum key distribution',
      'quantum teleportation', 'quantum tomography', 'state tomography', 'process tomography',
      'detector tomography', 'quantum state reconstruction', 'Wigner function', 'Husimi function',
      'density matrix', 'reduced density matrix', 'purity', 'fidelity', 'state fidelity',
      'trace distance', 'Uhlmann fidelity', 'quantum channel', 'completely positive', 'CPTP',
      'Kraus operator', 'Lindblad', 'master equation', 'open quantum system', 'quantum thermodynamics',
      'quantum heat engine', 'quantum refrigerator', 'Landauer principle', 'quantum chaos',
      'quantum ergodicity', 'eigenstate thermalization', 'ETH', 'scrambling', 'information scrambling',
      'butterfly effect', 'out-of-time-order correlator', 'OTOC', 'Lyapunov exponent', 'chaos bound',
    ],
    caseSensitiveTerms: ['CHSH', 'QKD', 'CPTP', 'ETH', 'OTOC', 'Renyi', 'von Neumann', 'Wigner', 'Husimi', 'Lindblad', 'Landauer', 'Lyapunov', 'Uhlmann', 'Kraus'],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Legacy Intents (existing, to be preserved)
// ═══════════════════════════════════════════════════════════════════════════════

export const LEGACY_INTENTS: IntentSignalConfig[] = [
  {
    intent: 'measurement',
    signals: [], // Special handling in classifyIntents - uses quantitative patterns
  },
  {
    intent: 'systematic_uncertainty',
    signals: ['systematic error', 'systematic uncertainty', 'systematic effect', 'syst. error', 'syst. uncertainty'],
  },
  {
    intent: 'theory_intro',
    signals: [], // Special handling - requires combination of intro phrases + theory words
  },
  {
    intent: 'comparison',
    signals: [], // Special handling - uses comparison verbs + agreement/disagreement words
  },
  {
    intent: 'historical_review',
    signals: ['history', 'historical', 'early', 'pioneer', 'seminal', 'landmark', 'first', 'original', 'discover', 'found'],
    contextSignals: ['progress', 'development', 'evolution', 'advance', 'milestone'],
  },
  {
    intent: 'methodology',
    signals: ['method', 'technique', 'approach', 'procedure', 'algorithm', 'formalism', 'framework', 'scheme', 'prescription'],
    contextSignals: ['using', 'based on', 'employ', 'apply'],
  },
  {
    intent: 'limitation',
    signals: ['limit', 'caveat', 'restrict', 'constrain', 'bound', 'assumption', 'approximat', 'neglect', 'ignore'],
    contextSignals: ['however', 'although', 'while', 'but', 'yet', 'nevertheless', 'note that', 'caution', 'care'],
  },
  {
    intent: 'future_direction',
    signals: ['future', 'remain', 'open', 'outstand', 'challeng', 'prospect', 'outlook', 'need', 'requir'],
    contextSignals: ['question', 'problem', 'puzzle', 'mystery', 'issue', 'unexplain'],
  },
  {
    intent: 'definition',
    signals: ['defin', 'refer to', 'denot', 'called', 'known as', 'termed', 'mean', 'represent'],
    contextSignals: ['eq.', 'equation', 'formula', 'expression', 'relation'],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Aggregated Intent Signals
// ═══════════════════════════════════════════════════════════════════════════════

export const ALL_INTENT_SIGNALS: IntentSignalConfig[] = [
  ...DISPERSION_ANALYTIC_INTENTS,
  ...NUCLEON_STRUCTURE_INTENTS,
  ...HADRON_SPECTROSCOPY_INTENTS,
  ...SYMMETRY_CHIRAL_INTENTS,
  ...QCD_FOUNDATIONS_INTENTS,
  ...QCD_DYNAMICS_INTENTS,
  ...PRECISION_SM_INTENTS,
  ...BSM_INTENTS,
  ...NUCLEAR_PHYSICS_INTENTS,
  ...JET_PHYSICS_INTENTS,
  ...FEMTOSCOPY_INTENTS,
  ...GENERAL_METHODS_INTENTS,
  ...EMERGING_TECH_INTENTS,
  ...LEGACY_INTENTS,
];

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions for Intent Classification
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a regex pattern for matching signals with word boundaries
 */
function buildSignalPattern(signals: string[], caseSensitiveTerms?: string[]): RegExp {
  const caseSensitiveSet = new Set(caseSensitiveTerms ?? []);
  
  // Separate case-sensitive and case-insensitive patterns
  const caseInsensitive: string[] = [];
  const caseSensitive: string[] = [];
  
  for (const signal of signals) {
    const escaped = escapeRegex(signal);
    // Check if any case-sensitive term is contained in this signal
    let isCaseSensitive = false;
    for (const term of caseSensitiveSet) {
      if (signal.includes(term)) {
        isCaseSensitive = true;
        break;
      }
    }
    
    if (isCaseSensitive) {
      caseSensitive.push(escaped);
    } else {
      caseInsensitive.push(escaped);
    }
  }
  
  // Build combined pattern - case-insensitive patterns get (?i:...) wrapper in theory,
  // but JS doesn't support inline flags, so we'll handle this differently
  // For now, return case-insensitive regex and handle case-sensitive terms separately
  const pattern = signals.map(escapeRegex).join('|');
  return new RegExp(`\\b(?:${pattern})\\b`, 'i');
}

/**
 * Pre-compiled patterns for each intent config
 */
const intentPatternCache = new Map<string, RegExp>();

/**
 * Get or create compiled pattern for an intent config
 */
export function getIntentPattern(config: IntentSignalConfig): RegExp | null {
  if (config.signals.length === 0) return null;
  
  const cacheKey = config.intent;
  let pattern = intentPatternCache.get(cacheKey);
  
  if (!pattern) {
    pattern = buildSignalPattern(config.signals, config.caseSensitiveTerms);
    intentPatternCache.set(cacheKey, pattern);
  }
  
  return pattern;
}

/**
 * Match text against all intent configurations
 * Returns array of matched intent names
 */
export function matchIntents(text: string): string[] {
  const matched = new Set<string>();
  const lower = text.toLowerCase();
  
  for (const config of ALL_INTENT_SIGNALS) {
    // Skip legacy intents with special handling
    if (config.signals.length === 0) continue;
    
    // Check min length
    if (config.minLength && text.length < config.minLength) continue;
    
    // Check exclusions
    if (config.exclusions) {
      const excluded = config.exclusions.some(excl => lower.includes(excl.toLowerCase()));
      if (excluded) continue;
    }
    
    // Try to match signals
    const pattern = getIntentPattern(config);
    if (pattern && pattern.test(text)) {
      // If context signals exist, require at least one
      if (config.contextSignals && config.contextSignals.length > 0) {
        const hasContext = config.contextSignals.some(ctx => 
          lower.includes(ctx.toLowerCase())
        );
        if (!hasContext) continue;
      }
      matched.add(config.intent);
    }
  }
  
  return Array.from(matched).sort();
}
