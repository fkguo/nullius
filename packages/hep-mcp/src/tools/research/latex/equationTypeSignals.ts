/**
 * Equation Type Signal Words for Physics Formula Classification
 * 
 * This module provides data-driven classification of equations in HEP literature
 * by their physical content type (not just LaTeX environment type).
 * 
 * Contains 120+ equation types organized in 19 categories.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface EquationTypeSignalConfig {
  /** Equation type identifier */
  type: string;
  /** Signal words that indicate this equation type (in context) */
  signals: string[];
  /** Signal patterns in the equation LaTeX itself */
  latexPatterns?: string[];
  /** Case-sensitive terms */
  caseSensitiveTerms?: string[];
}

export type EquationType =
  // Basic Types (10)
  | 'definition'
  | 'derivation_step'
  | 'result'
  | 'constraint'
  | 'relation'
  | 'approximation'
  | 'identity'
  | 'ansatz'
  | 'normalization'
  | 'boundary_condition'
  // Field Theory Foundations (10)
  | 'lagrangian'
  | 'hamiltonian'
  | 'action'
  | 'equation_of_motion'
  | 'propagator'
  | 'vertex'
  | 'feynman_rule'
  | 'green_function'
  | 'correlator'
  | 'spectral_function'
  // Symmetry & Conservation (7)
  | 'symmetry_transformation'
  | 'conserved_current'
  | 'conservation_law'
  | 'anomaly'
  | 'ward_identity'
  | 'breaking_term'
  | 'goldstone_theorem'
  // Scattering & Decay (12)
  | 'amplitude'
  | 'cross_section'
  | 'decay_rate'
  | 'branching_ratio'
  | 'matrix_element'
  | 'form_factor'
  | 'phase_shift'
  | 'optical_theorem'
  | 'breit_wigner'
  | 'k_matrix'
  | 'phase_space'
  | 'threshold'
  // Analytic Methods (9)
  | 'dispersion'
  | 'partial_wave'
  | 'unitarity'
  | 'crossing'
  | 'analyticity'
  | 'riemann_sheet'
  | 'pole_residue'
  | 'omnes'
  | 'roy_equation'
  // Sum Rules & OPE (6)
  | 'sum_rule'
  | 'superconvergence'
  | 'ope'
  | 'wilson_coefficient'
  | 'condensate'
  | 'twist_expansion'
  // Renormalization (8)
  | 'rge'
  | 'beta_function'
  | 'anomalous_dimension'
  | 'evolution'
  | 'running'
  | 'matching'
  | 'counterterm'
  | 'renormalization'
  // Perturbative QCD (15)
  | 'fixed_order'
  | 'loop_integral'
  | 'master_integral'
  | 'splitting_function'
  | 'sudakov'
  | 'soft_function'
  | 'jet_function'
  | 'beam_function'
  | 'hard_function'
  | 'plus_distribution'
  | 'ir_divergence'
  | 'uv_divergence'
  | 'collinear_singularity'
  | 'resummation_formula'
  | 'cusp_anomalous_dim'
  // Nucleon/Meson Structure (16)
  | 'pdf_definition'
  | 'pdf_parametrization'
  | 'gpd_definition'
  | 'tmd_definition'
  | 'distribution_amplitude'
  | 'compton_form_factor'
  | 'structure_function'
  | 'moment'
  | 'evolution_kernel'
  | 'factorization_theorem'
  | 'hard_scattering'
  | 'coefficient_function'
  | 'ji_sum_rule'
  | 'bjorken_sum_rule'
  | 'gls_sum_rule'
  | 'burkhardt_cottingham'
  // Effective Theory (5)
  | 'power_expansion'
  | 'chiral_expansion'
  | 'heavy_quark_expansion'
  | 'low_energy_theorem'
  | 'soft_theorem'
  // Lattice QCD (4)
  | 'luescher_formula'
  | 'lattice_correlator'
  | 'extrapolation'
  | 'finite_volume'
  // Functional Methods (9)
  | 'dyson_schwinger'
  | 'bethe_salpeter'
  | 'faddeev'
  | 'schwinger_function'
  | 'gap_equation'
  | 'quark_propagator'
  | 'gluon_propagator'
  | 'vertex_function'
  | 'rainbow_ladder'
  // Supersymmetry (10)
  | 'susy_transformation'
  | 'superfield'
  | 'superpotential'
  | 'bps_condition'
  | 'central_charge'
  | 'soft_breaking'
  | 'kahler_potential'
  | 'd_term'
  | 'f_term'
  | 'gaugino_mass'
  // Conformal Field Theory (10)
  | 'conformal_block'
  | 'ope_coefficient'
  | 'conformal_dimension'
  | 'bootstrap_equation'
  | 'crossing_equation'
  | 'virasoro'
  | 'conformal_ward'
  | 'primary_operator'
  | 'descendant'
  | 'modular_invariance'
  // String Theory & Gravity (10)
  | 'worldsheet'
  | 'vertex_operator'
  | 'string_amplitude'
  | 'bcj_relation'
  | 'klt_relation'
  | 'ads_cft'
  | 'holographic'
  | 't_hooft_expansion'
  | 'planar_limit'
  | 'graviton_amplitude'
  // Topology & Anomalies (9)
  | 'chern_simons'
  | 'wess_zumino'
  | 'topological_charge'
  | 'instanton_action'
  | 'theta_term'
  | 'anomaly_matching'
  | 'index_theorem'
  | 'atiyah_singer'
  | 'pontryagin'
  // Thermodynamics (5)
  | 'equation_of_state'
  | 'partition_function'
  | 'free_energy'
  | 'pressure'
  | 'susceptibility'
  // Experimental Fitting (6)
  | 'fit_function'
  | 'line_shape'
  | 'background'
  | 'resolution'
  | 'efficiency'
  | 'parametrization'
  // Mathematical Structure (5)
  | 'recurrence'
  | 'integral_representation'
  | 'series_expansion'
  | 'asymptotic'
  | 'factorization';

// ═══════════════════════════════════════════════════════════════════════════════
// Signal Word Configurations by Category
// ═══════════════════════════════════════════════════════════════════════════════

/** Basic Types */
export const BASIC_TYPE_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'definition',
    signals: [
      'we define', 'is defined as', 'definition of', 'denote by', 'let ... be',
      'defined by', 'we introduce', 'is given by', 'define',
    ],
    latexPatterns: ['≡', ':=', '\\equiv', '\\triangleq'],
  },
  {
    type: 'derivation_step',
    signals: [
      'it follows', 'we have', 'which gives', 'this leads to', 'combining',
      'inserting', 'substituting into', 'using the fact', 'from which',
      'thus', 'therefore', 'hence',
    ],
  },
  {
    type: 'result',
    signals: [
      'we obtain', 'we find', 'the result is', 'our main result', 'final result',
      'this gives', 'yields', 'we arrive at', 'the answer is', 'our result',
      'key result', 'main result', 'central result',
    ],
  },
  {
    type: 'constraint',
    signals: [
      'constraint', 'must satisfy', 'subject to', 'provided that', 'condition',
      'requirement', 'restricted to', 'bounded by', 'constrained by',
    ],
  },
  {
    type: 'relation',
    signals: [
      'relation', 'related by', 'connection between', 'relationship', 'linked to',
      'proportional to', 'scales as', 'related to',
    ],
  },
  {
    type: 'approximation',
    signals: [
      'approximately', 'to leading order', 'in the limit', 'for small',
      'for large', 'neglecting', 'ignoring', 'approximate', 'leading approximation',
    ],
    latexPatterns: ['≈', '~', '\\approx', '\\sim', '\\simeq'],
  },
  {
    type: 'identity',
    signals: [
      'identity', 'identically', 'Ward identity', 'Slavnov-Taylor', 'always holds',
      'for all', 'holds exactly', 'exact identity',
    ],
  },
  {
    type: 'ansatz',
    signals: [
      'ansatz', 'we assume', 'parametrize as', 'trial function', 'assumed form',
      'we take', 'our ansatz', 'parameterize as',
    ],
  },
  {
    type: 'normalization',
    signals: [
      'normalization', 'normalized to', 'normalization condition', 'unit norm',
      'normalisation', 'normalised to',
    ],
    latexPatterns: ['\\int.*=\\s*1', '\\langle.*\\rangle\\s*=\\s*1'],
  },
  {
    type: 'boundary_condition',
    signals: [
      'boundary condition', 'at the boundary', 'initial condition',
      'asymptotic behavior', 'asymptotic behaviour', 'as x→∞', 'as x→0',
    ],
  },
  {
    type: 'numerical_value',
    signals: [
      'numerical value', 'numerically', 'the value is', 'we get', 'equals',
    ],
    // Match patterns like g^2/4\pi = 14.28 or \sigma = (15.2 ± 0.4)
    latexPatterns: [
      '=\\s*\\d+\\.\\d+',             // = 14.28
      '=\\s*\\(\\s*\\d+\\.\\d+\\s*\\\\pm', // = (15.2 \pm
      '=\\s*-?\\d+\\.\\d+\\s*\\\\,',   // = -1.46\,
    ],
  },
  {
    type: 'matrix_equation',
    signals: [
      'matrix', 'determinant', 'eigenvalue', 'eigenvector', 'diagonalize',
      'matrix element', 'matrix form',
    ],
    latexPatterns: [
      '\\\\begin\\{pmatrix\\}',        // \begin{pmatrix}
      '\\\\begin\\{bmatrix\\}',        // \begin{bmatrix}
      '\\\\begin\\{Bmatrix\\}',        // \begin{Bmatrix}
      '\\\\det\\s*\\\\',               // \det\
      '\\\\det\\s*\\(',                // \det(
    ],
  },
  {
    type: 'radius',
    signals: [
      'radius', 'charge radius', 'mean square radius', 'rms radius',
      'proton radius', 'mass radius',
    ],
    latexPatterns: [
      '\\\\langle\\s*r\\^\\{?2\\}?\\s*\\\\rangle',  // \langle r^2 \rangle
      'r_\\{?[Eemsc]\\}?',             // r_E, r_m, r_s, r_c
    ],
  },
  {
    type: 'potential',
    signals: [
      'potential', 'Yukawa potential', 'Coulomb potential', 'interaction potential',
      'effective potential', 'central potential', 'static potential',
    ],
    latexPatterns: [
      'V\\s*\\(\\s*r\\s*\\)',           // V(r)
      'V\\s*\\(\\s*\\\\vec\\{?r',       // V(\vec{r}
      '\\\\frac\\{.*\\}\\{r\\}\\s*e\\^\\{?-', // Yukawa: 1/r * e^-
      '\\\\frac\\{\\\\alpha.*\\}\\{r\\}', // Coulomb: alpha/r
    ],
    caseSensitiveTerms: ['Yukawa', 'Coulomb'],
  },
  {
    type: 'differential_equation',
    signals: [
      'differential equation', 'ODE', 'PDE', 'second-order equation',
    ],
    latexPatterns: [
      '\\\\frac\\{d\\^?\\{?2\\}?.*\\}\\{d\\s*[xtr]', // d^2/dx^2, d/dr
      '\\\\frac\\{\\\\partial\\^?\\{?2\\}?.*\\}\\{\\\\partial', // partial derivatives
      '\\\\nabla\\^\\{?2\\}?',           // \nabla^2
      '\\\\partial_\\{?[\\\\mu txr]',    // \partial_\mu, \partial_t
    ],
  },
  {
    type: 'bra_ket',
    signals: [
      'matrix element', 'expectation value', 'overlap', 'transition amplitude',
    ],
    latexPatterns: [
      '\\\\langle\\s*[pPnN].*\\|.*\\|.*[pPnN].*\\\\rangle', // <p'|O|p>
      '\\\\langle.*\\|\\s*J.*\\|.*\\\\rangle',  // <|J|>
      '\\\\bar\\{?[NuU]\\}?.*\\\\Gamma',  // \bar{N} \Gamma
      '\\\\bar\\{?q\\}?.*\\\\gamma',      // \bar{q} \gamma
    ],
  },
  {
    type: 'current_operator',
    signals: [
      'current', 'electromagnetic current', 'axial current', 'vector current',
      'hadronic current', 'quark current',
    ],
    latexPatterns: [
      'J\\^\\{?[\\\\mu\\+\\-0]',         // J^\mu, J^+, J^-
      'J_\\{?[\\\\mu em axial vec]',     // J_\mu, J_{em}
      '\\\\bar\\{?[qQ]\\}?\\s*\\\\gamma.*[qQ]', // \bar{q} \gamma q
    ],
  },
  {
    type: 'integral_form',
    signals: [
      'integral', 'integration over', 'integrate', 'convolution',
    ],
    latexPatterns: [
      '\\\\int\\s*\\\\frac\\{d\\^?\\{?[234]\\}?',  // \int d^3, d^4
      '\\\\int.*\\\\frac\\{.*\\}\\{.*\\}.*d[^a-z]', // integral with measure
      '\\\\oint',                        // contour integral
      '\\\\int\\\\limits',               // integral with limits
    ],
  },
  {
    type: 'exponential_decay',
    signals: [
      'exponential', 'decay', 'damping', 'suppression',
    ],
    latexPatterns: [
      'e\\^\\{?-[^}]*[mrkt]',            // e^{-mr}, e^{-kt}
      '\\\\exp\\s*\\(\\s*-',             // \exp(-
    ],
  },
  {
    type: 'trigonometric',
    signals: [
      'trigonometric', 'phase', 'oscillation', 'periodic',
    ],
    latexPatterns: [
      '\\\\sin\\s*\\\\pi',               // \sin\pi
      '\\\\cos\\s*\\\\pi',               // \cos\pi
      '\\\\sin\\^\\{?2\\}?',             // \sin^2
      '\\\\cos\\^\\{?2\\}?',             // \cos^2
      'e\\^\\{?i[^}]*\\\\pi',            // e^{i\pi}
    ],
  },
  {
    type: 'evolution_equation',
    signals: [
      'evolution', 'DGLAP', 'RGE', 'renormalization group', 'running',
      'anomalous dimension', 'evolution equation',
    ],
    latexPatterns: [
      '\\\\frac\\{d.*\\}\\{d\\s*\\\\ln\\s*\\\\mu',  // d.../d ln\mu
      '\\\\mu\\^\\{?2\\}?\\s*\\\\frac\\{d',          // \mu^2 d/d
      '\\\\frac\\{d.*\\}\\{d\\s*\\\\ln\\s*Q',        // d.../d ln Q
      '\\\\gamma_\\{?[a-zA-Z]',                       // \gamma_T, \gamma_q
      '\\\\beta\\s*\\(',                              // \beta(
    ],
    caseSensitiveTerms: ['DGLAP', 'RGE'],
  },
  {
    type: 'density_function',
    signals: [
      'density', 'distribution', 'probability density', 'charge density',
      'matter density', 'parton density',
    ],
    latexPatterns: [
      '\\\\rho\\s*\\(\\s*[brx]',          // \rho(b), \rho(r), \rho(x)
      '\\\\rho_\\{?[pnqT]',               // \rho_p, \rho_n, \rho_q
      'f_\\{?[qg]\\}?\\s*\\(\\s*x',       // f_q(x), f_g(x)
    ],
  },
  {
    type: 'fourier_transform',
    signals: [
      'Fourier', 'transform', 'Bessel function', 'Hankel transform',
    ],
    latexPatterns: [
      '\\\\int.*J_\\{?[01]\\}?\\s*\\(',   // \int ... J_0(, J_1(
      '\\\\int.*e\\^\\{?[+-]?i.*[kpq]',   // \int ... e^{ikx}
      '\\\\mathcal\\{F\\}',               // \mathcal{F}
    ],
    caseSensitiveTerms: ['Fourier', 'Bessel', 'Hankel'],
  },
  {
    type: 'spinor_state',
    signals: [
      'spinor', 'helicity state', 'polarization', 'spin state',
    ],
    latexPatterns: [
      '\\|\\s*\\\\lambda\\s*=',           // |\lambda =
      '\\|\\s*s_\\{?\\\\perp',            // |s_\perp
      '\\|\\s*[+-]\\s*\\\\frac\\{1\\}\\{2\\}', // |+1/2>, |-1/2>
      '\\\\langle\\s*[+-]\\s*\\|',        // <+|, <-|
    ],
  },
  {
    type: 'gpd_tmd',
    signals: [
      'GPD', 'TMD', 'generalized parton', 'transverse momentum dependent',
      'Compton form factor', 'skewness',
    ],
    latexPatterns: [
      '[HE]\\^\\{?[qg]\\}?\\s*\\(\\s*x\\s*,\\s*[t\\\\xi]', // H^q(x, t), E^q(x, \xi)
      '\\\\widetilde\\{?[HE]\\}?',        // \widetilde{H}
      'f_\\{?1\\}?\\^\\{?\\\\perp',       // f_1^\perp (Sivers)
      'h_\\{?1\\}?\\^\\{?\\\\perp',       // h_1^\perp (Boer-Mulders)
    ],
    caseSensitiveTerms: ['GPD', 'TMD', 'Sivers', 'Boer-Mulders'],
  },
  {
    type: 'small_x_limit',
    signals: [
      'small x', 'x→0', 'Regge', 'BFKL', 'pomeron', 'high energy limit',
    ],
    latexPatterns: [
      '\\\\log\\s*\\\\frac\\{1\\}\\{x\\}', // \log(1/x)
      'x\\s*\\\\to\\s*0',                  // x \to 0
      '\\\\alpha.*\\\\log',                // \alpha \log
    ],
    caseSensitiveTerms: ['Regge', 'BFKL'],
  },
  {
    type: 'splitting_function',
    signals: [
      'splitting function', 'DGLAP kernel', 'Altarelli-Parisi', 'evolution kernel',
    ],
    latexPatterns: [
      'P_\\{?[qg]',                        // P_q, P_g, P_{qq}
      '\\\\widehat\\{?P\\}?',              // \widehat{P}
      'P\\s*\\(\\s*\\\\frac\\{x\\}\\{z\\}', // P(x/z)
    ],
    caseSensitiveTerms: ['Altarelli-Parisi'],
  },
  {
    type: 'color_factor',
    signals: [
      'color factor', 'Casimir', 'color algebra', 'SU(N)',
    ],
    latexPatterns: [
      'C_\\{?[FAR]\\}?',                   // C_F, C_A, C_R
      'T_\\{?[FR]\\}?',                    // T_F, T_R
      'n_\\{?f\\}?',                       // n_f (number of flavors)
    ],
  },
  {
    type: 'jet_function',
    signals: [
      'jet function', 'soft function', 'beam function', 'hard function',
      'matching coefficient', 'Wilson coefficient',
    ],
    latexPatterns: [
      '\\\\vec\\{J\\}',                    // \vec{J}
      'J\\s*\\(\\s*\\\\ln',                // J(\ln...)
      'S\\s*\\(\\s*\\\\mu',                // S(\mu...)
      'H\\s*\\(\\s*Q',                     // H(Q...)
    ],
  },
  {
    type: 'cft_correlator',
    signals: [
      'correlator', 'conformal block', 'CFT', 'four-point function',
      'conformal field theory', 'OPE',
    ],
    latexPatterns: [
      '\\\\mathcal\\{G\\}\\s*\\^?\\{?[tu]',  // \mathcal{G}^t
      '\\\\mm\\{[GMF]\\}\\s*\\(',            // \mm{G}(, \mm{M}(
      '\\\\langle.*\\\\rangle\\s*=\\s*\\\\frac\\{1\\}', // correlator = 1/...
      '\\\\boxed\\{',                        // \boxed{
    ],
    caseSensitiveTerms: ['CFT', 'OPE'],
  },
  {
    type: 'normalization_integral',
    signals: [
      'normalization', 'sum rule constraint', 'completeness',
    ],
    latexPatterns: [
      '\\\\int.*dx.*=\\s*\\\\rho',          // \int dx ... = \rho
      '\\\\int.*=\\s*1',                     // \int ... = 1
      '\\\\sum_\\{?[qQ]\\}?.*=\\s*1',        // \sum_q ... = 1
    ],
  },
  {
    type: 'moment_definition',
    signals: [
      'moment', 'mean', 'variance', 'average',
    ],
    latexPatterns: [
      '\\\\langle\\s*[brkx]\\^\\{?[2n]\\}?\\s*\\\\rangle', // <b^2>, <r^n>
      '\\\\langle.*\\\\rangle\\^\\{?[qg]\\}?\\s*\\(\\s*x', // <...>^q(x)
    ],
  },
  {
    type: 'experimental_value',
    signals: [
      'experimental', 'measured', 'measurement', 'world average',
      'PDG value', 'Run', 'combined result',
    ],
    latexPatterns: [
      'a_\\{?\\\\mu\\}?.*=.*\\\\pm',         // a_\mu = ... \pm
      '\\\\text\\{exp\\}.*=',                // \text{exp} =
      '\\\\text\\{Run',                      // \text{Run-...}
    ],
  },
  {
    type: 'log_parametrization',
    signals: [
      'logarithmic', 'log behavior', 'parametrization',
    ],
    latexPatterns: [
      '=\\s*[a-z]\\s*\\\\ln\\s*\\\\frac\\{1\\}', // = a \ln(1/...)
      '\\\\ln\\s*\\\\frac\\{1\\}\\{[xz]\\}',     // \ln(1/x)
      '\\\\to.*\\\\log',                          // \to ... \log
      '=\\s*[a-z]\\s*\\\\ln\\s*1\\s*/\\s*[xz]',  // = a \ln 1/x
      '[B]\\s*\\(?\\s*x\\s*\\)?\\s*=\\s*[a-z]\\s*\\\\ln', // B(x) = a \ln
    ],
  },
  {
    type: 'cft_dimension',
    signals: [
      'conformal dimension', 'scaling dimension', 'twist',
    ],
    latexPatterns: [
      '\\\\Delta_\\{?[1234]\\}?',             // \Delta_1, \Delta_2
      '\\\\tfrac\\{1\\}\\{2\\}.*\\\\Delta',   // (1/2)(...\Delta...)
      '\\\\D_\\{?[1234]\\}?',                 // \D_1 (shorthand)
    ],
  },
  {
    type: 'sum_over_states',
    signals: [
      'sum over states', 'spectral sum', 'completeness relation',
    ],
    latexPatterns: [
      '\\\\sum_\\{?[qnl]\\}?.*e_\\{?[q]\\}?', // \sum_q e_q
      '\\\\sum_\\{?\\\\lambda\\}?',           // \sum_\lambda
      '\\\\sum_\\{?n\\}?.*\\|n\\\\rangle',    // \sum_n |n>
    ],
  },
  {
    type: 'conformal_cross_ratio',
    signals: [
      'cross ratio', 'conformal invariant', 'cross-ratio',
    ],
    latexPatterns: [
      '[uv]\\s*=\\s*z\\s*\\\\bar\\{?z\\}?',   // u = z\bar{z}
      '[uv]\\s*=.*x\\^\\{?2\\}?_\\{?\\d',     // u = x^2_{12}...
      '\\(1-z\\)\\(1-\\\\bar\\{?z\\}?\\)',    // (1-z)(1-\bar{z})
    ],
  },
  {
    type: 'ope_coefficient',
    signals: [
      'OPE coefficient', 'structure constant', 'three-point function',
    ],
    latexPatterns: [
      'f_\\{?\\d+.*\\\\mm\\{O\\}',            // f_{12\mm{O}...}
      'c\\s*\\(\\s*J\\s*,\\s*\\\\D',          // c(J, \Delta)
      '\\\\Res_\\{?\\\\D',                    // \Res_{\Delta...}
      'C_\\{?\\d+\\d+\\d+\\}?',               // C_{123}
    ],
    caseSensitiveTerms: ['OPE'],
  },
  {
    type: 'integral_kernel',
    signals: [
      'kernel', 'integration kernel', 'convolution kernel',
    ],
    latexPatterns: [
      'K\\s*\\(\\s*z\\s*,\\s*\\\\bar\\{?z',   // K(z, \bar{z}, ...)
      '\\\\k_\\{?[J\\\\D]',                    // \kappa_{J+\Delta}
      'k_\\{?\\\\D[+-]',                       // k_{\Delta+J}
    ],
  },
  {
    type: 'isospin_decomposition',
    signals: [
      'isospin', 'flavor decomposition', 'quark content',
    ],
    latexPatterns: [
      'F_\\{?1\\}?\\^\\{?[ud]\\}?\\s*=.*F_\\{?1[pn]\\}?', // F_1^u = 2F_{1p} + F_{1n}
      '[FGH]\\^\\{?[uds]\\}?.*=.*[FGH]_\\{?[pn]\\}?',     // G^u = ... G_p
    ],
  },
  {
    type: 'rosenbluth',
    signals: [
      'Rosenbluth', 'reduced cross section', 'epsilon dependence',
    ],
    latexPatterns: [
      '\\\\sigma_\\{?M\\}?.*G\\^\\{?2\\}?_\\{?[EM]\\}?', // \sigma_M ... G_E^2
      '\\\\epsilon.*G\\^\\{?2\\}?_\\{?M\\}?',            // \epsilon G_M^2
      '\\\\tau.*G\\^\\{?2\\}?',                          // \tau G^2
    ],
    caseSensitiveTerms: ['Rosenbluth'],
  },
  {
    type: 'polarization_asymmetry',
    signals: [
      'asymmetry', 'polarization observable', 'analyzing power',
    ],
    latexPatterns: [
      'A_\\{?exp\\}?\\s*=',                   // A_{exp} =
      'P_\\{?[bt]\\}?.*A',                    // P_b P_t A
      'A_\\{?[LTN]\\}?\\s*=',                 // A_L, A_T, A_N
    ],
  },
  {
    type: 'wilson_line',
    signals: [
      'Wilson line', 'gauge link', 'path-ordered', 'staple',
    ],
    latexPatterns: [
      'W\\s*\\[',                              // W[...]
      'W\\s*\\(',                              // W(...)
      'P\\s*\\\\exp',                          // P\exp
      '\\\\mathcal\\{P\\}.*\\\\exp',           // \mathcal{P}\exp
    ],
    caseSensitiveTerms: ['Wilson'],
  },
  {
    type: 'soft_factor',
    signals: [
      'soft factor', 'soft function', 'eikonal', 'soft gluon',
    ],
    latexPatterns: [
      '\\\\tilde\\{S\\}',                      // \tilde{S}
      'S_\\{?0\\}?\\s*\\(',                    // S_0(
      'S_\\{?soft\\}?',                        // S_{soft}
    ],
  },
  {
    type: 'rapidity_variable',
    signals: [
      'rapidity', 'Collins-Soper', 'zeta parameter',
    ],
    latexPatterns: [
      '\\\\zeta_\\{?[DF]\\}?\\s*=',            // \zeta_D =, \zeta_F =
      'y_\\{?[AB]\\}?',                        // y_A, y_B
      'e\\^\\{?[+-]?\\d?y',                    // e^{2y}, e^{-y}
    ],
    caseSensitiveTerms: ['Collins-Soper'],
  },
  {
    type: 'kinematic_relation',
    signals: [
      'kinematic', 'Mandelstam', 'momentum conservation',
    ],
    latexPatterns: [
      's\\s*\\+\\s*t\\s*\\+\\s*u\\s*=',        // s + t + u =
      'q\\^\\{?2\\}?\\s*=\\s*-Q\\^\\{?2\\}?',  // q^2 = -Q^2
      'v_\\{?[z]\\}?\\s*=',                    // v_z =
    ],
  },
  {
    type: 'equation_reference',
    signals: [
      'equation', 'Eq.',
    ],
    latexPatterns: [
      '\\\\quad\\s*\\\\quad',                  // double quad (spacing)
      '=\\s*\\\\cdots',                        // = \cdots
    ],
  },
  {
    type: 'conformal_kernel',
    signals: [
      'kernel', 'conformal kernel', 'Mellin kernel',
    ],
    latexPatterns: [
      'K_\\{?[BC]\\}?\\s*\\^?\\{?.*\\}?\\s*\\(', // K_B(, K_C(, K_B^{(d=2)}
      'K\\s*\\(.*z.*\\\\bar\\{?z\\}?.*w.*\\\\bar\\{?w\\}?', // K(z, \bar{z}, w, \bar{w})
      'k_\\{?[\\\\D J+-]',                      // k_{\Delta}, k_J
    ],
  },
  {
    type: 'sum_product_series',
    signals: [
      'sum', 'product', 'series', 'summation',
    ],
    latexPatterns: [
      '\\\\sum_\\{?J\\s*=',                    // \sum_{J=
      '\\\\sum_\\{?[J\\\\ell n]\\}?\\s*\\\\frac\\{', // \sum_J \frac{
      '\\\\prod_\\{?[ijn]',                    // \prod_{i...}
      '\\\\Jsum',                              // \Jsum (custom macro)
    ],
  },
  {
    type: 'complex_fraction',
    signals: [
      'ratio', 'quotient',
    ],
    latexPatterns: [
      '\\\\frac\\{.*\\\\frac\\{',              // nested fractions
      '\\\\left\\(\\\\frac\\{',               // \left(\frac{
      '\\\\frac\\{\\(1-[zwuv]\\)',             // \frac{(1-z)...
    ],
  },
  {
    type: 'multivariate_function',
    signals: [
      'function', 'multivariate',
    ],
    latexPatterns: [
      '\\\\mm\\{[GFSD]\\}\\s*\\(\\s*[zwuv]',   // \mm{G}(z, ...
      '[KFGS]\\s*\\^?\\{?.*\\}?\\s*\\(.*,.*,.*,', // F(a, b, c, d)
      '\\\\mathcal\\{[GFSD]\\}\\s*\\(',        // \mathcal{G}(
    ],
  },
  {
    type: 'power_law',
    signals: [
      'power', 'scaling', 'exponent',
    ],
    latexPatterns: [
      '[zwuv]\\^\\{?[pq\\\\frac]',             // z^{p_1}, w^{\frac{
      '\\\\left\\(.*\\\\right\\)\\^\\{?\\\\frac\\{', // (...)^{\frac{
      '[rwz]\\^\\{?[+-]?\\\\frac\\{[J\\\\D]',  // r^{\frac{J}{2}}
    ],
  },
  {
    type: 'constraint_equation',
    signals: [
      'constraint', 'condition', 'vanishes',
    ],
    latexPatterns: [
      '\\s*=\\s*0\\s*$',                       // ... = 0 (at end)
      '\\\\qquad\\s*\\\\text\\{for\\}',        // \qquad\text{for}
    ],
  },
  {
    type: 'casimir_equation',
    signals: [
      'Casimir', 'differential operator', 'eigenvalue equation',
    ],
    latexPatterns: [
      '\\\\mathcal\\{D\\}_\\{?[24]\\}?',       // \mathcal{D}_2, \mathcal{D}_4
      '\\\\D_\\{?[24]\\}?.*S',                 // \D_2 S, \D_4 S
    ],
  },
  {
    type: 'variable_substitution',
    signals: [
      'substitution', 'change of variables', 'transformation',
    ],
    latexPatterns: [
      'x\\s*=\\s*\\\\frac\\{.*\\}\\{.*\\}',    // x = \frac{...}{...}
      '[xy]\\s*&?\\s*=.*\\\\r[zwuv]',          // x = ... \rho z ...
      '1-x\\s*=',                              // 1-x = 
    ],
  },
  {
    type: 'special_value',
    signals: [
      'special point', 'boundary value', 'limit',
    ],
    latexPatterns: [
      'x\\s*&?\\s*=\\s*0\\s*:',                // x = 0:
      'x\\s*&?\\s*=\\s*1\\s*:',                // x = 1:
      '\\\\eta_\\{?[w]\\}?\\s*\\\\in\\s*\\\\\\{', // \eta_w \in \{
    ],
  },
  {
    type: 'algebraic_identity',
    signals: [
      'identity', 'algebraic relation',
    ],
    latexPatterns: [
      '\\\\left\\(.*\\\\right\\)\\s*=\\s*\\\\left\\(', // (...) = (...)
      '\\\\frac\\{1\\}\\{[zwuv]\\}\\s*\\+\\s*\\\\frac\\{1\\}', // 1/z + 1/w
    ],
  },
  {
    type: 'polynomial_fit',
    signals: [
      'polynomial', 'fit', 'parametrization', 'expansion',
    ],
    latexPatterns: [
      '\\\\sum_\\{?i\\s*=\\s*1\\}?.*z\\^\\{?i\\}?',    // \sum_{i=1} ... z^i
      'p_\\{?[0i]\\}?.*z\\^\\{?[in]\\}?',              // p_0 ... z^n
      '1\\s*\\+\\s*\\\\sum',                           // 1 + \sum
      'f_\\{?poly\\}?',                                // f_{poly}
    ],
  },
  {
    type: 'hydrogen_energy',
    signals: [
      'Rydberg', 'hydrogen', 'energy level', 'fine structure', 'Lamb shift',
    ],
    latexPatterns: [
      'E_\\{?n\\}?\\s*=\\s*-?\\s*\\\\frac\\{m.*\\\\alpha', // E_n = -m\alpha^2/...
      'E_\\{?nj\\}?\\s*=',                              // E_{nj} =
      'R_\\{?\\\\infty\\}?\\s*=',                       // R_\infty =
      'E_\\{?n\\}?\\s*=\\s*-\\s*\\{?\\\\frac\\{m',      // E_n = -{\frac{m...
      '\\\\frac\\{m.*\\\\alpha\\^\\{?2\\}?\\}\\{.*n\\^\\{?2\\}?\\}', // \frac{m\alpha^2}{2n^2}
    ],
    caseSensitiveTerms: ['Rydberg', 'Lamb'],
  },
  {
    type: 'experimental_measurement',
    signals: [
      'measurement', 'experimental result', 'uncertainty',
    ],
    latexPatterns: [
      '\\\\langle\\s*r\\^\\{?2\\}?.*\\\\rangle\\^\\{?1/2\\}?\\s*&?=?\\s*\\d', // <r^2>^{1/2} = 0.879
      '\\\\pm\\s*\\d+\\.\\d+',                          // \pm 0.010
      '\\(\\d+\\)_\\{?\\\\rm',                          // (5)_{\rm stat}
      '\\{\\\\rm\\s*[fmGeV]',                           // {\rm fm}, {\rm GeV}
      '\\{\\\\rm\\s*m\\}\\^\\{?-1\\}?',                 // {\rm m}^{-1}
      '\\\\nu_\\{?[ts]\\}?\\s*&?=',                     // \nu_t =, \nu_s =
    ],
  },
  {
    type: 'static_property',
    signals: [
      'static property', 'magnetic moment', 'quadrupole moment', 'charge',
    ],
    latexPatterns: [
      'G_\\{?[CMQ][dm]\\}?\\s*\\(?0\\)?\\s*=',          // G_{Cd}(0) =
      '\\\\mu_\\{?[dpn]\\}?',                           // \mu_d, \mu_p
      'Q_\\{?[dpn]\\}?',                                // Q_d
    ],
  },
  {
    type: 'convolution_integral',
    signals: [
      'convolution', 'factorization', 'matching',
    ],
    latexPatterns: [
      '\\\\int.*dk.*\\\\int.*dx.*\\\\cal[FR]',          // \int dk \int dx \calF
      '\\\\int.*dx.*\\\\cal[FR]\\s*\\(',               // \int dx \calF(
      '\\\\int.*d\\^\\{?[23]\\}?k.*\\\\int',           // \int d^3k \int
      '\\\\int_\\{?-?1\\}?\\^\\{?1\\}?\\s*dx.*\\{\\\\cal[RFQ]\\}', // \int_{-1}^1 dx \calR
      '[RQ]\\s*\\(\\s*k_\\{?3\\}?.*P\\s*\\).*\\\\int', // R(k_3, P) = \int
    ],
  },
  {
    type: 'lightcone_vector',
    signals: [
      'light-cone', 'null vector', 'lightcone basis',
    ],
    latexPatterns: [
      'u_\\{?\\\\rm[AB]\\}?\\s*=\\s*\\(\\s*[01]',       // u_{\rm A} = (1, 0, ...
      'n_\\{?[+-]\\}?\\s*=',                            // n_+ =, n_- =
      '\\{\\\\bf\\s*0\\}?_\\{?t\\}?',                   // {\bf 0}_t
    ],
  },
  {
    type: 'tmd_evolution',
    signals: [
      'TMD evolution', 'Collins-Soper', 'rapidity evolution',
    ],
    latexPatterns: [
      '\\\\frac\\{\\\\partial.*\\\\tilde\\{[FD]\\}.*\\}\\{\\\\partial\\s*\\\\ln.*\\\\zeta', // d\tilde{F}/d ln\zeta
      '\\\\tilde\\{K\\}.*\\\\mu',                       // \tilde{K}(...; \mu)
    ],
    caseSensitiveTerms: ['TMD', 'Collins-Soper'],
  },
  {
    type: 'mean_transverse_momentum',
    signals: [
      'transverse momentum', 'average k_T', 'intrinsic momentum',
    ],
    latexPatterns: [
      '\\\\bar\\{k_T\\^\\{?2\\}?\\}',                   // \bar{k_T^2}
      '\\\\langle\\s*k_T\\^\\{?2\\}?\\s*\\\\rangle',    // <k_T^2>
      'k_T\\^\\{?2\\}?.*F\\s*\\(\\s*x',                 // k_T^2 F(x, ...
    ],
  },
  {
    type: 'endpoint_behavior',
    signals: [
      'endpoint', 'x→1', 'x→0', 'asymptotic behavior',
    ],
    latexPatterns: [
      '\\\\to.*\\(1-x\\)\\^\\{?[n\\\\alpha]',           // \to (1-x)^n
      '\\\\to.*x\\^\\{?[n\\\\alpha-]',                  // \to x^n
      '\\\\mbox\\{for\\}\\s*x\\s*\\\\to\\s*[01]',       // \mbox{for} x \to 1
      'x\\s*\\\\to\\s*[01]',                            // x \to 0, x \to 1
    ],
  },
  {
    type: 'phase_factor',
    signals: [
      'phase', 'exponential factor', 'complex exponential',
    ],
    latexPatterns: [
      '\\\\eta.*e\\^\\{?[+-]?\\s*[2i]*\\\\pi',          // \eta e^{2i\pi...}
      'e\\^\\{?i\\s*\\\\phi',                           // e^{i\phi}
      'e\\^\\{?[+-]?i\\s*\\d?\\\\pi',                   // e^{i\pi}, e^{2i\pi}
    ],
  },
  {
    type: 'charge_conjugation',
    signals: [
      'charge conjugation', 'C-parity', 'particle-antiparticle',
    ],
    latexPatterns: [
      'C\\s*\\|\\s*[KDP\\\\pi]',                        // C|K>, C|D>
      '\\|\\s*\\\\bar\\{?[KDP]\\}?',                    // |\bar{K}>
      '\\|\\s*[KDP]\\^[+-]\\s*\\\\rangle',              // |K^+\rangle
    ],
  },
  {
    type: 'isospin_amplitude',
    signals: [
      'isospin amplitude', 'I=0', 'I=1', 'isospin basis',
    ],
    latexPatterns: [
      'T\\^\\{?[KDP]\\^\\\\pm',                         // T^{K^\pm}
      'T\\^\\{?[I+-]\\}?\\s*=',                         // T^I =, T^+ =
      'T\\^\\{?\\+\\}?.*\\\\mp.*T\\^\\{?-\\}?',         // T^+ \mp T^-
    ],
  },
  {
    type: 'spinor_bilinear',
    signals: [
      'spinor', 'Dirac structure', 'bilinear',
    ],
    latexPatterns: [
      '\\\\bar\\{?u\\}?\\s*\\(\\s*p.*\\).*\\\\slashed', // \bar{u}(p') ... \slashed
      '\\\\bar\\{?u\\}?.*\\{\\s*A\\^\\{?I\\}?',         // \bar{u} { A^I + ...
      '\\\\bar\\{?u\\}?.*u\\s*\\(\\s*p\\s*\\)',         // \bar{u}(p') ... u(p)
    ],
  },
  {
    type: 'kinematic_variable',
    signals: [
      'kinematic variable', 'Mandelstam-like',
    ],
    latexPatterns: [
      '\\\\tilde\\{?y\\}?\\s*=\\s*\\\\frac\\{t',        // \tilde{y} = \frac{t...
      '[stu]\\s*=\\s*\\(\\s*p',                         // s = (p_1 + p_2)^2
      'y\\s*=\\s*\\\\frac\\{',                          // y = \frac{...
    ],
  },
  {
    type: 'resonance_condition',
    signals: [
      'resonance', 'bound state', 'quantization',
    ],
    latexPatterns: [
      '=\\s*n\\^\\{?2\\}?\\s*,?\\s*\\\\quad.*n\\s*=\\s*1', // = n^2, n = 1, 2, ...
      '\\\\frac\\{\\\\alpha.*m.*\\}\\{.*m.*\\}\\s*=\\s*n', // \frac{\alpha m}{...m} = n
      '\\\\kappa.*m_\\{?\\\\phi\\}?',                    // \kappa m_\phi
    ],
  },
  {
    type: 'diagram_reference',
    signals: [
      'diagram', 'Feynman diagram', 'figure',
    ],
    latexPatterns: [
      '\\\\raisebox.*\\\\fd\\{',                         // \raisebox...\fd{
      '\\\\includegraphics.*diagram',                   // \includegraphics...diagram
      '\\\\fd\\{.*figures/',                            // \fd{...figures/
    ],
  },
  {
    type: 'meson_mixing',
    signals: [
      'mixing', 'oscillation', 'CP violation', 'mass eigenstates',
    ],
    latexPatterns: [
      '\\|\\s*D_\\{?[12]\\}?\\s*>\\s*=.*\\|\\s*D\\^\\{?0\\}?\\s*>', // |D_1> = ... |D^0>
      '\\|\\s*[BKD]_\\{?[LHS12]\\}?\\s*\\\\rangle',      // |B_L>, |K_S>
      '[pq]\\s*\\|\\s*[DKB]\\^\\{?0\\}?\\s*>',          // p |D^0>
      '\\\\overline\\{[DKB]\\^\\{?0\\}?\\}',            // \overline{D^0}
    ],
  },
  {
    type: 'conformal_mapping',
    signals: [
      'conformal mapping', 'z-expansion', 'dispersion variable',
    ],
    latexPatterns: [
      'z\\s*\\(\\s*t\\s*,\\s*t_\\{?\\\\rm\\s*cut',      // z(t, t_{cut}, ...
      '\\\\sqrt\\{t_\\{?\\\\rm\\s*cut',                  // \sqrt{t_{cut} - ...
      't_\\{?\\\\rm\\s*cut\\}?',                         // t_{\rm cut}
    ],
  },
  {
    type: 'susy_parameter',
    signals: [
      'supersymmetric', 'SUSY', 'superfield', 'grassmann',
    ],
    latexPatterns: [
      '\\\\bar\\\\epsilon\\s*\\\\lambda',               // \bar\epsilon\lambda
      '\\\\tilde\\\\epsilon',                            // \tilde\epsilon
      '\\\\epsilon_\\{?0\\}?\\s*\\\\text\\{const',      // \epsilon_0 \text{const
      '\\\\tfrac\\{?i\\}?\\{.*\\\\ell\\}?\\s*\\\\epsilon', // \tfrac{i}{2\ell}\epsilon
    ],
    caseSensitiveTerms: ['SUSY'],
  },
  {
    type: 'femtoscopy',
    signals: [
      'femtoscopy', 'HBT', 'correlation function', 'source function',
    ],
    latexPatterns: [
      'C\\s*\\(\\s*\\\\vec\\{?[qk]\\}?',                 // C(\vec{q}, ...
      'R\\^\\{?G\\}?_\\{?out\\}?',                       // R^G_{out}
      'R\\^\\{?G\\}?_\\{?side\\}?',                      // R^G_{side}
      '\\\\left\\|\\s*\\\\Psi.*\\\\right\\|\\^\\{?2\\}?', // |\Psi|^2
    ],
    caseSensitiveTerms: ['HBT'],
  },
  {
    type: 'wilson_coefficient',
    signals: [
      'Wilson coefficient', 'effective operator', 'OPE coefficient',
    ],
    latexPatterns: [
      'G_\\{?[68],?\\s*27?\\}?\\s*=',                    // G_{8,27} =
      'C_\\{?[1-9]\\}?\\s*=',                            // C_1 =
      'G_\\{?F\\}?.*V_\\{?[ucdstb][dsubtc]\\}?',        // G_F V_{ud}
    ],
    caseSensitiveTerms: ['Wilson'],
  },
  {
    type: 'path_integral',
    signals: [
      'path integral', 'partition function', 'functional integral',
    ],
    latexPatterns: [
      '\\\\mathcal\\{Z\\}\\s*=\\s*\\\\int.*\\\\mathcal\\{D\\}', // \mathcal{Z} = \int \mathcal{D}
      '\\\\int.*\\{\\\\mathcal\\s*D\\}?\\s*\\\\Phi.*e\\^\\{?-S', // \int D\Phi e^{-S}
      'e\\^\\{?-S\\s*\\[',                               // e^{-S[...]}
    ],
  },
  {
    type: 'lattice_variable',
    signals: [
      'lattice', 'lattice spacing', 'lattice QCD',
    ],
    latexPatterns: [
      'x_\\{?\\\\mu\\}?\\s*=\\s*n_\\{?\\\\mu\\}?\\s*a', // x_\mu = n_\mu a
      'N_\\{?\\\\mu\\}?\\s*-\\s*1',                      // N_\mu - 1
      'a\\^\\{?\\\\mu\\}?',                              // a^\mu (lattice spacing)
    ],
  },
  {
    type: 'mass_bound',
    signals: [
      'mass bound', 'upper limit', 'lower limit', 'constraint',
    ],
    latexPatterns: [
      'm_\\{?\\\\tilde\\{[BWH]\\}',                      // m_{\tilde{B}}, m_{\tilde{W}}
      '<\\s*\\d+\\.?\\d*\\s*\\\\tev',                    // < 1.0 \tev
      '>\\s*\\d+\\.?\\d*\\s*\\\\gev',                    // > 100 \gev
    ],
  },
  {
    type: 'lattice_operator',
    signals: [
      'lattice operator', 'discretization', 'Wilson fermion',
    ],
    latexPatterns: [
      'V_\\{?\\\\mu\\}?\\^\\{?\\\\text\\{C\\}?\\}?',     // V_\mu^{\text{C}}
      '\\\\kappa_\\{?\\\\mu\\}?',                         // \kappa_\mu
      'U_\\{?\\\\mu\\}?\\^\\{?\\\\dagger\\}?',           // U_\mu^\dagger
      '1\\s*[+-]\\s*\\\\gamma_\\{?\\\\mu\\}?',           // 1 + \gamma_\mu
    ],
  },
  {
    type: 'nonrelativistic_limit',
    signals: [
      'nonrelativistic', 'NR limit', 'static limit',
    ],
    latexPatterns: [
      '\\\\stackrel\\{NR\\}\\{=\\}',                     // \stackrel{NR}{=}
      '\\\\stackrel\\{\\\\text\\{NR\\}\\}',              // \stackrel{\text{NR}}
      '\\\\int\\s*d\\^\\{?3\\}?r.*e\\^\\{.*\\\\vec\\{?[Qq]\\}?', // \int d^3r e^{i\vec{Q}\cdot\vec{r}}
    ],
  },
  {
    type: 'chi_square',
    signals: [
      'chi-square', 'fit quality', 'goodness of fit',
    ],
    latexPatterns: [
      '\\\\chi\\^\\{?2\\}?_\\{?global\\}?',              // \chi^2_{global}
      '\\\\chi\\^\\{?2\\}?\\s*=\\s*\\\\sum',             // \chi^2 = \sum
      '\\\\chi\\^\\{?2\\}?_\\{?th\\}?',                  // \chi^2_{th}
    ],
  },
  {
    type: 'penalty_function',
    signals: [
      'penalty', 'regularization', 'constraint term',
    ],
    latexPatterns: [
      'P\\s*=\\s*\\\\sum.*S_\\{?n\\}?',                  // P = \sum S_n
      '\\\\theta\\s*\\(\\s*S',                           // \theta(S...)
      'S_\\{?n\\}?\\^\\{?k\\}?',                         // S_n^k
    ],
  },
  {
    type: 'renormalized_quantity',
    signals: [
      'renormalized', 'counterterm', 'subtracted',
    ],
    latexPatterns: [
      '\\\\tilde\\{f\\}.*\\^\\{?\\\\text\\{ren\\}?\\}?', // \tilde{f}^{ren}
      '\\\\widehat\\{\\\\cal\\s*P\\}',                   // \widehat{\calP}
      '_\\{?\\\\text\\{ren\\}?\\}?',                     // _{ren}
    ],
  },
  {
    type: 'sachs_form_factor',
    signals: [
      'Sachs form factor', 'electric form factor', 'magnetic form factor',
    ],
    latexPatterns: [
      'G_\\{?[EM]\\}?\\s*&?\\s*=\\s*F_\\{?[DP]\\}?',    // G_E = F_D, G_M = F_D + F_P
      'F_\\{?[DP]\\}?\\s*[+-]\\s*\\\\tau\\s*F_\\{?[DP]\\}?', // F_D - \tau F_P
    ],
    caseSensitiveTerms: ['Sachs'],
  },
  {
    type: 'spinor_contraction',
    signals: [
      'spinor contraction', 'gamma matrix', 'Dirac bilinear',
    ],
    latexPatterns: [
      'C_\\{?\\\\alpha\\\\beta\\}?\\s*\\\\lambda\\^\\{?\\\\beta\\}?', // C_{\alpha\beta}\lambda^\beta
      '\\\\bar\\\\epsilon\\^\\{?\\\\alpha\\}?',          // \bar\epsilon^\alpha
      '\\\\bar\\\\epsilon\\s*\\\\gamma\\^\\{?[a\\\\mu]', // \bar\epsilon\gamma^a
    ],
  },
  {
    type: 'expectation_factorization',
    signals: [
      'factorization', 'large N', 'mean field',
    ],
    latexPatterns: [
      '\\\\langle.*\\\\cdot.*\\\\rangle.*=.*\\\\langle.*\\\\rangle.*\\\\langle.*\\\\rangle', // <J.J> = <J><J>
      '\\\\cO\\s*\\\\left\\(.*N',                         // \cO(1/N)
    ],
  },
  {
    type: 'gluon_self_coupling',
    signals: [
      'gluon', 'triple gluon', 'QCD vertex',
    ],
    latexPatterns: [
      '\\\\tilde\\{?d\\}?\\^\\{?G\\}?\\s*f_\\{?\\\\alpha\\\\beta\\\\gamma\\}?', // \tilde{d}^G f_{\alpha\beta\gamma}
      'G_\\{?\\\\alpha.*\\}?.*G_\\{?\\\\beta.*\\}?',     // G_\alpha G_\beta
    ],
  },
  {
    type: 'mass_matrix',
    signals: [
      'mass matrix', 'mixing matrix', 'Majorana mass',
    ],
    latexPatterns: [
      '\\\\begin\\{array\\}.*m_\\{?[e\\\\mu\\\\tau]',    // \begin{array}...m_{ee}
      'm_\\{?[e\\\\mu\\\\tau][e\\\\mu\\\\tau]\\}?',      // m_{ee}, m_{e\mu}
      'M_\\{?\\\\nu\\}?\\s*=',                           // M_\nu =
      '\\\\left\\(\\s*\\\\begin\\{array\\}',             // \left(\begin{array}
    ],
  },
  {
    type: 'isospin_combination',
    signals: [
      'isospin', 'isoscalar', 'isovector',
    ],
    latexPatterns: [
      'G_\\{?[EM]\\}?\\^\\{?[01]\\}?\\s*=\\s*G_\\{?[EM]\\}?\\^\\{?[pn]\\}?\\s*[+-]', // G_E^0 = G_E^p + G_E^n
      'F_\\{?[12]\\}?\\^\\{?[01]\\}?\\s*=',              // F_1^0 =
      '\\^\\{?[pn]\\}?\\s*[+-]\\s*G_\\{?[EM]\\}?\\^\\{?[pn]\\}?', // ^p + G_E^n
    ],
  },
  {
    type: 'ads_cft_parameter',
    signals: [
      'AdS', 'CFT', 'holographic', 'anti-de Sitter',
    ],
    latexPatterns: [
      '\\\\ell\\^\\{?[-2]\\}?',                          // \ell^{-2}, \ell^2
      '\\\\tfrac\\{\\d+\\}\\{\\d*\\\\ell\\^\\{?2\\}?\\}', // \tfrac{9}{4\ell^2}
      'h\\s*=\\s*[-+]?\\\\tfrac\\{',                     // h = \tfrac{...
    ],
    caseSensitiveTerms: ['AdS', 'CFT'],
  },
  {
    type: 'susy_covariant_derivative',
    signals: [
      'covariant derivative', 'supersymmetric derivative', 'vielbein',
    ],
    latexPatterns: [
      'D\\s*\\\\epsilon\\s*=',                           // D\epsilon =
      '\\\\gamma\\^\\{?[a\\\\mu]\\}?\\s*e\\^\\{?[a]',   // \gamma^a e^a
      '\\\\frac\\{i\\}\\{2f\\}\\s*\\\\gamma',            // \frac{i}{2f}\gamma
      'e\\^\\{?[a]\\}?_\\{?\\\\mu\\}?\\s*\\\\epsilon',  // e^a_\mu \epsilon
    ],
  },
  {
    type: 'lattice_derivative',
    signals: [
      'lattice derivative', 'finite difference', 'discretized derivative',
    ],
    latexPatterns: [
      '\\{\\\\mathcal\\s*D\\}?_\\{?\\\\mu\\}?\\s*=\\s*\\\\frac\\{1\\}\\{2a\\}', // \mathcal{D}_\mu = \frac{1}{2a}
      'V_\\{?\\\\mu\\}?\\s*-\\s*V_\\{?\\\\mu\\}?\\^\\{?\\\\dag', // V_\mu - V_\mu^\dagger
      '\\\\nabla_\\{?\\\\mu\\}?\\s*=\\s*\\\\frac\\{1\\}\\{a\\}', // \nabla_\mu = \frac{1}{a}
    ],
  },
  {
    type: 'continuum_limit',
    signals: [
      'continuum', 'a→0', 'continuum limit',
    ],
    latexPatterns: [
      'a\\s*\\\\to\\s*0',                                // a \to 0
      '\\\\lim_\\{?a\\s*\\\\to\\s*0',                    // \lim_{a\to 0}
      'O\\s*\\(\\s*a\\^\\{?[2n]\\}?\\s*\\)',             // O(a^2)
    ],
  },
  {
    type: 'susy_algebra',
    signals: [
      'superalgebra', 'supersymmetry algebra', 'anticommutator',
    ],
    latexPatterns: [
      '\\\\bar\\\\epsilon\\s*\\\\lambda\\s*=\\s*\\\\lambda\\s*\\\\bar\\\\epsilon', // \bar\epsilon\lambda = \lambda\bar\epsilon
      '\\\\bar\\\\epsilon\\s*\\\\gamma\\^\\{?[a\\\\mu]\\}?\\s*\\\\lambda\\s*=\\s*-', // \bar\epsilon\gamma^a\lambda = -...
      '\\{\\s*Q\\s*,\\s*\\\\bar\\{?Q\\}?\\s*\\}',        // {Q, \bar{Q}}
    ],
  },
  {
    type: 'vielbein',
    signals: [
      'vielbein', 'tetrad', 'frame field',
    ],
    latexPatterns: [
      'e\\^\\{?[a-z]\\}?_\\{?[\\\\mu\\\\nu]\\}?',        // e^a_\mu
      'e_\\{?[a-z]\\}?\\^\\{?[\\\\mu\\\\nu]\\}?',        // e_a^\mu
      '\\\\omega_\\{?[\\\\mu ab]\\}?',                   // \omega_{\mu ab}
    ],
  },
  {
    type: 'gauge_field_strength',
    signals: [
      'field strength', 'curvature', 'gauge curvature',
    ],
    latexPatterns: [
      'F_\\{?\\\\mu\\\\nu\\}?\\s*=\\s*\\\\partial',       // F_{\mu\nu} = \partial
      'R_\\{?\\\\mu\\\\nu\\\\rho\\\\sigma\\}?',          // R_{\mu\nu\rho\sigma}
      '\\[\\s*D_\\{?\\\\mu\\}?\\s*,\\s*D_\\{?\\\\nu\\}?\\s*\\]', // [D_\mu, D_\nu]
    ],
  },
  {
    type: 'plaquette',
    signals: [
      'plaquette', 'Wilson loop', 'gauge action',
    ],
    latexPatterns: [
      'U_\\{?\\\\mu\\\\nu\\}?\\s*\\(\\s*x\\s*\\)',       // U_{\mu\nu}(x)
      'U_\\{?\\\\mu\\}?\\s*U_\\{?\\\\nu\\}?\\s*U_\\{?\\\\mu\\}?\\^\\{?\\\\dagger', // U_\mu U_\nu U_\mu^\dagger
      '\\\\text\\{Tr\\}?\\s*U_\\{?\\\\mu\\\\nu\\}?',     // Tr U_{\mu\nu}
      '\\\\beta\\s*\\\\sum.*\\\\text\\{Tr\\}',           // \beta \sum ... Tr
    ],
  },
  {
    type: 'gauge_transformation',
    signals: [
      'gauge transformation', 'local symmetry', 'gauge invariance',
    ],
    latexPatterns: [
      '\\\\psi.*\\\\rightarrow\\s*\\\\Lambda.*\\\\psi',   // \psi \rightarrow \Lambda \psi
      '\\\\bar\\\\psi.*\\\\rightarrow.*\\\\Lambda\\^\\{?\\\\dag', // \bar\psi \rightarrow ... \Lambda^\dag
      'U_\\{?\\\\mu\\}?.*\\\\rightarrow.*\\\\Lambda.*U_\\{?\\\\mu\\}?', // U_\mu \rightarrow \Lambda U_\mu
    ],
  },
  {
    type: 'mixing_angle',
    signals: [
      'mixing angle', 'phase', 'CP phase',
    ],
    latexPatterns: [
      '\\\\tan\\s*\\\\phi_\\{?[12]\\}?\\s*=',            // \tan\phi_1 =
      '\\\\sin\\s*\\\\theta_\\{?[\\\\mu w12]\\}?',        // \sin\theta_\mu
      '\\\\cos\\s*\\\\beta',                              // \cos\beta
    ],
  },
  {
    type: 'diagonalization',
    signals: [
      'diagonalization', 'basis change', 'unitary transformation',
    ],
    latexPatterns: [
      'U.*M.*V\\^\\{?-1\\}?\\s*=\\s*M_\\{?D\\}?',        // U M V^{-1} = M_D
      'U\\^\\{?\\\\dagger\\}?\\s*M\\s*U\\s*=',           // U^\dagger M U =
    ],
  },
  {
    type: 'power_series',
    signals: [
      'power series', 'Taylor series', 'expansion',
    ],
    latexPatterns: [
      '\\\\sum_\\{?k\\s*=\\s*0\\}?\\^\\{?\\\\infty\\}?.*[az]_\\{?k\\}?\\s*z\\^\\{?k\\}?', // \sum_{k=0}^\infty a_k z^k
      '\\\\phi.*=\\s*\\\\sum.*z\\^\\{?k\\}?',            // \phi = \sum ... z^k
    ],
  },
  {
    type: 'norm_definition',
    signals: [
      'norm', 'p-norm', 'Lp space',
    ],
    latexPatterns: [
      '\\|\\|.*\\|\\|_\\{?[pq12]\\}?\\s*=',              // ||...||_p =
      '\\\\left\\(\\s*\\\\sum.*\\\\right\\)\\^\\{?1\\s*/\\s*[pq]', // (\sum...)^{1/p}
      '\\|a_\\{?k\\}?\\|\\^\\{?[pq]\\}?',                // |a_k|^p
    ],
  },
  {
    type: 'susy_killing_spinor',
    signals: [
      'Killing spinor', 'supersymmetry parameter', 'BPS',
    ],
    latexPatterns: [
      'D_\\{?\\\\mu\\}?\\s*\\\\epsilon\\s*=\\s*\\\\tfrac\\{i\\}\\{2\\\\ell\\}\\s*\\\\gamma', // D_\mu \epsilon = \tfrac{i}{2\ell}\gamma
      'D_\\{?\\\\mu\\}?\\s*\\\\bar\\\\epsilon\\s*=',     // D_\mu \bar\epsilon =
      '\\\\psi_\\{?st\\}?',                               // \psi_{st}
    ],
  },
  {
    type: 'susy_lagrangian',
    signals: [
      'supersymmetric Lagrangian', 'F-term', 'D-term',
    ],
    latexPatterns: [
      '\\{\\\\cal\\s*L\\}_\\{?F\\}?',                    // \calL_F
      '\\\\text\\{Tr\\}.*F\\s*\\\\phi',                  // Tr F \phi
      '\\\\bar\\{?F\\}?\\s*\\\\bar\\{?\\\\phi\\}?',      // \bar{F} \bar{\phi}
      '\\\\psi\\s*\\\\psi',                              // \psi\psi
    ],
  },
  {
    type: 'supersymmetric_index',
    signals: [
      'index', 'supersymmetric index', 'elliptic genus',
    ],
    latexPatterns: [
      '\\\\prod_\\{?\\\\rho\\s*\\\\in\\s*R\\}?',         // \prod_{\rho \in R}
      's_\\{?b\\s*=\\s*1\\}?',                            // s_{b=1}
      '\\\\hat\\\\sigma_\\{?i\\}?',                       // \hat\sigma_i
    ],
  },
  {
    type: 'vielbein_component',
    signals: [
      'vielbein', 'frame', 'dreibein',
    ],
    latexPatterns: [
      'e\\^\\{?[123]\\}?\\s*=.*d[\\\\varphi\\\\chi\\\\theta]', // e^1 = ... d\varphi
      '\\\\omega\\^\\{?[123][123]\\}?\\s*=',             // \omega^{12} =
      '\\\\ell\\s*\\\\cos\\s*\\\\theta\\s*d',            // \ell \cos\theta d
    ],
  },
  {
    type: 'spin_connection',
    signals: [
      'spin connection', 'connection form',
    ],
    latexPatterns: [
      '\\\\omega\\^\\{?[abc]\\}?_\\{?\\\\mu\\}?',        // \omega^a_\mu
      '\\\\omega_\\{?\\\\mu\\}?\\^\\{?[abc]\\}?',        // \omega_\mu^a
      'd\\s*e\\^\\{?[a]\\}?\\s*\\+\\s*\\\\omega',        // de^a + \omega
    ],
  },
  {
    type: 'spectral_density',
    signals: [
      'spectral density', 'spectral function', 'density of states',
    ],
    latexPatterns: [
      '\\\\frac\\{\\\\rho\\s*\\(\\s*\\\\omega?\\s*\\)\\}\\{\\\\omega?\\}', // \frac{\rho(\omega)}{\omega}
      'm\\s*\\(\\s*\\\\omega\\s*\\)\\s*\\\\exp',          // m(\omega) \exp
      '\\\\sum_\\{?k\\}?\\s*c_\\{?k\\}?\\s*u_\\{?k\\}?', // \sum_k c_k u_k
    ],
  },
  {
    type: 'radius_moment',
    signals: [
      'radius', 'Zemach radius', 'third moment',
    ],
    latexPatterns: [
      'R_\\{?[2E]\\}?\\^\\{?[23]\\}?\\s*=\\s*\\\\int',   // R_2^3 = \int
      '\\|\\\\vec\\{?r\\}?_\\{?1\\}?\\s*-\\s*\\\\vec\\{?r\\}?_\\{?2\\}?\\|\\^\\{?3\\}?', // |r_1 - r_2|^3
      '\\\\rho_\\{?E\\}?\\s*\\(\\s*r',                    // \rho_E(r
    ],
  },
  {
    type: 'qcd_lambda',
    signals: [
      'QCD scale', 'Lambda QCD', 'running coupling',
    ],
    latexPatterns: [
      '\\\\beta_\\{?i\\s*,\\s*\\\\alpha\\}?\\s*\\\\lambda', // \beta_{i,\alpha} \lambda
      '\\\\sigma_\\{?i\\s*,\\s*\\\\alpha\\}?',            // \sigma_{i,\alpha}
      'X_\\{?i\\}?\\s*\\\\lambda_\\{?\\\\alpha\\}?',      // X_i \lambda_\alpha
    ],
  },
  {
    type: 'strangeness_content',
    signals: [
      'strangeness', 'strange quark', 's-quark content',
    ],
    latexPatterns: [
      '\\\\kappa\\^\\{?s\\}?\\s*\\(\\s*Q\\^\\{?2\\}?',    // \kappa^s(Q^2)
      '\\\\overline\\{s\\}\\s*\\(\\s*x',                  // \bar{s}(x
      's\\s*\\(\\s*x\\s*,\\s*Q\\^\\{?2\\}?',              // s(x, Q^2)
    ],
  },
  {
    type: 'parametric_form',
    signals: [
      'parametrization', 'fit function', 'ansatz',
    ],
    latexPatterns: [
      'P\\s*\\(\\s*x\\s*\\)\\s*=\\s*\\\\exp\\s*\\(\\s*a_\\{?0\\}?', // P(x) = \exp(a_0 + ...
      'm\\s*\\(\\s*\\\\omega\\s*\\)\\s*=\\s*m_\\{?0\\}?', // m(\omega) = m_0
      '\\(\\s*b\\s*\\+\\s*a.*\\\\omega\\s*\\)',           // (b + a \omega)
    ],
  },
  {
    type: 'continuum_limit_arrow',
    signals: [
      'continuum limit', 'lattice spacing zero',
    ],
    latexPatterns: [
      '\\\\stackrel\\{a\\s*\\\\rightarrow\\s*0\\}\\{\\\\longrightarrow\\}', // \stackrel{a\to 0}{\longrightarrow}
      '\\\\stackrel\\{a\\s*\\\\to\\s*0\\}',               // \stackrel{a\to 0}
      'a\\^\\{?2\\}?\\s*F_\\{?\\\\mu\\\\nu\\}?',          // a^2 F_{\mu\nu}
    ],
  },
  {
    type: 'wilson_action',
    signals: [
      'Wilson action', 'gauge action', 'lattice action',
    ],
    latexPatterns: [
      'S_\\{?W\\}?\\s*\\\\stackrel',                      // S_W \stackrel
      '\\\\text\\{Tr\\}\\s*F_\\{?\\\\mu\\\\nu\\}?\\^\\{?2\\}?', // Tr F_{\mu\nu}^2
    ],
    caseSensitiveTerms: ['Wilson'],
  },
  {
    type: 'propagator_element',
    signals: [
      'propagator', 'Green function element',
    ],
    latexPatterns: [
      'p_\\{?m\\s*,\\s*n\\}?\\s*=\\s*P\\s*U\\^\\{?m\\}?', // p_{m,n} = P U^m
      'd\\s*p\\s*\\(\\s*w',                               // dp(w...
    ],
  },
  {
    type: 'angular_momentum_state',
    signals: [
      'angular momentum', 'spin state', 'Clebsch-Gordan',
    ],
    latexPatterns: [
      '\\\\ket\\{j\\s*;\\s*m',                            // \ket{j; m, ...
      '\\|\\s*j\\s*,\\s*m\\s*[,\\\\pm]',                  // |j, m, ...
      'Y_\\{?j\\s*,\\s*m[\\\\pm]?\\d?\\}?',               // Y_{j, m+1}
    ],
    caseSensitiveTerms: ['Clebsch-Gordan'],
  },
  {
    type: 'differential_form',
    signals: [
      'differential form', 'wedge product', 'exterior derivative',
    ],
    latexPatterns: [
      'd\\^\\{?3\\}?\\s*\\\\xi\\s*\\\\sqrt\\{g\\}',       // d^3\xi \sqrt{g}
      'd.*\\\\wedge\\s*\\\\ast\\s*d',                     // d...\wedge\ast d
      '\\\\text\\{Tr\\}\\s*d\\s*A\\s*\\\\wedge',          // Tr dA \wedge
    ],
  },
  {
    type: 'spherical_harmonic_expansion',
    signals: [
      'spherical harmonic', 'multipole expansion',
    ],
    latexPatterns: [
      'Y_\\{?j\\s*,\\s*m[\\\\pm+-]?\\d?\\}?\\s*e\\^\\{?[+-]\\}?', // Y_{j,m+1} e^-
      'x\\^\\{?[+-3]\\}?\\s*Y_\\{?j',                     // x^+ Y_{j...
      'A_\\{?\\\\alpha\\}?\\s*=.*Y_\\{?j',                // A_\alpha = ... Y_j
    ],
  },
  {
    type: 'susy_mass_constraint',
    signals: [
      'mass constraint', 'mass bound',
    ],
    latexPatterns: [
      '[Mm]_\\{?2\\}?\\^\\{?2\\}?\\s*<.*\\\\mu',          // M_2^2 < ... \mu
      '\\|\\\\mu\\|\\^\\{?2\\}?\\s*\\+.*m_\\{?W\\}?',     // |\mu|^2 + ... m_W
      '\\\\cos\\s*2\\s*\\\\beta',                          // \cos 2\beta
    ],
  },
  {
    type: 'anomalous_moment_contribution',
    signals: [
      'anomalous magnetic moment', 'g-2 contribution',
    ],
    latexPatterns: [
      'a\\^\\{?\\\\chi[\\^\\{?[-+0]\\}?]?\\}?_\\{?\\\\mu\\}?\\s*=', // a^\chi_\mu =
      'a\\^\\{?\\d\\d\\}?_\\{?\\\\mu\\}?',                 // a^{21}_\mu
    ],
  },
  {
    type: 'gamma_matrix_basis',
    signals: [
      'Dirac basis', 'gamma matrix', 'Clifford algebra',
    ],
    latexPatterns: [
      '\\\\Gamma\\^\\{?A\\}?\\s*=\\s*\\\\\\{',            // \Gamma^A = \{
      '\\\\gamma\\^\\{?[0i]\\}?\\s*,.*\\\\gamma_\\{?5\\}?', // \gamma^0, ... \gamma_5
      'i\\s*\\\\sigma\\^\\{?\\\\mu\\\\nu\\}?',            // i\sigma^{\mu\nu}
    ],
  },
  {
    type: 'fayet_iliopoulos',
    signals: [
      'Fayet-Iliopoulos', 'FI term', 'D-term',
    ],
    latexPatterns: [
      '\\{\\\\cal\\s*L\\}_\\{?\\\\text\\{FI\\}?\\}?',     // \calL_{FI}
      '\\\\zeta.*\\\\int.*\\{\\\\cal\\s*L\\}',            // \zeta \int \calL
      '\\\\exp.*\\\\pi\\s*i.*\\\\zeta',                   // \exp ... \pi i \zeta
    ],
    caseSensitiveTerms: ['Fayet-Iliopoulos'],
  },
  {
    type: 'bernstein_polynomial',
    signals: [
      'Bernstein polynomial', 'basis polynomial',
    ],
    latexPatterns: [
      'p_\\{?[012]\\}?\\s*\\(\\s*y\\s*\\)\\s*=.*\\(\\s*1\\s*-\\s*y\\s*\\)\\^\\{?[234]\\}?', // p_0(y) = (1-y)^4
      'q_\\{?[012]\\}?\\s*\\(\\s*y\\s*\\)',               // q_0(y)
      '[pq]_\\{?\\d\\}?\\s*\\(\\s*y\\s*\\)\\s*&?=',       // p_1(y) =
    ],
  },
  {
    type: 'pdf_parametrization',
    signals: [
      'PDF parametrization', 'parton distribution',
    ],
    latexPatterns: [
      'P_\\{?\\\\mathrm\\{[uvds]\\}_\\{?v\\}?\\}?',       // P_{\mathrm{u}_v}
      'd_\\{?[012]\\}?\\s*p_\\{?[012]\\}?\\s*\\(\\s*y', // d_0 p_0(y)
    ],
  },
  {
    type: 'pentaquark_assignment',
    signals: [
      'pentaquark', 'molecular assignment', 'quantum numbers',
    ],
    latexPatterns: [
      'P_\\{?c\\}?\\s*\\(\\s*\\d{4}\\s*\\)',              // P_c(4380)
      '\\\\bar\\{D\\}.*\\\\Sigma_\\{?c\\}?',              // \bar{D} \Sigma_c
      '\\[\\s*\\d\\s*/\\s*2\\^\\{?[+-]\\}?\\s*\\]',      // [3/2^-]
    ],
  },
  {
    type: 'expectation_integral',
    signals: [
      'expectation', 'weighted average', 'moment',
    ],
    latexPatterns: [
      '\\\\langle\\s*\\\\omega.*\\\\rangle\\s*=\\s*\\\\frac\\{\\s*\\\\int', // <\omega> = \frac{\int...
      '\\\\int\\s*d\\^\\{?3\\}?\\s*\\\\vec\\{?r\\}?.*\\{\\\\cal\\s*W\\}?', // \int d^3r \calW
    ],
  },
  {
    type: 'christoffel_symbol',
    signals: [
      'Christoffel', 'connection', 'covariant derivative',
    ],
    latexPatterns: [
      '\\\\tilde\\{\\\\Gamma\\}\\^\\{?[ijk]\\}?',         // \tilde{\Gamma}^i
      '\\\\Gamma\\^\\{?[ijk]\\}?_\\{?[jkl][jkl]\\}?',    // \Gamma^i_{jk}
      '\\\\tilde\\{\\\\gamma\\}\\^\\{?[ijk][ijk]\\}?',    // \tilde{\gamma}^{jk}
      '\\\\coloneqq',                                     // \coloneqq
    ],
  },
  {
    type: 'invariant_mass',
    signals: [
      'invariant mass', 'center-of-mass energy', 'W^2',
    ],
    latexPatterns: [
      'W\\^\\{?2\\}?\\s*=\\s*M_\\{?P\\}?\\^\\{?2\\}?',    // W^2 = M_P^2
      'Q\\^\\{?2\\}?.*\\(\\s*1\\s*-\\s*x\\s*\\)\\s*/\\s*x', // Q^2 (1-x)/x
      's\\s*=\\s*\\(.*\\)\\^\\{?2\\}?',                   // s = (...)^2
    ],
  },
  {
    type: 'gaussian_convolution',
    signals: [
      'Gaussian', 'smearing', 'convolution',
    ],
    latexPatterns: [
      'Q_\\{?G\\}?.*=.*\\\\frac\\{P\\}\\{\\\\Lambda.*\\\\pi\\}', // Q_G = \frac{P}{\Lambda\sqrt{\pi}}
      'e\\^\\{?-.*\\^\\{?2\\}?\\s*P\\^\\{?2\\}?',         // e^{-...^2 P^2}
      '\\\\Lambda\\s*\\\\sqrt\\{\\\\pi\\}',               // \Lambda\sqrt{\pi}
    ],
  },
  {
    type: 'lattice_continuum',
    signals: [
      'lattice', 'continuum', 'discretization',
    ],
    latexPatterns: [
      '\\\\frac\\{1\\}\\{a\\}.*\\(.*V_\\{?\\\\mu\\}?',    // \frac{1}{a}(V_\mu ...
      'V_\\{?\\\\mu\\}?\\s*-\\s*V_\\{?\\\\mu\\}?\\^\\{?\\\\dag', // V_\mu - V_\mu^\dag
    ],
  },
  {
    type: 'thermal_average',
    signals: [
      'thermal', 'statistical average', 'ensemble',
    ],
    latexPatterns: [
      '\\\\langle.*\\\\rangle\\s*=\\s*\\\\frac\\{\\s*\\\\int.*d\\^\\{?3\\}?', // <...> = \frac{\int d^3
      '\\{\\\\cal\\s*W\\}?\\s*\\(\\s*\\\\vec\\{?r\\}?\\)', // \calW(\vec{r})
    ],
  },
  {
    type: 'quasi_pdf',
    signals: [
      'quasi-PDF', 'quasi-distribution', 'large momentum',
    ],
    latexPatterns: [
      'Q\\s*\\(\\s*y\\s*,\\s*P\\s*\\)',                   // Q(y, P)
      'f\\s*\\(\\s*x\\s*\\)\\s*e\\^\\{?-',               // f(x) e^-
      '\\\\int_\\{?-1\\}?\\^\\{?1\\}?\\s*dx.*f\\s*\\(\\s*x', // \int_{-1}^1 dx f(x
    ],
  },
  {
    type: 'strange_contribution',
    signals: [
      'strange quark', 'strangeness', 'sea quark',
    ],
    latexPatterns: [
      '\\\\kappa\\^\\{?s\\}?.*Q\\^\\{?2\\}?',             // \kappa^s ... Q^2
      '\\\\bar\\{?s\\}?\\s*\\(\\s*x',                     // \bar{s}(x
      's\\s*\\(\\s*x\\s*,\\s*Q\\^\\{?2\\}?\\s*\\)',       // s(x, Q^2)
    ],
  },
  {
    type: 'source_function',
    signals: [
      'source function', 'emission function', 'HBT source',
    ],
    latexPatterns: [
      'S_\\{?12\\}?\\s*\\(\\s*r\\s*\\)',                  // S_{12}(r)
      '\\\\Psi.*\\\\bm\\{[rk]\\}',                        // \Psi \bm{r}; \bm{k}
      '\\\\Phi\\^\\{?\\\\rm\\{?C\\}?\\}?',                // \Phi^{\rm{C}}
      '\\\\int.*d\\^\\{?3\\}?r.*S_\\{?12\\}?',            // \int d^3r S_{12}
    ],
  },
  {
    type: 'thermodynamic_relation',
    signals: [
      'thermodynamic', 'free energy', 'equation of state',
    ],
    latexPatterns: [
      'F\\s*=\\s*-\\s*\\\\int.*[sT].*d[T\\\\mu]',         // F = -\int s dT
      '\\\\epsilon\\s*=\\s*-\\s*p\\s*\\+\\s*s\\s*T',      // \epsilon = -p + sT
      '\\\\rho\\s*d\\s*\\\\mu',                            // \rho d\mu
      '[pP]\\s*=\\s*s\\s*T\\s*\\+\\s*\\\\mu\\s*\\\\rho',  // p = sT + \mu\rho
    ],
  },
  {
    type: 'lattice_mass_relation',
    signals: [
      'lattice mass', 'scaling', 'quark mass',
    ],
    latexPatterns: [
      'm_\\{?[p\\\\rho]\\}?\\s*=\\s*f_\\{?[p\\\\rho]\\}?\\s*g\\s*\\\\Lambda', // m_p = f_p g \Lambda
      '\\{m_\\{?\\\\rho\\}?\\s*\\\\over\\s*m_\\{?p\\}?\\}', // {m_\rho \over m_p}
      '\\\\myeqno',                                        // \myeqno (custom equation numbering)
    ],
  },
  {
    type: 'continuum_action',
    signals: [
      'continuum action', 'QCD action', 'Dirac action',
    ],
    latexPatterns: [
      'S_\\{?\\\\rm\\s*cont\\}?\\s*=\\s*\\\\int.*d\\^\\{?4\\}?x', // S_{\rm cont} = \int d^4x
      '\\\\overline\\s*\\\\psi.*\\\\slashchar\\s*\\\\partial\\s*\\\\psi', // \bar\psi \slashchar\partial \psi
      'i\\s*\\\\slashchar\\s*D',                          // i \slashchar D
    ],
  },
  {
    type: 'einstein_equation',
    signals: [
      'Einstein equation', 'general relativity', 'Ricci tensor',
    ],
    latexPatterns: [
      'R_\\{?\\\\mu\\\\nu\\}?\\s*-\\s*\\\\frac\\{1\\}\\{2\\}\\s*g_\\{?\\\\mu\\\\nu\\}?\\s*R', // R_{\mu\nu} - 1/2 g_{\mu\nu} R
      '8\\s*\\\\pi\\s*G.*T_\\{?\\\\mu\\\\nu\\}?',          // 8\pi G T_{\mu\nu}
      '-\\s*R\\s*=\\s*8\\s*\\\\pi\\s*G.*T',                // -R = 8\pi G T
    ],
    caseSensitiveTerms: ['Einstein', 'Ricci'],
  },
  {
    type: 'metric_perturbation',
    signals: [
      'metric', 'perturbation', 'weak field',
    ],
    latexPatterns: [
      'g_\\{?00\\}?\\s*=\\s*1\\s*\\+\\s*2\\s*\\\\varphi', // g_{00} = 1 + 2\varphi
      'g_\\{?\\\\mu\\\\nu\\}?\\s*=\\s*\\\\eta_\\{?\\\\mu\\\\nu\\}?\\s*\\+', // g_{\mu\nu} = \eta + ...
      'h_\\{?\\\\mu\\\\nu\\}?',                            // h_{\mu\nu}
    ],
  },
  {
    type: 'momentum_fraction',
    signals: [
      'momentum fraction', 'average x', 'moment',
    ],
    latexPatterns: [
      '\\\\langle\\s*x\\s*\\\\rangle_\\{?[qg]\\}?\\s*&?=', // <x>_{q,g} =
      'A_\\{?[qg]\\s*,?\\s*[qg]?\\}?\\s*\\(\\s*0\\s*\\)', // A_{q,g}(0)
      'J_\\{?[qg]\\}?\\s*&?=',                             // J_{q,g} =
      'B_\\{?[qg]\\s*,?\\s*[qg]?\\}?\\s*\\(\\s*0\\s*\\)', // B_{q,g}(0)
    ],
  },
  {
    type: 'form_factor_combination',
    signals: [
      'form factor', 'Rosenbluth', 'cross section',
    ],
    latexPatterns: [
      '\\\\tau\\s*G_\\{?[EM]\\}?\\^\\{?[vs]?\\}?\\^\\{?2\\}?\\s*[-+]?\\s*G_\\{?[EM]\\}?', // \tau G_M^2 - G_E^2
      'F_\\{?[AP]\\}?\\^\\{?2\\}?\\s*[+-].*F_\\{?[AP]\\}?', // F_A^2 + ... F_P
      'r_\\{?\\\\ell\\}?\\^\\{?2\\}?',                     // r_\ell^2
    ],
  },
  {
    type: 'axial_radius',
    signals: [
      'axial radius', 'axial mass', 'dipole',
    ],
    latexPatterns: [
      '\\\\langle\\s*r_\\{?A\\}?\\^\\{?2\\}?\\s*\\\\rangle', // <r_A^2>
      '\\\\frac\\{12\\}\\{M_\\{?A\\}?\\^\\{?2\\}?\\}',     // \frac{12}{M_A^2}
      'M_\\{?A\\}?\\^\\{?2\\}?',                            // M_A^2
    ],
  },
  {
    type: 'coulomb_wave',
    signals: [
      'Coulomb', 'wave function', 'scattering state',
    ],
    latexPatterns: [
      '\\\\Phi\\^\\{?\\\\rm\\s*C\\}?\\s*\\(\\s*\\\\bm', // \Phi^{\rm C}(\bm
      '\\\\Psi_\\{?0\\}?\\s*\\(\\s*r\\s*;\\s*k',         // \Psi_0(r; k
      '\\\\Phi_\\{?0\\}?\\^\\{?\\\\rm\\s*C\\}?',         // \Phi_0^{\rm C}
    ],
  },
  {
    type: 'lattice_propagator_element',
    signals: [
      'propagator', 'matrix element', 'lattice QCD',
    ],
    latexPatterns: [
      'p_?\\{?m\\s*,\\s*n\\}?\\s*=.*U\\^\\{?m\\}?.*U\\^\\{?n\\}?', // p_{m,n} = ... U^m | U^n
      'P\\s*U\\^\\{?[mn]\\}?\\s*\\|\\s*U\\^\\{?[mn]\\}?', // P U^m | U^n
    ],
  },
  {
    type: 'determinant_representation',
    signals: [
      'determinant', 'fermion integral', 'Grassmann',
    ],
    latexPatterns: [
      '\\\\det\\{.*\\}\\s*=\\s*\\\\int.*\\{\\\\mathcal\\s*D\\}', // \det{...} = \int \mathcal{D}
      '\\\\det\\{.*M.*U.*\\}',                            // \det{M[U]}
      'e\\^\\{?-\\\\Phi\\^\\{?\\\\dag\\}?.*M.*\\\\Phi', // e^{-\Phi^\dag M \Phi}
      '\\\\mathcal\\s*M.*U.*\\\\Phi',                     // \mathcal{M}[U] \Phi
    ],
  },
  {
    type: 'hamiltonian_form',
    signals: [
      'Hamiltonian', 'canonical', 'conjugate momentum',
    ],
    latexPatterns: [
      '\\{\\\\mathcal\\s*H\\}\\s*=\\s*\\\\frac\\{1\\}\\{2\\}\\s*\\\\pi\\^\\{?2\\}?', // \mathcal{H} = 1/2 \pi^2
      'S\\s*\\[?\\s*\\\\phi\\s*\\]?',                     // S[\phi]
    ],
  },
  {
    type: 'hamilton_equation',
    signals: [
      'Hamilton equation', 'equation of motion', 'dynamics',
    ],
    latexPatterns: [
      '\\\\dot\\{\\\\phi\\}\\s*=\\s*\\\\pi',              // \dot{\phi} = \pi
      '\\\\dot\\{\\\\pi\\}\\s*=\\s*-\\\\frac\\{\\\\partial', // \dot{\pi} = -\partial
      'd\\s*p.*\\\\le.*d.*\\\\rho',                       // dp \le d\rho
    ],
  },
  {
    type: 'rational_approximation',
    signals: [
      'rational approximation', 'partial fraction',
    ],
    latexPatterns: [
      'r\\s*\\(\\s*x\\s*\\)\\s*=\\s*\\\\sum.*\\\\frac\\{\\\\alpha', // r(x) = \sum \alpha_i/(x + \beta_i)
      '\\\\frac\\{\\\\alpha_\\{?i\\}?\\}\\{x\\s*\\+\\s*\\\\beta', // \alpha_i/(x + \beta_i)
    ],
  },
  {
    type: 'dirac_operator',
    signals: [
      'Dirac operator', 'Dirac action', 'fermion action',
    ],
    latexPatterns: [
      '\\\\bar\\\\Psi\\s*\\\\gamma_\\{?\\\\mu\\}?\\s*D_\\{?\\\\mu\\}?', // \bar\Psi \gamma_\mu D_\mu
      '\\\\bar\\\\Psi.*\\+\\s*m\\s*\\\\Psi',              // \bar\Psi ... + m \Psi
      '\\\\slashchar\\s*D\\s*\\+\\s*m',                   // \slashchar D + m
    ],
  },
  {
    type: 'lattice_constraint',
    signals: [
      'constraint', 'inequality', 'bound',
    ],
    latexPatterns: [
      'd\\s*p\\s*\\(\\s*w\\s*,\\s*\\\\rho\\s*\\)\\s*\\\\le', // dp(w,\rho) \le
      '\\\\le\\s*d\\s*\\(\\s*w\\s*,\\s*\\\\rho\\s*\\)',   // \le d(w,\rho)
    ],
  },
  {
    type: 'neural_network',
    signals: [
      'neural network', 'deep learning', 'layer',
    ],
    latexPatterns: [
      '\\\\vec\\{?x\\}?_\\{?\\\\ell\\+1\\}?\\s*=\\s*\\\\sigma', // \vec{x}_{\ell+1} = \sigma
      '\\\\mathbb\\{W\\}_\\{?\\\\ell\\}?',                // \mathbb{W}_\ell
      '\\\\vec\\{?b\\}?_\\{?\\\\ell\\}?',                 // \vec{b}_\ell
      '\\\\nabla_\\{?\\\\mathbb\\{W\\}',                  // \nabla_{\mathbb{W}}
    ],
  },
  {
    type: 'gradient_descent',
    signals: [
      'gradient descent', 'learning', 'update rule',
    ],
    latexPatterns: [
      '\\^\\{?m\\+1\\}?\\s*=.*\\^\\{?m\\}?\\s*-\\s*\\\\eta\\s*\\\\nabla', // ^{m+1} = ... ^m - \eta \nabla
      '\\\\eta\\s*\\\\nabla',                              // \eta \nabla
    ],
  },
  {
    type: 'convergence_criterion',
    signals: [
      'convergence', 'approximation', 'error bound',
    ],
    latexPatterns: [
      'f.*-.*G.*<\\s*\\\\epsilon',                        // f - G < \epsilon
      '\\|.*\\|\\s*<\\s*\\\\epsilon',                     // ||...|| < \epsilon
    ],
  },
  {
    type: 'neutrino_mixing',
    signals: [
      'neutrino mixing', 'PMNS', 'flavor oscillation',
    ],
    latexPatterns: [
      '\\\\nu_\\{?[Le]\\s*\\\\alpha\\}?\\s*=\\s*V',       // \nu_{L\alpha} = V
      'V_\\{?\\\\nu\\}?_\\{?\\\\alpha\\s*i\\}?\\s*\\\\nu', // V_\nu_{\alpha i} \nu
      'V_\\{?\\\\nu\\}?\\s*=\\s*1\\s*\\+\\s*\\\\eta',     // V_\nu = 1 + \eta
    ],
    caseSensitiveTerms: ['PMNS'],
  },
  {
    type: 'rotation_matrix_element',
    signals: [
      'rotation matrix', 'mixing angle', 'unitary matrix',
    ],
    latexPatterns: [
      'V\\^\\{?\\(\\s*23\\s*\\)\\}?\\s*=.*\\\\begin\\{tabular\\}', // V^{(23)} = \begin{tabular}
      'c_\\{?23\\}?.*s_\\{?23\\}?',                        // c_{23} ... s_{23}
      '\\\\cos\\s*\\\\theta_\\{?23\\}?',                  // \cos\theta_{23}
    ],
  },
  {
    type: 'correlator_decomposition',
    signals: [
      'correlator', 'connected', 'disconnected',
    ],
    latexPatterns: [
      '\\\\Pi\\^\\{?\\\\conn\\}?',                         // \Pi^{conn}
      '\\\\Pi\\^\\{?f\\}?_\\{?\\\\mu\\\\nu\\}?',          // \Pi^f_{\mu\nu}
      '\\\\widehat\\{\\\\Pi\\}',                           // \widehat{\Pi}
      '\\\\Lsymx',                                          // \Lsym (lattice symmetrization)
      '\\\\Lb\\^\\{?\\\\Lambda\\}?',                       // \Lb^\Lambda
    ],
  },
  {
    type: 'nucleon_interpolator',
    signals: [
      'interpolator', 'nucleon operator', 'baryon field',
    ],
    latexPatterns: [
      '\\\\Psi_\\{?\\\\alpha\\}?.*\\\\varepsilon_\\{?abc\\}?', // \Psi_\alpha ... \varepsilon_{abc}
      '\\\\tilde\\{[ud]\\}_\\{?[abc]\\}?\\^\\{?T\\}?',    // \tilde{u}_a^T
      'C\\s*\\\\gamma_\\{?5\\}?.*\\\\tilde\\{[ud]\\}',    // C\gamma_5 \tilde{d}
    ],
  },
  {
    type: 'smearing',
    signals: [
      'smearing', 'Gaussian smearing', 'link smearing',
    ],
    latexPatterns: [
      '\\\\tilde\\{q\\}\\s*=\\s*1\\s*\\+\\s*\\\\kappa_\\{?G\\}?', // \tilde{q} = 1 + \kappa_G
      '\\\\triangle\\^\\{?N_\\{?G\\}?\\}?\\s*q',          // \triangle^{N_G} q
    ],
  },
  {
    type: 'z_expansion_sum',
    signals: [
      'z-expansion', 'form factor fit',
    ],
    latexPatterns: [
      'G\\^\\{?z\\}?.*=\\s*\\\\sum_\\{?k\\s*=\\s*0\\}?.*a_\\{?k\\}?\\s*z\\^\\{?k\\}?', // G^z = \sum a_k z^k
      '\\\\sum_\\{?k\\s*=\\s*0\\}?\\^\\{?n\\}?.*z\\^\\{?k\\}?\\s*\\(\\s*Q\\^\\{?2\\}?', // \sum z^k(Q^2)
    ],
  },
  {
    type: 'gamma_trace',
    signals: [
      'gamma trace', 'Fierz', 'spinor algebra',
    ],
    latexPatterns: [
      'F\\^\\{?[A-Z]{2}\\}?_\\{?[A-Z]{2}\\}?\\s*=.*tr\\s*\\(\\s*\\\\Gamma', // F^{AB}_{CD} = ... tr(\Gamma
      'tr\\s*\\(\\s*\\\\Gamma\\^\\{?[A-Z]\\}?.*\\\\Gamma', // tr(\Gamma^A ... \Gamma
    ],
  },
  {
    type: 'susy_coupling',
    signals: [
      'supersymmetric coupling', 'squark', 'neutralino',
    ],
    latexPatterns: [
      '\\\\bar\\{q\\}.*C_\\{?[qQ][LR]\\}?\\s*P_\\{?[LR]\\}?', // \bar{q} C_{qL} P_L
      '\\\\chi\\s*\\\\tilde\\{q',                          // \chi \tilde{q}
      '\\\\tilde\\{q_\\{?1\\}?\\}',                        // \tilde{q_1}
    ],
  },
  {
    type: 'vielbein_gauge',
    signals: [
      'gauge vielbein', 'frame', 'connection',
    ],
    latexPatterns: [
      'V\\^\\{?st\\}?\\s*=\\s*\\\\frac\\{?t\\}?\\{?2\\}?\\s*1\\s*-\\s*\\\\frac\\{?\\\\ell\\}?', // V^{st} = t/2 (1 - \ell/f)
      '\\\\tilde\\{?\\\\ell\\}?\\s*/\\s*f\\s*d\\s*\\\\chi', // \tilde{\ell}/f d\chi
    ],
  },
  {
    type: 'susy_eigenvalue',
    signals: [
      'eigenvalue', 'BPS', 'supersymmetric spectrum',
    ],
    latexPatterns: [
      'X\\s*=\\s*\\\\tfrac\\{.*j.*\\}\\{.*\\\\ell\\}?\\^\\{?2\\}?', // X = \tfrac{2j+2}{\ell}^2
      '\\\\sigma\\s*\\\\alpha\\^\\{?2\\}?',                // \sigma \alpha^2
    ],
  },
  {
    type: 'cs_action',
    signals: [
      'Chern-Simons', 'topological action', 'gauge theory',
    ],
    latexPatterns: [
      '\\\\int.*\\\\text\\{Tr\\}.*A\\s*\\\\wedge\\s*\\\\ast\\s*A', // \int Tr A \wedge \ast A
      '\\\\varphi\\s*\\\\wedge\\s*\\\\ast\\s*\\\\varphi', // \varphi \wedge \ast \varphi
      '\\\\pi\\s*\\\\sum_\\{?i\\}?\\s*x_\\{?i\\}?\\^\\{?2\\}?', // \pi \sum x_i^2
    ],
  },
  {
    type: 'lippmann_schwinger',
    signals: [
      'Lippmann-Schwinger', 'T-matrix', 'scattering equation',
    ],
    latexPatterns: [
      'T_\\{?[Kd\\\\pi]+\\}?\\s*=\\s*V_\\{?[Kd\\\\pi]+\\}?\\s*\\+\\s*V', // T_Kd = V_Kd + V
      'V.*G.*T',                                          // V G T
      't_\\{?K\\^\\{?-\\}?[pn]\\s*\\\\to',                // t_{K^- p \to
    ],
    caseSensitiveTerms: ['Lippmann-Schwinger'],
  },
  {
    type: 'impulse_approximation',
    signals: [
      'impulse approximation', 'IA', 'multiple scattering',
    ],
    latexPatterns: [
      '\\^\\{?\\\\mathrm\\{IA\\}\\}?',                    // ^{\mathrm{IA}}
      't_\\{?[Kn\\\\pi].*\\\\to.*\\}?\\s*\\+\\s*t_\\{?', // t_{K^-p\to} + t_{
    ],
  },
  {
    type: 'numerical_result_only',
    signals: [
      'numerical result', 'value',
    ],
    latexPatterns: [
      '&\\s*-?\\d+\\.\\d{2,}',                            // & 0.072, & -0.584
      '^\\s*-?\\d+\\.\\d{2,}\\s*$',                       // just a number
    ],
  },
  {
    type: 'chiral_transformation',
    signals: [
      'chiral transformation', 'axial rotation',
    ],
    latexPatterns: [
      '\\\\psi\\s*\\\\rightarrow.*e\\^\\{?i\\s*\\\\theta\\s*\\\\gamma_\\{?5\\}?', // \psi \to e^{i\theta\gamma_5} \psi
      '\\\\overline\\s*\\\\psi\\s*\\\\rightarrow',        // \bar\psi \to
      'e\\^\\{?i\\s*\\\\theta.*\\\\gamma_\\{?5\\}?\\s*/\\s*2\\}?', // e^{i\theta\gamma_5/2}
    ],
  },
  {
    type: 'gauge_transformation_lattice',
    signals: [
      'gauge transformation', 'lattice gauge',
    ],
    latexPatterns: [
      'g\\s*\\\\rightarrow\\s*g_\\{?[LR]\\}?\\^\\{?\\\\dagger\\}?\\s*g\\s*g_\\{?[LR]\\}?', // g \to g_L^\dag g g_R
      '\\\\myeqname',                                     // \myeqname (custom equation marker)
    ],
  },
  {
    type: 'ricci_component',
    signals: [
      'Ricci tensor', 'Einstein equation', 'curvature component',
    ],
    latexPatterns: [
      'R_\\{?0\\}?\\^\\{?0\\}?\\s*=\\s*\\d.*\\\\pi\\s*G', // R_0^0 = 4\pi G
      'R_\\{?\\\\mu\\}?\\^\\{?\\\\nu\\}?\\s*=',           // R_\mu^\nu =
    ],
  },
  {
    type: 'gravitational_potential',
    signals: [
      'gravitational potential', 'Poisson integral', 'Newtonian',
    ],
    latexPatterns: [
      '\\\\varphi\\s*=\\s*-\\s*G\\s*\\\\int',             // \varphi = -G \int
      '\\\\frac\\{\\\\mu.*\\}\\{R\\}.*dV',                // \mu/R dV
      '-\\s*G\\s*\\\\int.*\\\\frac\\{.*\\}\\{R\\}',       // -G \int .../R
    ],
  },
  {
    type: 'pcac_relation',
    signals: [
      'PCAC', 'partial conservation', 'axial current',
    ],
    latexPatterns: [
      'M_\\{?N\\}?\\s*F_\\{?A\\}?.*-.*q\\^\\{?2\\}?\\s*F_\\{?P\\}?', // M_N F_A - q^2 F_P
      '2\\s*m\\s*G_\\{?P\\}?',                             // 2m G_P
      'F_\\{?A\\}?.*q\\^\\{?2\\}?.*F_\\{?P\\}?.*G_\\{?P\\}?', // F_A ... q^2 ... F_P ... G_P
    ],
    caseSensitiveTerms: ['PCAC'],
  },
  {
    type: 'gff_moment',
    signals: [
      'GFF', 'gravitational form factor', 'momentum fraction',
    ],
    latexPatterns: [
      '\\\\langle\\s*x\\s*\\\\rangle_\\{?[qg]\\s*,\\s*[qg]?\\}?', // <x>_{q,g}
      'A_\\{?[qg]\\s*,?\\s*[qg]?\\}?\\s*\\(\\s*0\\s*\\)', // A_{q,g}(0)
      'B_\\{?[qg]\\s*,?\\s*[qg]?\\}?\\s*\\(\\s*0\\s*\\)', // B_{q,g}(0)
      'J_\\{?[qg]\\}?\\s*=\\s*\\\\frac\\{1\\}\\{2\\}\\s*A', // J_q = 1/2 A
    ],
  },
  {
    type: 'lattice_momentum',
    signals: [
      'lattice momentum', 'Brillouin zone', 'momentum components',
    ],
    latexPatterns: [
      '\\\\Pi\\s*=\\s*\\(\\s*p_\\{?0\\}?',                 // \Pi = (p_0, p_1, ...
      'p_\\{?\\\\mu\\}?\\s*\\\\in.*\\\\pi\\s*/\\s*a',     // p_\mu \in (0, \pi/a)
      'P\\^\\{?2\\}?_\\{?\\\\mu\\}?\\s*=\\s*\\\\frac\\{2\\}\\{a\\^\\{?2\\}?\\}', // P^2_\mu = \frac{2}{a^2}
      '1\\s*-\\s*\\\\cos.*a\\s*p_\\{?\\\\mu\\}?',          // 1 - \cos(ap_\mu)
      'P_\\{?\\\\mu\\}?\\s*=\\s*p_\\{?\\\\mu\\}?',         // P_\mu = p_\mu
    ],
  },
  {
    type: 'lattice_field_transform',
    signals: [
      'field transformation', 'lattice field', 'spinor field',
    ],
    latexPatterns: [
      '\\\\Psi.*=\\s*\\\\Gamma.*\\\\chi',                  // \Psi = \Gamma \chi
      '\\\\bar\\\\Psi.*=\\s*\\\\bar\\\\chi.*\\\\Gamma\\^\\{?\\\\dag', // \bar\Psi = \bar\chi \Gamma^\dag
      '\\\\Gamma\\s*\\(\\s*x\\s*\\)\\s*\\\\chi',          // \Gamma(x) \chi
    ],
  },
  {
    type: 'activation_function',
    signals: [
      'ReLU', 'activation', 'neural network',
    ],
    latexPatterns: [
      '\\\\text\\{ReLU\\}.*=.*\\\\Theta',                  // ReLU(x) = x \Theta(x)
      'x\\s*\\\\Theta\\s*\\(\\s*x\\s*\\)',                // x \Theta(x)
      '\\\\sigma\\s*\\(\\s*x\\s*\\)\\s*=',                // \sigma(x) =
    ],
  },
  {
    type: 'likelihood_ratio',
    signals: [
      'likelihood', 'probability', 'classifier',
    ],
    latexPatterns: [
      'p_\\{?[sb]\\}?\\s*\\(\\s*x\\s*\\)\\s*=\\s*p\\s*\\(\\s*x\\s*\\|', // p_s(x) = p(x|s)
      '\\{\\\\cal\\s*L\\}\\s*=\\s*\\\\frac\\{p_\\{?s\\}?', // \calL = \frac{p_s}{p_b}
      '\\\\Sigma_\\{?b\\}?\\^\\{?-1\\}?\\s*\\\\alpha',    // \Sigma_b^{-1} \alpha
    ],
  },
  {
    type: 'ppd_form_factor',
    signals: [
      'PPD', 'pion pole dominance', 'pseudoscalar form factor',
    ],
    latexPatterns: [
      'F\\^\\{?\\\\mathrm\\{PPD\\}\\}?_\\{?P\\}?',         // F^{PPD}_P
      'G_\\{?P\\}?\\^\\{?\\\\mathrm\\{PPD\\}\\}?',         // G_P^{PPD}
      '\\\\frac\\{.*M_\\{?N\\}?.*F_\\{?A\\}?\\}\\{.*q\\^\\{?2\\}?\\s*\\+\\s*M_\\{?\\\\pi\\}?', // M_N F_A / (q^2 + M_\pi^2)
    ],
  },
  {
    type: 'hmc_acceptance',
    signals: [
      'HMC', 'Metropolis', 'acceptance probability',
    ],
    latexPatterns: [
      'P_\\{?\\\\mathrm\\{acc\\}?\\}?\\s*\\(\\s*U',        // P_{acc}(U, U')
      '\\\\mathrm\\{min\\}\\s*\\(\\s*1\\s*,',              // min(1, ...
      '\\\\frac\\{P.*U.*\\}\\{P.*U.*\\}',                  // \frac{P(U')}{P(U)}
    ],
  },
  {
    type: 'fermion_determinant_lattice',
    signals: [
      'fermion determinant', 'pseudofermion', 'lattice fermion',
    ],
    latexPatterns: [
      '\\\\mathrm\\{det\\}.*D.*U.*m\\^\\{?f\\}?',          // det D[U, m^f]
      '\\\\mathcal\\{D\\}\\s*\\[\\s*\\\\eta\\s*\\].*\\\\eta\\^\\{?\\\\dagger\\}?\\s*D', // D[\eta] ... \eta^\dag D
    ],
  },
  {
    type: 'gamma_product',
    signals: [
      'gamma matrix', 'Dirac matrix', 'lattice gamma',
    ],
    latexPatterns: [
      '\\\\Gamma.*=\\s*\\\\prod.*\\\\gamma',              // \Gamma = \prod \gamma
      '\\\\gamma_\\{?\\\\mu\\}?\\^\\{?.*x_\\{?\\\\mu\\}?', // \gamma_\mu^{x_\mu/a}
      '\\\\gamma_\\{?5\\}?\\s*\\\\tau_\\{?3\\}?',         // \gamma_5 \tau_3
    ],
  },
  {
    type: 'staggered_fermion',
    signals: [
      'staggered fermion', 'Kogut-Susskind', 'taste',
    ],
    latexPatterns: [
      '\\\\bar\\\\chi.*\\\\eta_\\{?\\\\mu\\}?.*D_\\{?\\\\mu\\}?', // \bar\chi \eta_\mu D_\mu
      '\\\\eta_\\{?\\\\mu\\}?\\s*\\(\\s*x\\s*\\)\\s*=\\s*-?1\\^', // \eta_\mu(x) = (-1)^
      '-?1\\^\\{?\\\\sum.*x_\\{?\\\\nu\\}?',              // (-1)^{\sum x_\nu}
    ],
  },
  {
    type: 'wilson_fermion_action',
    signals: [
      'Wilson fermion', 'Wilson term', 'clover term',
    ],
    latexPatterns: [
      'M_\\{?W\\}?\\s*=\\s*\\\\gamma_\\{?\\\\mu\\}?\\s*D_\\{?\\\\mu\\}?\\s*\\+\\s*m\\s*\\+\\s*\\\\frac\\{r\\}\\{2\\}', // M_W = \gamma_\mu D_\mu + m + r/2
      '\\\\Box',                                           // \Box (Laplacian)
      '\\\\frac\\{r\\}\\{2\\}\\s*\\\\Box',                // r/2 \Box
    ],
  },
  {
    type: 'twisted_mass_fermion',
    signals: [
      'twisted mass', 'tm fermion', 'tmQCD',
    ],
    latexPatterns: [
      'i\\s*\\\\mu\\s*\\\\gamma_\\{?5\\}?\\s*\\\\tau_\\{?3\\}?', // i\mu \gamma_5 \tau_3
      '\\\\hat\\{M\\}_\\{?tm\\}?',                         // \hat{M}_{tm}
      '\\\\tan\\s*\\\\alpha\\s*=\\s*\\\\frac\\{\\\\mu\\}\\{m\\}', // \tan\alpha = \mu/m
    ],
  },
  {
    type: 'chiral_rotation_lattice',
    signals: [
      'chiral rotation', 'axial rotation', 'lattice chiral',
    ],
    latexPatterns: [
      '\\\\bar\\\\Psi\\s*\\\\rightarrow\\s*\\\\bar\\\\Psi.*e\\^\\{?i.*\\\\gamma_\\{?5\\}?', // \bar\Psi \to \bar\Psi e^{i...\gamma_5}
      '\\\\Psi\\s*\\\\rightarrow.*e\\^\\{?i.*\\\\gamma_\\{?5\\}?.*\\\\Psi', // \Psi \to e^{i...\gamma_5} \Psi
      '1\\s*\\+\\s*i\\s*\\\\gamma_\\{?5\\}?',              // 1 + i\gamma_5
      '1\\s*\\+\\s*i\\s*\\\\hat\\{?\\\\gamma\\}?_\\{?5\\}?', // 1 + i\hat\gamma_5
    ],
  },
  {
    type: 'ginsparg_wilson',
    signals: [
      'Ginsparg-Wilson', 'overlap fermion', 'chiral lattice',
    ],
    latexPatterns: [
      '\\\\hat\\{?\\\\gamma\\}?_\\{?5\\}?\\s*=\\s*\\\\gamma_\\{?5\\}?.*1\\s*-\\s*2\\s*a\\s*R\\s*M', // \hat\gamma_5 = \gamma_5(1-2aRM)
      '\\\\tilde\\{1\\}\\s*=\\s*1\\s*-\\s*a\\s*R\\s*M',   // \tilde{1} = 1 - aRM
      '\\\\hat\\\\Psi\\s*=\\s*\\\\tilde\\{1\\}\\s*\\\\Psi', // \hat\Psi = \tilde{1}\Psi
    ],
  },
  {
    type: 'overlap_operator',
    signals: [
      'overlap operator', 'Neuberger operator',
    ],
    latexPatterns: [
      'M_\\{?o\\}?\\s*=\\s*\\\\rho.*\\\\frac\\{M_\\{?W\\}?\\s*-\\s*\\\\rho\\}', // M_o = \rho (M_W - \rho)/...
      '\\\\sqrt\\{M\\^\\{?\\\\dag\\}?.*M.*\\}',           // \sqrt{M^\dag M}
    ],
  },
  {
    type: 'gluon_operator',
    signals: [
      'gluon operator', 'field strength', 'plaquette operator',
    ],
    latexPatterns: [
      '\\\\mathcal\\{O\\}_\\{?0\\}?\\s*=\\s*\\\\text\\{Tr\\}.*F_\\{?\\\\mu\\\\nu\\}?', // O_0 = Tr F_{\mu\nu}
      '\\\\mathcal\\{O\\}_\\{?[12]\\}?\\s*&?=\\s*\\\\text\\{Tr\\}.*D', // O_1 = Tr D...
      '\\\\text\\{Tr\\}.*F_\\{?\\\\mu\\\\nu\\}?.*F_\\{?\\\\mu\\\\nu\\}?', // Tr F_{\mu\nu} F_{\mu\nu}
    ],
  },
  {
    type: 'link_expansion',
    signals: [
      'link variable', 'gauge link', 'exponential map',
    ],
    latexPatterns: [
      'U_\\{?\\\\mu\\}?.*=\\s*e\\^\\{?i\\s*g\\s*a\\s*A', // U_\mu = e^{igaA}
      '1\\s*\\+\\s*i\\s*g\\s*a\\s*A_\\{?\\\\mu\\}?',     // 1 + igaA_\mu
      'U_\\{?\\\\mu\\}?\\s*=\\s*U_\\{?\\\\mu\\}?\\^\\{?\\\\text\\{\\(UV\\)\\}\\}?.*U_\\{?\\\\mu\\}?\\^\\{?\\\\text\\{\\(IR\\)\\}\\}?', // U = U^{(UV)} U^{(IR)}
      'u_\\{?0\\}?\\s*e\\^\\{?i\\s*g\\s*a\\s*A',          // u_0 e^{igaA}
    ],
  },
  {
    type: 'tadpole_improvement',
    signals: [
      'tadpole', 'mean field', 'plaquette expectation',
    ],
    latexPatterns: [
      'u_\\{?0\\}?\\s*=\\s*\\\\frac\\{1\\}\\{3\\}.*\\\\text\\{.*Tr\\}?.*U_\\{?\\\\mu\\\\nu\\}?', // u_0 = 1/3 Tr U_{\mu\nu}
      '\\\\text\\{ReTr\\}.*U.*\\^\\{?1/4\\}?',            // ReTr U^{1/4}
    ],
  },
  {
    type: 'smearing_transformation',
    signals: [
      'APE smearing', 'HYP smearing', 'Wuppertal smearing',
    ],
    latexPatterns: [
      'V_\\{?\\\\mu\\}?\\s*\\(\\s*x\\s*\\)\\s*=\\s*e\\^\\{?\\\\rho\\s*S', // V_\mu(x) = e^{\rho S}
      'S_\\{?\\\\mu\\}?\\s*\\(\\s*x\\s*\\)',               // S_\mu(x)
    ],
  },
  {
    type: 'propagator_relation',
    signals: [
      'propagator', 'Green function', 'inverse',
    ],
    latexPatterns: [
      'S_\\{?U\\}?\\s*\\(\\s*[xy]\\s*,\\s*[xy]\\s*\\)\\s*=\\s*M_\\{?U\\}?\\^\\{?-1\\}?', // S_U(y,x) = M_U^{-1}
      'S_\\{?U\\}?.*=\\s*\\\\gamma_\\{?5\\}?\\s*S\\^\\{?\\\\dag\\}?.*\\\\gamma_\\{?5\\}?', // S = \gamma_5 S^\dag \gamma_5
      'S_\\{?U\\}?.*=\\s*\\\\epsilon\\s*S\\^\\{?\\\\dag\\}?.*\\\\epsilon', // S = \epsilon S^\dag \epsilon
    ],
  },
  {
    type: 'hadron_interpolator',
    signals: [
      'interpolating operator', 'hadron operator', 'meson operator',
    ],
    latexPatterns: [
      '\\\\mathcal\\{[OPAN]\\}.*=\\s*\\\\bar\\\\Psi.*\\\\gamma.*\\\\Psi', // O = \bar\Psi \gamma \Psi
      '\\\\mathcal\\{P\\}_\\{?l\\}?.*=\\s*\\\\bar\\\\Psi.*\\\\gamma_\\{?5\\}?\\s*\\\\Psi', // P_l = \bar\Psi \gamma_5 \Psi
      '\\\\mathcal\\{A\\}_\\{?0\\}?.*=\\s*\\\\bar\\\\Psi.*\\\\gamma_\\{?0\\}?\\s*\\\\gamma_\\{?5\\}?', // A_0 = \bar\Psi \gamma_0\gamma_5 \Psi
    ],
  },
  {
    type: 'correlation_function_lattice',
    signals: [
      'correlator', 'two-point function', 'Wick contraction',
    ],
    latexPatterns: [
      'G_\\{?PP\\}?\\s*\\(\\s*x\\s*,\\s*0\\s*\\)\\s*&?=', // G_{PP}(x,0) =
      '\\\\langle\\s*0\\s*\\|\\s*\\\\mathcal\\{[OP]\\}.*\\|\\s*0\\s*\\\\rangle', // <0|O...P|0>
      '-\\\\text\\{Tr\\}\\s*S\\^\\{?\\\\dag\\}?.*S',      // -Tr S^\dag S
    ],
  },
  {
    type: 'nucleon_interpolator_lattice',
    signals: [
      'nucleon operator', 'baryon interpolator',
    ],
    latexPatterns: [
      '\\\\mathcal\\{[ND]\\}\\^\\{?\\\\text\\{\\([12]\\)\\}\\}?.*=\\s*\\\\epsilon_\\{?abc\\}?', // N^{(1)} = \epsilon_{abc}
      '\\\\epsilon_\\{?abc\\}?\\s*[ud]\\^\\{?T\\}?.*C\\s*\\\\gamma_\\{?5\\}?', // \epsilon_{abc} u^T C\gamma_5
      '\\\\epsilon_\\{?abc\\}?\\s*[ud]\\^\\{?T\\}?.*C.*[ud]', // \epsilon_{abc} u^T C d
    ],
  },
  {
    type: 'matrix_element_hadron',
    signals: [
      'matrix element', 'overlap', 'transition',
    ],
    latexPatterns: [
      '\\\\langle\\s*0\\s*\\|\\s*\\\\mathcal\\{O\\}.*\\|\\s*h\\s*\\\\rangle\\s*\\\\neq\\s*0', // <0|O|h> \neq 0
      '\\\\mathcal\\{A\\}_\\{?[fi]\\}?\\s*&?=\\s*\\\\langle.*\\|.*\\\\mathcal\\{O\\}', // A_f = <...|O|...>
    ],
  },
  {
    type: 'scet_lagrangian',
    signals: [
      'SCET', 'soft-collinear', 'Lagrangian',
    ],
    latexPatterns: [
      '\\\\c[LH]\\^\\{?0\\}?\\s*=\\s*\\\\c[LH]\\^\\{?0\\}?_\\{?B', // \cL^0 = \cL^0_{B}
      '\\\\cL\\^\\{?0\\}?_\\{?[BJS]_?\\d?\\}?',            // \cL^0_{B_1}, \cL^0_J
    ],
    caseSensitiveTerms: ['SCET'],
  },
  {
    type: 'state_factorization',
    signals: [
      'state factorization', 'Fock state',
    ],
    latexPatterns: [
      '\\|\\s*X\\s*\\\\rangle\\s*\\\\to\\s*\\|\\s*X_\\{?1\\}?\\s*\\\\rangle\\s*\\|\\s*X_\\{?2\\}?', // |X> \to |X_1>|X_2>
      '\\|\\s*X_\\{?[1-4s]\\}?\\s*\\\\rangle',            // |X_1>, |X_s>
    ],
  },
  {
    type: 'rge_beam_jet',
    signals: [
      'beam function', 'jet function', 'RGE', 'anomalous dimension',
    ],
    latexPatterns: [
      '\\\\dlog\\{?\\\\mu\\}?\\{B_\\{?i\\}?',              // \dlog\mu{B_i}
      '\\\\gMuB\\s*\\(\\s*\\\\mu',                         // \gMuB(\mu
      '\\\\dlog\\{?\\\\nu\\}?\\{',                         // \dlog\nu{
    ],
  },
  {
    type: 'eec_observable',
    signals: [
      'EEC', 'energy correlator', 'celestial',
    ],
    latexPatterns: [
      '\\\\langle.*\\\\mathcal\\{E\\}.*n_\\{?[ab]\\}?.*\\\\mathcal\\{E\\}.*\\\\rangle', // <P \mathcal{E}(n_a) \mathcal{E}(n_b) P>
      '\\\\hat\\{\\{?\\\\cal\\s*E\\}?\\}?\\s*\\(\\s*\\\\theta', // \hat{\calE}(\theta)
      '\\\\zeta_\\{?ij\\}?\\s*=\\s*\\\\frac\\{1\\s*-\\s*\\\\cos\\s*\\\\theta', // \zeta_{ij} = (1 - cos\theta)/2
    ],
    caseSensitiveTerms: ['EEC', 'EEEC'],
  },
  {
    type: 'lightcone_momentum',
    signals: [
      'lightcone', 'momentum component', 'Sudakov',
    ],
    latexPatterns: [
      'P_\\{?[12]\\}?\\^\\{?\\\\mu\\}?\\s*=\\s*P\\s*n_\\{?[12]\\}?\\^\\{?\\\\mu\\}?', // P_1^\mu = P n_1^\mu
      'n_\\{?[ab]\\}?\\s*\\\\cdot\\s*n_\\{?[ab]\\}?',     // n_a \cdot n_b
      'n_\\{?[ab]\\}?\\s*\\\\cdot\\s*P_\\{?[12]\\}?',     // n_a \cdot P_1
    ],
  },
  {
    type: 'lorentz_generator',
    signals: [
      'Lorentz generator', 'boost', 'rotation',
    ],
    latexPatterns: [
      'n_\\{?[ab]\\}?\\s*M\\^\\{?[0\\\\pm]\\s*[ab\\\\pm]\\}?', // n_a M^{0a}
      'M\\^\\{?[-+]\\s*[\\\\pma]\\}?',                     // M^{-+}, M^{-a}
      '\\\\varepsilon.*M\\^\\{?ab\\}?',                    // \varepsilon M^{ab}
    ],
  },
  {
    type: 'conformal_transformation',
    signals: [
      'conformal', 'Lorentz transformation', 'tensor transformation',
    ],
    latexPatterns: [
      'U_\\{?\\\\Lambda\\}?\\s*\\\\mathcal\\{O\\}.*U_\\{?\\\\Lambda\\}?\\^\\{?-1\\}?', // U_\Lambda O U_\Lambda^{-1}
      '\\\\Lambda.*\\^\\{?\\\\mu_\\{?1\\}?\\}?.*\\\\Lambda', // \Lambda^{\mu_1} ... \Lambda
    ],
  },
  {
    type: 'energy_operator',
    signals: [
      'energy operator', 'energy flow', 'detector',
    ],
    latexPatterns: [
      '\\\\hat\\{\\{?\\\\cal\\s*E\\}?\\}?\\s*\\(\\s*\\\\theta\\s*\\)\\s*\\|\\s*X\\s*\\\\rangle\\s*=', // \hat{\calE}(\theta)|X> =
      '\\\\sum_\\{?i\\s*\\\\in\\s*X\\}?\\s*\\\\frac\\{E_\\{?i\\}?\\}\\{E_\\{?P\\}?\\}', // \sum_{i\in X} E_i/E_P
      '\\\\Theta\\s*\\(\\s*\\\\theta\\s*-\\s*\\\\theta', // \Theta(\theta - \theta_i)
    ],
  },
  {
    type: 'wilson_line_scet',
    signals: [
      'Wilson line', 'soft Wilson line', 'collinear Wilson line',
    ],
    latexPatterns: [
      'W_\\{?n\\}?\\s*\\(\\s*x\\s*\\)\\s*=\\s*\\\\sum.*\\\\exp', // W_n(x) = \sum \exp
      '\\\\text\\{P\\}\\s*\\\\exp\\s*\\(\\s*-?\\s*\\\\frac\\{g_\\{?s\\}?\\}?', // P\exp(-g_s/...)
      '\\\\bar\\{?n\\}?\\s*\\\\cdot\\s*A_\\{?n\\}?',       // \bar{n}\cdot A_n
    ],
  },
  {
    type: 'commutator_zero',
    signals: [
      'commutator', 'commute',
    ],
    latexPatterns: [
      '\\[\\s*\\\\hat\\{\\{?\\\\cal\\s*E\\}?\\}?\\s*,\\s*[YZ\\\\cal]', // [\hat{\calE}, Y]
      '\\]\\s*=\\s*0',                                     // ] = 0
    ],
  },
  {
    type: 'lightcone_scaling',
    signals: [
      'lightcone scaling', 'power counting', 'lambda',
    ],
    latexPatterns: [
      'p_\\{?c\\}?\\s*=\\s*Q\\s*\\(\\s*1\\s*,\\s*\\\\lambda\\^\\{?2\\}?\\s*,\\s*\\\\lambda', // p_c = Q(1, \lambda^2, \lambda)
      '\\(\\s*1\\s*,\\s*\\\\lambda\\^\\{?2\\}?\\s*,\\s*\\\\lambda\\s*\\)', // (1, \lambda^2, \lambda)
    ],
  },
  {
    type: 'momentum_fraction_soft',
    signals: [
      'soft momentum', 'minus component', 'momentum conservation',
    ],
    latexPatterns: [
      'k\\^\\{?-\\}?\\s*=\\s*-\\s*q\\^\\{?-\\}?\\s*\\+',  // k^- = -q^- +
      '\\\\frac\\{.*\\\\vec\\{[kq]\\}_\\{?\\\\perp\\}?.*\\}\\{.*_\\{?\\\\perp\\}?\\^\\{?2\\}?\\}', // ...\vec{k}_\perp / q_\perp^2
    ],
  },
  {
    type: 'collinear_wilson',
    signals: [
      'collinear Wilson', 'soft factor',
    ],
    latexPatterns: [
      'U_\\{?n\\}?\\s*&?=\\s*\\\\text\\{P\\}\\s*\\\\exp.*\\\\int.*n\\s*\\\\cdot\\s*A', // U_n = P\exp \int n\cdot A
      'A_\\{?cs\\}?\\s*\\(\\s*n\\s*s\\s*\\)',              // A_{cs}(ns)
    ],
  },
  {
    type: 'master_integral',
    signals: [
      'master integral', 'Feynman integral', 'IBP',
    ],
    latexPatterns: [
      '\\\\mathcal\\{I\\}_\\{?\\d\\}?\\s*=\\s*I_\\{?\\d\\}?\\s*\\(', // \mathcal{I}_1 = I_1(
      '\\\\alpha_\\{?0\\}?\\s*,\\s*-?\\d?\\s*\\\\epsilon', // \alpha_0, -2\epsilon
    ],
  },
  {
    type: 'differential_cross_section',
    signals: [
      'differential', 'cross section', 'spectrum',
    ],
    latexPatterns: [
      '\\\\frac\\{\\\\df\\}\\{\\\\df\\s*x_\\{?[RL]\\}?\\}\\s*\\\\sigma', // \frac{d}{dx_L} \sigma
      '\\\\sigma\\^\\{?\\d\\}?_\\{?\\\\text\\{E.*EC\\}\\}?', // \sigma^3_{E^2EC}
    ],
  },
  {
    type: 'splitting_function',
    signals: [
      'splitting function', 'DGLAP kernel',
    ],
    latexPatterns: [
      'P_\\{?[ijqg][ijqg]\\}?\\s*\\(\\s*x\\s*\\)\\s*=\\s*\\\\sum', // P_{ij}(x) = \sum
      '\\\\frac\\{\\\\alpha_\\{?s\\}?\\}\\{4\\s*\\\\pi\\}\\s*\\^\\{?L\\+1\\}?', // (\alpha_s/4\pi)^{L+1}
      'P_\\{?[ijqg][ijqg]\\}?\\^\\{?L\\}?\\s*\\(\\s*x\\s*\\)', // P_{ij}^L(x)
    ],
  },
  {
    type: 'conditional_probability',
    signals: [
      'conditional probability', 'likelihood', 'posterior',
    ],
    latexPatterns: [
      'p_\\{?[sb]\\}?\\s*\\(\\s*x\\s*\\)\\s*=\\s*p\\s*\\(\\s*x\\s*\\|\\s*[sb]\\)', // p_s(x) = p(x|s)
      'p\\s*\\(\\s*x\\s*\\|\\s*[sb]\\s*\\)',               // p(x|s)
    ],
  },
  {
    type: 'auc_metric',
    signals: [
      'AUC', 'ROC', 'classifier metric',
    ],
    latexPatterns: [
      '\\\\text\\{AUC\\}\\s*=\\s*1\\s*-\\s*\\\\frac\\{1\\}\\{2\\}\\s*\\\\int', // AUC = 1 - 1/2 \int
      '\\\\Sigma_\\{?b\\}?.*\\^\\{?2\\}?',                 // \Sigma_b^2
      '\\\\Sigma_\\{?b\\}?\\^\\{?\\\\min\\}?',             // \Sigma_b^{min}
    ],
  },
  {
    type: 'gluon_vertex_function',
    signals: [
      'gluon vertex', 'three-gluon', 'vertex function',
    ],
    latexPatterns: [
      '\\\\Gamma\\^\\{?G\\}?_\\{?\\\\mu\\\\nu\\}?\\s*\\(\\s*k\\^\\{?[+-]\\}?', // \Gamma^G_{\mu\nu}(k^+, k^-)
      '\\\\gamma\\^\\{?G\\}?_\\{?\\\\mu\\\\nu\\}?',        // \gamma^G_{\mu\nu}
    ],
  },
  {
    type: 'tensor_decomposition',
    signals: [
      'tensor decomposition', 'Lorentz structure', 'form factor decomposition',
    ],
    latexPatterns: [
      '\\\\Sigma\\^\\{?F\\}?\\s*\\(\\s*P_\\{?1\\}?\\s*,\\s*P_\\{?2\\}?\\s*\\)\\s*=\\s*\\\\sum', // \Sigma^F(P_1, P_2) = \sum
      't_\\{?i\\}?\\s*T_\\{?i\\}?',                        // t_i T_i
    ],
  },
  {
    type: 'quark_propagator',
    signals: [
      'quark propagator', 'Schwinger-Dyson', 'dressed propagator',
    ],
    latexPatterns: [
      'S\\^\\{?-1\\}?\\s*\\(\\s*k\\s*\\)\\s*=.*\\\\slashed\\{k\\}\\s*\\+\\s*M', // S^{-1}(k) = i\slashed{k} + M
      '\\\\Gamma_\\{?\\\\pi\\}?\\s*\\(\\s*P\\s*\\)\\s*=.*\\\\gamma_\\{?5\\}?', // \Gamma_\pi(P) = i\gamma_5
      'E_\\{?\\\\pi\\}?',                                  // E_\pi
    ],
  },
  {
    type: 'dipole_fit',
    signals: [
      'dipole fit', 'dipole form factor', 'z-expansion fit',
    ],
    latexPatterns: [
      'G\\^\\{?d?z\\}?_\\{?A\\}?\\s*\\(\\s*Q\\^\\{?2\\}?\\s*\\)\\s*=\\s*\\\\frac\\{1\\}\\{.*1\\s*\\+\\s*Q\\^\\{?2\\}?\\s*/\\s*M\\^\\{?2\\}?', // G^z_A(Q^2) = 1/(1+Q^2/M^2)
      '\\\\frac\\{1\\}\\{\\(\\s*1\\s*\\+\\s*Q\\^\\{?2\\}?\\s*/\\s*M\\^\\{?2\\}?\\s*\\)\\^\\{?2\\}?\\}', // 1/(1+Q^2/M^2)^2
    ],
  },
  {
    type: 'lattice_fit_parameter',
    signals: [
      'fit parameter', 'chiral extrapolation', 'continuum extrapolation',
    ],
    latexPatterns: [
      'a_\\{?i\\}?\\s*=\\s*d_\\{?i\\s*,\\s*0\\}?\\s*\\+\\s*d_\\{?i\\s*,\\s*\\\\pi\\}?', // a_i = d_{i,0} + d_{i,\pi}
      'd_\\{?i\\s*,\\s*\\\\pi\\}?\\s*M\\^\\{?2\\}?_\\{?\\\\pi\\}?', // d_{i,\pi} M^2_\pi
      'd_\\{?i\\s*,\\s*a\\}?\\s*a\\^\\{?2\\}?',            // d_{i,a} a^2
    ],
  },
  {
    type: 'covariance',
    signals: [
      'covariance', 'correlation', 'statistical',
    ],
    latexPatterns: [
      '\\\\text\\{Cov\\}\\s*\\(\\s*x\\s*,\\s*y\\s*\\)\\s*=', // Cov(x, y) =
      '\\\\langle\\s*x\\s*y\\s*\\\\rangle\\s*-\\s*\\\\langle\\s*x\\s*\\\\rangle\\s*\\\\langle\\s*y\\s*\\\\rangle', // <xy> - <x><y>
    ],
  },
  {
    type: 'neutrino_mass_dirac',
    signals: [
      'Dirac mass', 'neutrino mass term',
    ],
    latexPatterns: [
      '\\\\overline\\{\\\\nu_\\{?L\\}?\\}\\s*m_\\{?D\\}?\\s*\\\\nu_\\{?R\\}?', // \bar\nu_L m_D \nu_R
      '\\\\overline\\{\\\\nu_\\{?L\\}?\\}\\s*m_\\{?\\\\nu\\}?\\s*\\\\nu_\\{?L\\}?\\^\\{?c\\}?', // \bar\nu_L m_\nu \nu_L^c
      '\\+\\s*h\\.c\\.',                                   // + h.c.
    ],
  },
  {
    type: 'density_matrix',
    signals: [
      'density matrix', 'mixed state', 'quantum state',
    ],
    latexPatterns: [
      '\\\\uprho\\s*=.*\\\\begin\\{tabular\\}',           // \uprho = \begin{tabular}
      '\\\\uprho_\\{?\\\\nu[\\\\nuN]*\\}?',               // \uprho_{\nu\nu}
    ],
  },
  {
    type: 'kinematic_ratio',
    signals: [
      'kinematic ratio', 'scaling variable',
    ],
    latexPatterns: [
      '\\\\eta\\s*=\\s*\\\\frac\\{s\\}\\{.*m\\^\\{?2\\}?\\}', // \eta = s/(4m^2)
      '\\\\xi\\s*=\\s*\\\\frac\\{Q\\^\\{?2\\}?\\}\\{m\\^\\{?2\\}?\\}', // \xi = Q^2/m^2
    ],
  },
  {
    type: 'process_notation',
    signals: [
      'process', 'scattering', 'production',
    ],
    latexPatterns: [
      's\\s*\\(\\s*p\\s*\\+\\s*W\\^\\{?\\*\\}?\\s*\\(\\s*q\\s*\\)\\s*\\\\to', // s(p + W*(q) \to
      '\\\\to\\s*c',                                       // \to c
    ],
  },
  {
    type: 'parametrization_polynomial',
    signals: [
      'parametrization', 'polynomial fit', 'expansion coefficient',
    ],
    latexPatterns: [
      'P_\\{?[p\\\\pi]\\}?\\s*\\(\\s*x\\s*\\)\\s*=\\s*\\(\\s*1\\s*\\+\\s*\\\\gamma', // P_p(x) = (1 + \gamma...
      '\\\\gamma_\\{?[-\\d]\\s*,\\s*[p\\\\pi]\\}?\\s*\\\\ln\\s*x', // \gamma_{-1,p} \ln x
      '\\\\gamma_\\{?[\\d]\\s*,\\s*[p\\\\pi]\\}?\\s*x\\^\\{?[\\d]\\}?', // \gamma_{1,p} x
    ],
  },
  {
    type: 'gravitational_force',
    signals: [
      'gravitational force', 'Newton', 'gravity',
    ],
    latexPatterns: [
      'F_\\{?g\\}?\\s*=\\s*-?\\s*G\\s*\\\\frac\\{m\\s*M\\}\\{R\\^\\{?2\\}?\\}', // F_g = -G mM/R^2
      '-\\s*G\\s*\\\\frac\\{.*\\}\\{R\\^\\{?2\\}?\\}',     // -G .../R^2
    ],
  },
  {
    type: 'energy_momentum_conservation',
    signals: [
      'energy-momentum conservation', 'current conservation',
    ],
    latexPatterns: [
      'q\\^\\{?\\\\mu\\}?\\s*\\\\langle.*T_\\{?\\\\mu\\\\nu\\}?.*\\\\rangle\\s*=\\s*0', // q^\mu <..T_{\mu\nu}..> = 0
      '\\\\partial\\^\\{?\\\\mu\\}?\\s*T_\\{?\\\\mu\\\\nu\\}?\\s*=\\s*0', // \partial^\mu T_{\mu\nu} = 0
    ],
  },
  {
    type: 'hamiltonian_integral',
    signals: [
      'Hamiltonian', 'energy', 'stress tensor',
    ],
    latexPatterns: [
      'H\\s*=\\s*\\\\int.*d\\^\\{?3\\}?x.*T_\\{?00\\}?',   // H = \int d^3x T_{00}
      '\\\\int\\s*d\\^\\{?3\\}?x.*T_\\{?00\\}?\\s*\\(\\s*x\\s*\\)', // \int d^3x T_{00}(x)
    ],
  },
  {
    type: 'correlation_ratio',
    signals: [
      'ratio', 'effective mass', 'lattice observable',
    ],
    latexPatterns: [
      'R_\\{?\\\\alpha\\}?\\s*\\(\\s*\\\\vb\\{r\\}',       // R_\alpha(\vb{r}
      '\\\\frac\\{F_\\{?\\\\alpha\\}?.*\\}\\{C_\\{?M\\}?.*C_\\{?B\\}?\\}', // F_\alpha / (C_M C_B)
    ],
  },
  {
    type: 'scattering_parameter_result',
    signals: [
      'scattering length', 'effective range', 'lattice result',
    ],
    latexPatterns: [
      'a\\^\\{?I\\s*=\\s*\\d\\}?_\\{?0\\}?\\s*&?=\\s*-?\\d+\\.\\d+', // a^{I=1}_0 = -0.226
      'r\\^\\{?I\\s*=\\s*\\d\\}?_\\{?0\\}?\\s*&?=',       // r^{I=1}_0 =
      '\\\\textrm\\{fm\\}',                                // fm
    ],
  },
  {
    type: 'spinor_component',
    signals: [
      'spinor', 'component', 'spinor field',
    ],
    latexPatterns: [
      '\\\\epsilon\\s*=\\s*\\\\frac\\{?1\\}?\\{\\\\sqrt\\{2\\}\\}.*\\\\begin\\{array\\}', // \epsilon = 1/\sqrt{2} \begin{array}
      'e\\^\\{?\\\\frac\\{?i\\}?\\{?2\\}?.*\\}',          // e^{i/2(...)}
    ],
  },
  {
    type: 'susy_field',
    signals: [
      'superfield', 'supersymmetric field',
    ],
    latexPatterns: [
      '\\\\Lambda\\s*=\\s*\\\\epsilon\\s*\\\\Phi_\\{?0\\}?\\s*\\+\\s*\\\\bar\\\\epsilon', // \Lambda = \epsilon \Phi_0 + \bar\epsilon
      '\\\\Phi_\\{?[02]\\}?',                              // \Phi_0, \Phi_2
    ],
  },
  {
    type: 'gauge_connection',
    signals: [
      'gauge connection', 'connection component',
    ],
    latexPatterns: [
      '\\\\mathscr\\{?A\\}?_\\{?[12]\\}?\\s*=\\s*i\\s*Y', // \mathscrA_1 = iY
      'Y\\s*\\\\sin\\s*\\\\theta',                         // Y \sin\theta
      'Y\\s*\\\\cos\\s*\\\\theta',                         // Y \cos\theta
    ],
  },
  {
    type: 'lattice_eigenvector',
    signals: [
      'eigenvector', 'eigenvalue', 'spectral decomposition',
    ],
    latexPatterns: [
      '\\\\sigma_\\{?U\\}?\\^\\{?i\\}?\\s*=\\s*M_\\{?U\\}?\\^\\{?-1\\}?\\s*\\\\xi', // \sigma_U^i = M_U^{-1} \xi^i
      '\\\\xi\\^\\{?i\\}?',                                // \xi^i
      'S_\\{?U\\}?.*=\\s*\\\\sum_\\{?i\\}?.*\\\\xi\\^\\{?i\\}?', // S_U = \sum \xi^i
    ],
  },
  {
    type: 'lattice_transfer_matrix',
    signals: [
      'transfer matrix', 'time evolution',
    ],
    latexPatterns: [
      'G\\s*\\(\\s*t\\s*,\\s*0\\s*\\)\\s*=\\s*M\\s*\\(\\s*t\\s*,\\s*t_\\{?0\\}?\\s*\\)\\s*G', // G(t,0) = M(t,t_0) G
      'G\\s*\\(\\s*\\\\vec\\{[xy]\\}?\\s*,\\s*\\\\vec\\{[xy]\\}?\\s*\\)\\s*=.*g\\s*\\(\\s*\\\\vec', // G(\vec{y}, \vec{x}) = g(\vec{x})g(\vec{y})
    ],
  },
  {
    type: 'smearing_sum',
    signals: [
      'smearing', 'fuzzing', 'sum over links',
    ],
    latexPatterns: [
      'G\\s*=\\s*\\\\mathbbm\\{1\\}\\s*\\+\\s*\\\\sum.*\\\\alpha.*V_\\{?i\\}?', // G = 1 + \sum \alpha V_i
      'V_\\{?i\\}?\\s*\\+\\s*V_\\{?i\\}?\\^\\{?\\\\dag\\}?', // V_i + V_i^\dag
    ],
  },
  {
    type: 'chiral_extrapolation_formula',
    signals: [
      'chiral extrapolation', 'mass formula', 'quark mass dependence',
    ],
    latexPatterns: [
      'M_\\{?X\\}?\\s*=\\s*a\\s*\\+\\s*b\\s*M_\\{?\\\\pi\\}?\\^\\{?2\\}?', // M_X = a + b M_\pi^2
      '\\\\bar\\{M\\}_\\{?K\\}?\\^\\{?2\\}?',              // \bar{M}_K^2
      'M_\\{?\\\\pi\\}?\\^\\{?2\\}?\\s*-\\s*M_\\{?\\\\pi_\\{?0\\}?\\}?\\^\\{?2\\}?', // M_\pi^2 - M_{\pi_0}^2
    ],
  },
  {
    type: 'dispersion_energy',
    signals: [
      'dispersion relation', 'relativistic energy', 'two-body energy',
    ],
    latexPatterns: [
      '\\\\sqrt\\{M_\\{?[12]\\}?\\^\\{?2\\}?\\s*\\+\\s*\\\\vec\\{k\\}\\^\\{?2\\}?\\}', // \sqrt{M_1^2 + \vec{k}^2}
      'W\\s*=\\s*2\\s*\\\\sqrt\\{M_\\{?\\\\pi\\}?\\^\\{?2\\}?\\s*\\+\\s*k\\^\\{?2\\}?\\}', // W = 2\sqrt{M_\pi^2 + k^2}
    ],
  },
  {
    type: 'isospin_breaking_mass',
    signals: [
      'isospin breaking', 'QED correction', 'mass splitting',
    ],
    latexPatterns: [
      'M_\\{?\\\\pi\\}?\\^\\{?2\\}?\\s*\\+.*I_\\{?\\\\pi\\^\\{?\\+\\}?\\}?', // M_\pi^2 + ... I_{\pi^+}
      '\\\\Gamma_\\{?\\\\pi\\^\\{?\\+\\}?\\}?',            // \Gamma_{\pi^+}
      'M_\\{?\\\\pi\\^\\{?\\+\\}?\\}?\\^\\{?2\\}?',        // M_{\pi^+}^2
    ],
  },
  {
    type: 'variable_transform',
    signals: [
      'variable transformation', 'change of variable',
    ],
    latexPatterns: [
      'y\\s*=\\s*1\\s*-\\s*\\(\\s*1\\s*-\\s*\\\\sqrt\\{x\\}\\s*\\)\\^\\{?2\\}?', // y = 1 - (1-\sqrt{x})^2
      '2\\s*\\\\sqrt\\{x\\}\\s*-\\s*x',                    // 2\sqrt{x} - x
    ],
  },
  {
    type: 'kinematic_definition',
    signals: [
      'kinematic variable', 'Lorentz invariant', 'momentum transfer',
    ],
    latexPatterns: [
      '\\\\eta\\s*=\\s*\\{\\s*s\\s*\\\\over.*m\\^\\{?2\\}?\\s*\\}', // \eta = {s \over 4m^2}
      '\\\\xi\\s*=\\s*\\{\\s*Q\\^\\{?2\\}?\\s*\\\\over.*m\\^\\{?2\\}?\\s*\\}', // \xi = {Q^2 \over m^2}
    ],
  },
  {
    type: 'pdg_mass_value',
    signals: [
      'PDG', 'mass value', 'measured value',
    ],
    latexPatterns: [
      'm_\\{?t\\}?\\s*\\(\\s*m_\\{?t\\}?\\s*\\).*\\\\rm\\{PDG\\}', // m_t(m_t)|_{PDG}
      '\\\\GeV',                                           // GeV
      '\\^\\{\\s*\\+\\s*\\d+\\.?\\d*\\}?_\\{\\s*-\\s*\\d+\\.?\\d*\\}?', // ^{+4.8}_{-4.3}
    ],
  },
  {
    type: 'pdf_support',
    signals: [
      'PDF', 'parton distribution', 'support',
    ],
    latexPatterns: [
      'q_\\{?v\\}?\\s*\\(\\s*x\\s*\\)\\s*\\+\\s*\\\\bar\\{?q\\}?\\s*\\(\\s*x\\s*\\)', // q_v(x) + \bar{q}(x)
      '\\\\theta\\s*\\(\\s*x\\s*>\\s*0\\s*\\)',            // \theta(x > 0)
      '\\\\bar\\{?q\\}?\\s*\\(\\s*-\\s*x\\s*\\)',          // \bar{q}(-x)
    ],
  },
  {
    type: 'momentum_transfer_ep',
    signals: [
      'momentum transfer', 'electron scattering', 'Q^2',
    ],
    latexPatterns: [
      'q\\^\\{?2\\}?\\s*=\\s*4\\s*E\\s*E.*\\\\sin\\^\\{?2\\}?', // q^2 = 4EE' sin^2
      '\\\\sin\\^\\{?2\\}?\\s*\\(\\s*\\\\theta\\s*/\\s*2\\s*\\)', // \sin^2(\theta/2)
    ],
  },
  {
    type: 'z_expansion_variable',
    signals: [
      'z-expansion', 'conformal mapping', 'dispersion variable',
    ],
    latexPatterns: [
      'z\\s*\\(\\s*q\\^\\{?2\\}?\\s*\\)\\s*=.*\\\\sqrt\\{t_\\{?c\\}?', // z(q^2) = ... \sqrt{t_c ...
      '\\\\sqrt\\{t_\\{?c\\}?\\s*-\\s*t\\}',               // \sqrt{t_c - t}
      '\\\\sqrt\\{T_\\{?c\\}?\\s*\\+\\s*Q\\^\\{?2\\}?\\}', // \sqrt{T_c + Q^2}
    ],
  },
  {
    type: 'regularization_parameter',
    signals: [
      'regularization', 'cutoff', 'regulator',
    ],
    latexPatterns: [
      '\\\\xi\\s*=\\s*q\\^\\{?2\\}?\\s*/\\s*\\(\\s*1\\s*\\+\\s*q\\^\\{?2\\}?\\s*/\\s*\\\\xi_\\{?0\\}?', // \xi = q^2 / (1 + q^2/\xi_0)
    ],
  },
  {
    type: 'rmse_definition',
    signals: [
      'RMSE', 'root mean square error', 'statistical error',
    ],
    latexPatterns: [
      '\\\\textrm\\{RMSE\\}\\s*&?=\\s*\\\\sqrt\\{.*\\\\textrm\\{bias\\}?\\^\\{?2\\}?', // RMSE = \sqrt{bias^2 + \sigma^2}
      '\\\\sqrt\\{\\\\textrm\\{bias\\}?\\^\\{?2\\}?\\s*\\+\\s*\\\\sigma\\^\\{?2\\}?\\}', // \sqrt{bias^2 + \sigma^2}
    ],
  },
];

/** Field Theory Foundations */
export const FIELD_THEORY_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'lagrangian',
    signals: [
      'Lagrangian', 'Lagrangian density', 'interaction Lagrangian',
      'free Lagrangian', 'gauge-invariant Lagrangian', 'effective Lagrangian',
    ],
    latexPatterns: ['\\mathcal{L}', '\\mathscr{L}', 'L_'],
    caseSensitiveTerms: ['Lagrangian'],
  },
  {
    type: 'hamiltonian',
    signals: [
      'Hamiltonian', 'Hamilton operator', 'effective Hamiltonian',
      'interaction Hamiltonian', 'model Hamiltonian',
    ],
    latexPatterns: ['\\mathcal{H}', '\\hat{H}', 'H_'],
    caseSensitiveTerms: ['Hamiltonian', 'Hamilton'],
  },
  {
    type: 'action',
    signals: [
      'action', 'path integral', 'functional integral', 'Euclidean action',
      'effective action', 'classical action', 'quantum action',
    ],
    latexPatterns: ['S\\s*=', 'S\\[', 'e^{-S}', 'e^{iS}'],
  },
  {
    type: 'equation_of_motion',
    signals: [
      'equation of motion', 'EOM', 'Dirac equation', 'Klein-Gordon', 'Schrödinger',
      'Schrodinger', 'field equation', 'Euler-Lagrange', 'wave equation',
      'equations of motion',
    ],
    caseSensitiveTerms: ['EOM', 'Dirac', 'Klein-Gordon', 'Schrödinger', 'Euler-Lagrange'],
  },
  {
    type: 'propagator',
    signals: [
      'propagator', "Green's function", 'two-point function', 'free propagator',
      'dressed propagator', 'full propagator', 'Feynman propagator',
    ],
    latexPatterns: ['⟨T', 'D\\(', 'S\\(', 'G\\(', 'i\\Delta', '\\frac{i}{p'],
  },
  {
    type: 'vertex',
    signals: [
      'vertex', 'Feynman rule', 'coupling vertex', 'interaction vertex',
      'n-point vertex', 'effective vertex', 'bare vertex', 'three-point vertex',
    ],
    caseSensitiveTerms: ['Feynman'],
  },
  {
    type: 'feynman_rule',
    signals: [
      'Feynman rule', 'Feynman diagram', 'diagram contribution', 'tree-level',
      'loop diagram', 'external leg', 'Feynman rules',
    ],
    caseSensitiveTerms: ['Feynman'],
  },
  {
    type: 'green_function',
    signals: [
      'Green function', "Green's function", 'retarded Green', 'advanced Green',
      'Feynman Green', 'causal Green',
    ],
    caseSensitiveTerms: ['Green'],
  },
  {
    type: 'correlator',
    signals: [
      'correlator', 'correlation function', 'n-point function', 'VEV',
      'time-ordered product', 'T-product', 'two-point correlator',
      'three-point correlator', 'four-point correlator',
    ],
    latexPatterns: ['⟨O.*O⟩', '\\langle.*\\rangle'],
  },
  {
    type: 'spectral_function',
    signals: [
      'spectral function', 'spectral density', 'imaginary part',
      'spectral representation', 'Källén-Lehmann', 'Kallen-Lehmann',
    ],
    latexPatterns: ['ρ\\(s\\)', '\\rho\\(s\\)', 'Im\\s*'],
    caseSensitiveTerms: ['Källén', 'Lehmann'],
  },
];

/** Symmetry & Conservation */
export const SYMMETRY_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'symmetry_transformation',
    signals: [
      'transformation', 'symmetry transformation', 'gauge transformation',
      'rotation', 'translation', 'Lorentz transformation', 'infinitesimal transformation',
    ],
    caseSensitiveTerms: ['Lorentz'],
  },
  {
    type: 'ward_identity',
    signals: [
      'Ward identity', 'Ward-Takahashi', 'WT identity', 'current conservation',
      'Slavnov-Taylor identity',
    ],
    caseSensitiveTerms: ['Ward', 'Takahashi', 'Slavnov', 'Taylor'],
  },
  {
    type: 'conserved_current',
    signals: [
      'conserved current', 'Noether current', 'conserved charge', 'symmetry current',
      'vector current', 'axial current',
    ],
    latexPatterns: ['j^μ', 'j_μ', '\\partial_μ j^μ\\s*=\\s*0', 'J^μ', 'J_μ'],
    caseSensitiveTerms: ['Noether'],
  },
  {
    type: 'conservation_law',
    signals: [
      'conservation law', 'conserved quantity', 'is conserved', 'conservation of',
      'total ... is constant',
    ],
  },
  {
    type: 'anomaly',
    signals: [
      'anomaly', 'ABJ anomaly', 'chiral anomaly', 'trace anomaly', 'anomalous',
      'axial anomaly', 'conformal anomaly', 'gravitational anomaly',
    ],
    caseSensitiveTerms: ['ABJ'],
  },
  {
    type: 'breaking_term',
    signals: [
      'breaking term', 'symmetry breaking', 'explicit breaking', 'soft breaking',
      'mass term', 'breaks the symmetry',
    ],
  },
  {
    type: 'goldstone_theorem',
    signals: [
      'Goldstone boson', 'Nambu-Goldstone', 'massless mode', 'spontaneous breaking',
      'order parameter', 'Goldstone theorem',
    ],
    caseSensitiveTerms: ['Goldstone', 'Nambu'],
  },
];

/** Scattering & Decay */
export const SCATTERING_DECAY_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'amplitude',
    signals: [
      'amplitude', 'scattering amplitude', 'transition amplitude', 'matrix element',
      'helicity amplitude', 'invariant amplitude', 'partial wave amplitude',
    ],
    latexPatterns: [
      'M\\s*=',
      'T\\s*=',
      '\\\\mathcal\\{M\\}',
      '\\\\mathcal\\{T\\}',
      '\\\\cal\\s*M',
      'i\\\\mathcal\\{M\\}',
      '\\\\bar\\{?[uv]\\}?.*\\\\gamma.*[uv]',  // spinor bilinears
    ],
  },
  {
    type: 'cross_section',
    signals: [
      'cross section', 'differential cross section', 'total cross section',
      'integrated cross section', 'production cross section', 'thermal average',
    ],
    latexPatterns: [
      '\\\\sigma\\s*=',
      '\\\\sigma_\\{?[TtotLR]',          // \sigma_T, \sigma_{tot}
      'd\\\\sigma\\s*/\\s*d',            // d\sigma/d
      '\\\\langle\\s*\\\\sigma',         // <\sigma...>
      '\\\\frac\\{d\\\\sigma\\}',        // \frac{d\sigma}{...}
    ],
  },
  {
    type: 'decay_rate',
    signals: [
      'decay rate', 'width', 'partial width', 'decay width', 'lifetime',
      'decay constant', 'total width',
    ],
    latexPatterns: ['Γ\\s*=', '\\Gamma\\s*=', '1/τ'],
  },
  {
    type: 'branching_ratio',
    signals: [
      'branching ratio', 'BR', 'branching fraction', 'decay mode', 'decay channel',
    ],
    latexPatterns: ['Br\\(', 'BR\\(', '\\mathcal{B}'],
    caseSensitiveTerms: ['BR'],
  },
  {
    type: 'matrix_element',
    signals: [
      'matrix element', 'transition matrix', 'hadronic matrix element',
      'form factor decomposition', 'reduced matrix element',
    ],
    // Strict patterns: require specific bra-ket notation with operators
    latexPatterns: [
      '\\\\langle\\s*\\w+\\s*\\|\\s*\\w+\\s*\\|\\s*\\w+\\s*\\\\rangle',  // \langle f | H | i \rangle
      '\\\\bra\\{.*?\\}\\s*\\w+\\s*\\\\ket\\{.*?\\}',  // \bra{f} H \ket{i}
    ],
  },
  {
    type: 'form_factor',
    signals: [
      'form factor', 'electromagnetic form factor', 'transition form factor',
      'scalar form factor', 'vector form factor', 'tensor form factor',
    ],
    latexPatterns: [
      'F\\s*\\^\\{?[SVT]\\}?\\s*_',   // F^S_, F^V_, F^T_
      'F_\\{?\\\\pi\\}?\\s*\\(',      // F_\pi(
      'F_\\{?\\\\pi\\}?\\^\\{?S',     // F_\pi^S
      'F\\s*\\(\\s*[qtQ]',            // F(q, F(t, F(Q
      'f_\\{?[\\+0T]\\}?',            // f_+, f_0, f_T
      'G_\\{?[EMAdS]\\}?\\s*\\(',     // G_E(, G_M(, G_A(
    ],
  },
  {
    type: 'breit_wigner',
    signals: [
      'Breit-Wigner', 'BW', 'resonance shape', 'relativistic BW', 'Flatté',
      'resonance formula', 'Breit Wigner',
    ],
    latexPatterns: ['1/\\(s\\s*-\\s*M', 'M\\^2\\s*-\\s*iM\\Gamma'],
    caseSensitiveTerms: ['Breit-Wigner', 'Flatté'],
  },
  {
    type: 'k_matrix',
    signals: [
      'K-matrix', 'K matrix', 'K-matrix pole', 'P-vector', 'production vector',
    ],
  },
  {
    type: 'phase_shift',
    signals: [
      'phase shift', 'scattering phase', 'phase motion', 'Argand plot',
    ],
    latexPatterns: ['δ\\s*=', '\\delta_', 'e^{iδ}', 'e^{2iδ}'],
  },
  {
    type: 'optical_theorem',
    signals: [
      'optical theorem', 'forward amplitude', 'total cross section',
    ],
    latexPatterns: ['Im\\s*T', 'σ_tot\\s*='],
    caseSensitiveTerms: ['Im'],
  },
  {
    type: 'phase_space',
    signals: [
      'phase space', 'LIPS', 'Lorentz invariant phase space', 'n-body phase space',
      'Dalitz plot', 'kinematic boundary',
    ],
    latexPatterns: ['dΦ', 'd\\Phi', '∫\\s*d\\^3p', 'dLIPS'],
    caseSensitiveTerms: ['LIPS', 'Dalitz'],
  },
  {
    type: 'threshold',
    signals: [
      'threshold', 'threshold behavior', 'threshold expansion', 'near threshold',
      'threshold cusp', 's-wave threshold', 'threshold region',
    ],
  },
];

/** Analytic Methods */
export const ANALYTIC_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'dispersion',
    signals: [
      'dispersion relation', 'dispersive', 'spectral representation', 'Cauchy',
      'subtraction', 'dispersion integral', 'twice-subtracted', 'once-subtracted',
      'unsubtracted', 'dispersive representation',
    ],
    caseSensitiveTerms: ['Cauchy'],
  },
  {
    type: 'partial_wave',
    signals: [
      'partial wave', 'PWA', 'ℓ-th wave', 'S-wave', 'P-wave', 'angular decomposition',
      'partial-wave expansion', 'Legendre polynomial',
    ],
    latexPatterns: ['t_ℓ', 'a_ℓ', 'P_ℓ', 'f_J'],
    caseSensitiveTerms: ['PWA', 'Legendre'],
  },
  {
    type: 'unitarity',
    signals: [
      'unitarity', 'unitarity cut', 'elastic unitarity', 'unitarity bound',
      'inelasticity', 'unitarity condition', 'unitarity relation',
    ],
    // Fixed patterns: escaped properly, no accidental OR operators
    latexPatterns: [
      '\\\\text\\{Im\\}\\s*T\\s*=\\s*\\\\rho',  // \text{Im} T = \rho |T|^2
      'S\\s*S\\^\\{?\\\\dagger\\}?\\s*=\\s*1',  // S S^\dagger = 1
      'S\\^\\{?\\\\dagger\\}?\\s*S\\s*=\\s*1',  // S^\dagger S = 1
    ],
  },
  {
    type: 'crossing',
    signals: [
      'crossing symmetry', 'crossing relation', 'crossed channel', 'crossing constraint',
      's-channel', 't-channel', 'u-channel',
    ],
    latexPatterns: ['s\\s*↔\\s*t', 's\\s*↔\\s*u'],
  },
  {
    type: 'analyticity',
    signals: [
      'analyticity', 'analytic continuation', 'complex plane', 'analytic structure',
      'singularity structure', 'analytic property', 'analytic properties',
    ],
  },
  {
    type: 'riemann_sheet',
    signals: [
      'Riemann sheet', 'second sheet', 'first sheet', 'sheet structure',
      'branch cut', 'branch point',
    ],
    caseSensitiveTerms: ['Riemann'],
  },
  {
    type: 'pole_residue',
    signals: [
      'pole', 'residue', 'pole position', 'complex pole', 'g² from residue',
      'pole mass', 'pole width', 'coupling from pole',
    ],
  },
  {
    type: 'omnes',
    signals: [
      'Omnès', 'Omnès function', 'Muskhelishvili-Omnès', 'MO solution',
      'Omnès representation', 'Omnes function',
    ],
    latexPatterns: [
      '\\\\Omega\\s*\\(',           // \Omega(
      '\\\\Omega_\\{?\\d',          // \Omega_{11}, \Omega_1
      '\\\\bar\\\\Omega',           // \bar\Omega
      '\\\\det\\s*\\\\Omega',       // \det\Omega
      'Ω\\s*\\(',                   // Ω(
    ],
    caseSensitiveTerms: ['Omnès', 'Omnes', 'Muskhelishvili'],
  },
  {
    type: 'roy_equation',
    signals: [
      'Roy equation', 'Roy-Steiner', 'GKPY', 'fixed-t dispersion', 'Roy-like',
      'pipi Roy equations', 'ππ Roy',
    ],
    caseSensitiveTerms: ['Roy', 'GKPY', 'Steiner'],
  },
];

/** Sum Rules & OPE */
export const SUM_RULE_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'sum_rule',
    signals: [
      'sum rule', 'SVZ', 'Borel sum rule', 'LCSR', 'moment sum rule', 'FESR',
      'QCD sum rules', 'light-cone sum rules',
    ],
    caseSensitiveTerms: ['SVZ', 'LCSR', 'FESR'],
  },
  {
    type: 'superconvergence',
    signals: [
      'superconvergence', 'superconvergence relation', 'superconvergent',
    ],
  },
  {
    type: 'ope',
    signals: [
      'OPE', 'operator product expansion', 'short-distance expansion', 'Wilson expansion',
      'Wilson OPE', 'light-cone OPE',
    ],
    caseSensitiveTerms: ['OPE', 'Wilson'],
  },
  {
    type: 'wilson_coefficient',
    signals: [
      'Wilson coefficient', 'matching coefficient', 'short-distance coefficient',
    ],
    latexPatterns: ['C_i', 'C_1', 'C_2'],
    caseSensitiveTerms: ['Wilson'],
  },
  {
    type: 'condensate',
    signals: [
      'condensate', 'vacuum expectation', 'VEV', 'quark condensate',
      'gluon condensate', 'vacuum condensate',
    ],
    latexPatterns: ['⟨q̄q⟩', '⟨G²⟩', '\\langle\\bar{q}q\\rangle', '\\langle G^2\\rangle'],
  },
  {
    type: 'twist_expansion',
    signals: [
      'twist expansion', 'twist-2', 'twist-3', 'twist-4', 'higher twist',
      'leading twist', 'subleading twist',
    ],
  },
];

/** Renormalization */
export const RENORMALIZATION_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'rge',
    signals: [
      'RGE', 'renormalization group', 'Callan-Symanzik', 'scale dependence',
      'RG equation', 'renormalisation group',
    ],
    latexPatterns: ['μ\\s*d/dμ', 'μ\\frac{d}{dμ}'],
    caseSensitiveTerms: ['RGE', 'Callan-Symanzik'],
  },
  {
    type: 'beta_function',
    signals: [
      'beta function', 'β function', 'running of coupling', 'β-function',
    ],
    latexPatterns: ['β\\(g\\)', 'β\\(α', '\\beta\\('],
  },
  {
    type: 'anomalous_dimension',
    signals: [
      'anomalous dimension', 'scaling dimension', 'γ function',
    ],
    latexPatterns: ['γ\\s*=', 'γ_μ', '\\gamma\\s*='],
  },
  {
    type: 'evolution',
    signals: [
      'evolution equation', 'DGLAP', 'ERBL', 'BFKL', 'CSS', 'evolution kernel',
      'DGLAP evolution', 'scale evolution',
    ],
    latexPatterns: ['μ²\\s*d/dμ²'],
    caseSensitiveTerms: ['DGLAP', 'ERBL', 'BFKL', 'CSS'],
  },
  {
    type: 'running',
    signals: [
      'running', 'running coupling', 'running mass', 'scale running',
    ],
    latexPatterns: ['α_s\\(μ\\)', '\\alpha_s\\(\\mu\\)'],
  },
  {
    type: 'matching',
    signals: [
      'matching', 'matching condition', 'boundary condition at μ', 'high-low matching',
      'threshold matching',
    ],
  },
  {
    type: 'counterterm',
    signals: [
      'counterterm', 'counter-term', 'renormalization counterterm',
    ],
    latexPatterns: ['δZ', 'δm', 'Z_'],
  },
  {
    type: 'renormalization',
    signals: [
      'renormalization', 'renormalisation', 'renormalized', 'renormalised',
      'MS-bar', 'MSbar', 'on-shell scheme', 'MOM scheme',
    ],
    caseSensitiveTerms: ['MS-bar', 'MSbar', 'MOM'],
  },
];

/** Perturbative QCD */
export const PQCD_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'fixed_order',
    signals: [
      'LO', 'NLO', 'NNLO', 'N3LO', 'N4LO', 'leading order', 'next-to-leading order',
      'fixed order', 'fixed-order',
    ],
    caseSensitiveTerms: ['LO', 'NLO', 'NNLO', 'N3LO', 'N4LO'],
  },
  {
    type: 'loop_integral',
    signals: [
      'loop integral', 'Feynman integral', 'one-loop', 'two-loop', 'multi-loop',
      'scalar integral', 'tensor integral',
    ],
    caseSensitiveTerms: ['Feynman'],
  },
  {
    type: 'master_integral',
    signals: [
      'master integral', 'IBP', 'integration-by-parts', 'Laporta', 'differential equations',
      'reduction', 'IBP reduction',
    ],
    caseSensitiveTerms: ['IBP', 'Laporta'],
  },
  {
    type: 'splitting_function',
    signals: [
      'splitting function', 'Pij', 'Pqq', 'Pqg', 'Pgq', 'Pgg', 'DGLAP kernel',
      'Altarelli-Parisi', 'AP kernel',
    ],
    latexPatterns: ['P_{qq}', 'P_{qg}', 'P_{gq}', 'P_{gg}'],
    caseSensitiveTerms: ['Altarelli-Parisi'],
  },
  {
    type: 'sudakov',
    signals: [
      'Sudakov', 'Sudakov factor', 'Sudakov logarithm', 'Sudakov resummation',
      'double logarithm', 'Sudakov form factor',
    ],
    caseSensitiveTerms: ['Sudakov'],
  },
  {
    type: 'soft_function',
    signals: [
      'soft function', 'soft matrix', 'soft anomalous dimension',
    ],
    latexPatterns: ['S\\(k\\)', 'S\\('],
  },
  {
    type: 'jet_function',
    signals: [
      'jet function', 'jet mass', 'jet algorithm', 'inclusive jet function',
    ],
    latexPatterns: ['J\\(s\\)', 'J\\('],
  },
  {
    type: 'beam_function',
    signals: [
      'beam function', 'beam thrust',
    ],
    latexPatterns: ['B\\('],
  },
  {
    type: 'hard_function',
    signals: [
      'hard function', 'hard scattering kernel', 'short-distance coefficient',
      'hard matching coefficient',
    ],
    latexPatterns: ['H\\(Q\\)', 'H\\('],
  },
  {
    type: 'plus_distribution',
    signals: [
      'plus distribution', 'plus prescription', 'PV',
    ],
    latexPatterns: ['\\[.*\\]_\\+', '\\delta\\(1-x\\)', '1/\\(1-x\\)_\\+'],
  },
  {
    type: 'ir_divergence',
    signals: [
      'infrared divergence', 'IR divergence', 'soft divergence', '1/εIR',
      'infrared singularity',
    ],
    latexPatterns: ['1/ε_IR', '1/\\epsilon_{IR}'],
    caseSensitiveTerms: ['IR'],
  },
  {
    type: 'uv_divergence',
    signals: [
      'ultraviolet divergence', 'UV divergence', '1/εUV', 'ultraviolet singularity',
    ],
    latexPatterns: ['1/ε_UV', '1/\\epsilon_{UV}'],
    caseSensitiveTerms: ['UV'],
  },
  {
    type: 'collinear_singularity',
    signals: [
      'collinear singularity', 'collinear divergence', 'mass singularity',
      'collinear limit',
    ],
    latexPatterns: ['1/\\(1-x\\)'],
  },
  {
    type: 'resummation_formula',
    signals: [
      'resummation', 'LL', 'NLL', 'NNLL', 'N3LL', 'all-order', 'exponentiation',
      'resummed', 'leading logarithm', 'next-to-leading logarithm',
    ],
    caseSensitiveTerms: ['LL', 'NLL', 'NNLL', 'N3LL'],
  },
  {
    type: 'cusp_anomalous_dim',
    signals: [
      'cusp anomalous dimension', 'cusp', 'light-like Wilson line', 'Γcusp',
    ],
    latexPatterns: ['Γ_{cusp}', '\\Gamma_{cusp}'],
  },
];

/** Nucleon/Meson Structure */
export const STRUCTURE_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'pdf_definition',
    signals: [
      'parton distribution', 'PDF', 'quark distribution', 'gluon distribution',
      'twist-2 operator',
    ],
    latexPatterns: ['f\\(x', 'g\\(x', 'q\\(x'],
    caseSensitiveTerms: ['PDF'],
  },
  {
    type: 'pdf_parametrization',
    signals: [
      'PDF parametrization', 'PDF parameterization', 'functional form for PDF',
    ],
  },
  {
    type: 'gpd_definition',
    signals: [
      'generalized parton distribution', 'GPD', 'skewness', 'off-forward',
    ],
    latexPatterns: ['H\\(x,ξ', 'E\\(x,ξ', 'H\\(x,\\xi'],
    caseSensitiveTerms: ['GPD'],
  },
  {
    type: 'tmd_definition',
    signals: [
      'transverse momentum dependent', 'TMD', 'Sivers', 'Boer-Mulders', 'Collins',
    ],
    latexPatterns: ['f\\(x,k_T', 'f\\(x,k_⊥'],
    caseSensitiveTerms: ['TMD', 'Sivers', 'Boer-Mulders', 'Collins'],
  },
  {
    type: 'distribution_amplitude',
    signals: [
      'distribution amplitude', 'DA', 'LCDA', 'light-cone distribution',
    ],
    latexPatterns: ['φ\\(x', 'φ_π', '\\phi\\(x', '\\phi_\\pi'],
    caseSensitiveTerms: ['DA', 'LCDA'],
  },
  {
    type: 'compton_form_factor',
    signals: [
      'Compton form factor', 'CFF', 'DVCS amplitude',
    ],
    latexPatterns: ['\\mathcal{H}\\(ξ', '\\mathcal{H}\\(\\xi'],
    caseSensitiveTerms: ['CFF', 'Compton'],
  },
  {
    type: 'structure_function',
    signals: [
      'structure function', 'F1', 'F2', 'FL', 'g1', 'g2', 'xF3', 'R = σL/σT',
    ],
    latexPatterns: ['F_1', 'F_2', 'F_L', 'g_1', 'g_2'],
  },
  {
    type: 'moment',
    signals: [
      'moment', 'Mellin moment', 'n-th moment', 'x-moment',
    ],
    latexPatterns: ['⟨x^n⟩', '\\langle x^n \\rangle'],
    caseSensitiveTerms: ['Mellin'],
  },
  {
    type: 'evolution_kernel',
    signals: [
      'evolution kernel', 'DGLAP kernel', 'ERBL kernel', 'evolution operator',
    ],
  },
  {
    type: 'factorization_theorem',
    signals: [
      'factorization theorem', 'factorization formula', 'convolution',
      'factorized form',
    ],
    latexPatterns: ['=\\s*H\\s*⊗\\s*PDF', 'H\\otimes'],
  },
  {
    type: 'hard_scattering',
    signals: [
      'hard scattering', 'hard scattering amplitude', 'hard subprocess',
    ],
  },
  {
    type: 'coefficient_function',
    signals: [
      'coefficient function', 'Wilson coefficient', 'hard coefficient',
    ],
    caseSensitiveTerms: ['Wilson'],
  },
  {
    type: 'ji_sum_rule',
    signals: [
      'Ji sum rule', '2Jq = A + B', 'angular momentum sum rule',
    ],
    caseSensitiveTerms: ['Ji'],
  },
  {
    type: 'bjorken_sum_rule',
    signals: [
      'Bjorken sum rule', 'g1p - g1n', 'Bjorken integral',
    ],
    caseSensitiveTerms: ['Bjorken'],
  },
  {
    type: 'gls_sum_rule',
    signals: [
      'GLS sum rule', 'Gross-Llewellyn Smith',
    ],
    caseSensitiveTerms: ['GLS', 'Gross', 'Llewellyn', 'Smith'],
  },
  {
    type: 'burkhardt_cottingham',
    signals: [
      'Burkhardt-Cottingham', 'BC sum rule',
    ],
    caseSensitiveTerms: ['Burkhardt', 'Cottingham'],
  },
];

/** Effective Theory */
export const EFFECTIVE_THEORY_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'power_expansion',
    signals: [
      'expansion in', '1/m expansion', 'α_s expansion', 'power counting', 'O(p²)',
      'power expansion', 'expansion in powers',
    ],
  },
  {
    type: 'chiral_expansion',
    signals: [
      'chiral expansion', 'O(p²)', 'O(p⁴)', 'NLO ChPT', 'chiral order',
      'chiral power counting',
    ],
    caseSensitiveTerms: ['ChPT'],
  },
  {
    type: 'heavy_quark_expansion',
    signals: [
      'heavy quark expansion', '1/m_Q expansion', '1/mQ expansion', 'HQET expansion',
    ],
    caseSensitiveTerms: ['HQET'],
  },
  {
    type: 'low_energy_theorem',
    signals: [
      'low-energy theorem', 'soft-pion theorem', 'Adler zero', 'current algebra',
    ],
    caseSensitiveTerms: ['Adler'],
  },
  {
    type: 'soft_theorem',
    signals: [
      'soft theorem', 'soft limit', 'soft emission', 'soft photon theorem',
    ],
  },
];

/** Lattice QCD */
export const LATTICE_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'luescher_formula',
    signals: [
      'Lüscher', 'Luscher formula', 'Luescher formula', 'finite volume',
      'quantization condition', 'Lüscher formula',
    ],
    caseSensitiveTerms: ['Lüscher', 'Luscher', 'Luescher'],
  },
  {
    type: 'lattice_correlator',
    signals: [
      'lattice correlator', 'two-point correlator', 'effective mass', 'plateau',
    ],
    latexPatterns: ['C\\(t\\)'],
  },
  {
    type: 'extrapolation',
    signals: [
      'extrapolation', 'chiral extrapolation', 'continuum extrapolation',
      'a → 0', 'mπ → physical',
    ],
  },
  {
    type: 'finite_volume',
    signals: [
      'finite volume', 'L³×T', 'finite-size correction', 'exponential volume correction',
    ],
  },
];

/** Functional Methods */
export const FUNCTIONAL_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'dyson_schwinger',
    signals: [
      'Dyson-Schwinger', 'DSE', 'DS equation', 'gap equation', 'self-energy equation',
    ],
    caseSensitiveTerms: ['Dyson-Schwinger', 'DSE'],
  },
  {
    type: 'bethe_salpeter',
    signals: [
      'Bethe-Salpeter', 'BSE', 'BS equation', 'bound state equation', 'four-point kernel',
    ],
    caseSensitiveTerms: ['Bethe-Salpeter', 'BSE'],
  },
  {
    type: 'faddeev',
    signals: [
      'Faddeev', 'Faddeev equation', 'three-body equation', 'Alt-Grassberger-Sandhas',
    ],
    caseSensitiveTerms: ['Faddeev', 'Alt-Grassberger-Sandhas'],
  },
  {
    type: 'schwinger_function',
    signals: [
      'Schwinger function', 'Euclidean correlator', 'Euclidean Green function',
    ],
    caseSensitiveTerms: ['Schwinger', 'Euclidean'],
  },
  {
    type: 'gap_equation',
    signals: [
      'gap equation', 'mass function', 'dynamical mass',
    ],
    latexPatterns: ['M\\(p\\)', 'M\\(p²\\)'],
  },
  {
    type: 'quark_propagator',
    signals: [
      'quark propagator', 'mass function M(p²)', 'wave function renormalization A(p²)',
    ],
    latexPatterns: ['S\\(p\\)', 'A\\(p²\\)', 'B\\(p²\\)'],
  },
  {
    type: 'gluon_propagator',
    signals: [
      'gluon propagator', 'gluon dressing function', 'Gribov copy', 'decoupling solution',
    ],
    latexPatterns: ['D\\(p²\\)'],
    caseSensitiveTerms: ['Gribov'],
  },
  {
    type: 'vertex_function',
    signals: [
      'vertex function', 'full vertex', 'dressed vertex', 'Ball-Chiu', 'Curtis-Pennington',
    ],
    latexPatterns: ['Γ'],
    caseSensitiveTerms: ['Ball-Chiu', 'Curtis-Pennington'],
  },
  {
    type: 'rainbow_ladder',
    signals: [
      'rainbow-ladder', 'RL truncation', 'rainbow approximation', 'ladder kernel',
    ],
  },
];

/** Supersymmetry */
export const SUSY_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'susy_transformation',
    signals: [
      'SUSY transformation', 'supersymmetry transformation', 'δε', 'Q|state⟩',
    ],
    caseSensitiveTerms: ['SUSY'],
  },
  {
    type: 'superfield',
    signals: [
      'superfield', 'chiral superfield', 'vector superfield',
    ],
    latexPatterns: ['Φ\\(x,θ', 'Φ\\(x,\\theta'],
  },
  {
    type: 'superpotential',
    signals: [
      'superpotential', 'F-term', 'holomorphic',
    ],
    latexPatterns: ['W\\(Φ\\)', 'W\\(\\Phi\\)'],
  },
  {
    type: 'bps_condition',
    signals: [
      'BPS', 'BPS state', 'BPS bound', 'central charge', 'Z = M',
    ],
    caseSensitiveTerms: ['BPS'],
  },
  {
    type: 'central_charge',
    signals: [
      'central charge', 'central extension',
    ],
  },
  {
    type: 'soft_breaking',
    signals: [
      'soft breaking', 'soft SUSY breaking', 'soft terms', 'soft masses',
    ],
    caseSensitiveTerms: ['SUSY'],
  },
  {
    type: 'kahler_potential',
    signals: [
      'Kähler potential', 'Kahler potential', 'Kähler metric',
    ],
    caseSensitiveTerms: ['Kähler', 'Kahler'],
  },
  {
    type: 'd_term',
    signals: [
      'D-term', 'D term', 'auxiliary D field',
    ],
  },
  {
    type: 'f_term',
    signals: [
      'F-term', 'F term', 'auxiliary F field',
    ],
  },
  {
    type: 'gaugino_mass',
    signals: [
      'gaugino mass', 'gaugino masses', 'M1', 'M2', 'M3',
    ],
  },
];

/** Conformal Field Theory */
export const CFT_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'conformal_block',
    signals: [
      'conformal block', 'conformal partial wave',
    ],
    latexPatterns: ['G\\(u,v\\)'],
  },
  {
    type: 'ope_coefficient',
    signals: [
      'OPE coefficient', 'structure constant', 'three-point function coefficient',
    ],
    caseSensitiveTerms: ['OPE'],
  },
  {
    type: 'conformal_dimension',
    signals: [
      'conformal dimension', 'scaling dimension', 'anomalous dimension',
    ],
    latexPatterns: ['Δ', '\\Delta'],
  },
  {
    type: 'bootstrap_equation',
    signals: [
      'bootstrap', 'bootstrap equation', 'conformal bootstrap', 'crossing equation',
    ],
  },
  {
    type: 'crossing_equation',
    signals: [
      'crossing equation', 'crossing symmetry constraint',
    ],
  },
  {
    type: 'virasoro',
    signals: [
      'Virasoro', 'Virasoro algebra', 'central charge c', 'Ln',
    ],
    caseSensitiveTerms: ['Virasoro'],
  },
  {
    type: 'conformal_ward',
    signals: [
      'conformal Ward identity', 'Ward identity', 'conformal constraint',
    ],
    caseSensitiveTerms: ['Ward'],
  },
  {
    type: 'primary_operator',
    signals: [
      'primary operator', 'primary field', 'quasi-primary',
    ],
  },
  {
    type: 'descendant',
    signals: [
      'descendant', 'descendant operator', 'derivative operator',
    ],
  },
  {
    type: 'modular_invariance',
    signals: [
      'modular invariance', 'modular transformation', 'modular covariance',
    ],
  },
];

/** String Theory & Gravity */
export const STRING_GRAVITY_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'worldsheet',
    signals: [
      'worldsheet', 'world-sheet', 'Polyakov action', 'Nambu-Goto',
    ],
    caseSensitiveTerms: ['Polyakov', 'Nambu-Goto'],
  },
  {
    type: 'vertex_operator',
    signals: [
      'vertex operator', 'string vertex', 'BRST vertex',
    ],
    caseSensitiveTerms: ['BRST'],
  },
  {
    type: 'string_amplitude',
    signals: [
      'string amplitude', 'Veneziano', 'Virasoro-Shapiro', 'closed string', 'open string',
    ],
    caseSensitiveTerms: ['Veneziano', 'Virasoro-Shapiro'],
  },
  {
    type: 'bcj_relation',
    signals: [
      'BCJ', 'BCJ relation', 'color-kinematics duality', 'double copy',
    ],
    caseSensitiveTerms: ['BCJ'],
  },
  {
    type: 'klt_relation',
    signals: [
      'KLT', 'KLT relation', 'gravity = gauge²',
    ],
    caseSensitiveTerms: ['KLT'],
  },
  {
    type: 'ads_cft',
    signals: [
      'AdS/CFT', 'AdS₅/CFT₄', 'holographic', 'Maldacena', 'gauge/gravity duality',
      'anti-de Sitter',
    ],
    caseSensitiveTerms: ['AdS', 'CFT', 'Maldacena'],
  },
  {
    type: 'holographic',
    signals: [
      'holographic', 'holography', 'bulk-boundary', 'boundary operator',
    ],
  },
  {
    type: 't_hooft_expansion',
    signals: [
      "'t Hooft", 'large N', '1/N expansion', 'planar', 'λ = g²N',
    ],
    caseSensitiveTerms: ["'t Hooft"],
  },
  {
    type: 'planar_limit',
    signals: [
      'planar limit', 'planar diagram', 'non-planar',
    ],
  },
  {
    type: 'graviton_amplitude',
    signals: [
      'graviton amplitude', 'gravity amplitude', 'gravitational scattering',
    ],
  },
];

/** Topology & Anomalies */
export const TOPOLOGY_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'chern_simons',
    signals: [
      'Chern-Simons', 'CS term', 'topological field theory',
    ],
    latexPatterns: ['A\\s*∧\\s*dA', 'A\\wedge dA'],
    caseSensitiveTerms: ['Chern-Simons'],
  },
  {
    type: 'wess_zumino',
    signals: [
      'Wess-Zumino', 'WZW', 'Wess-Zumino-Witten', 'anomalous term',
    ],
    caseSensitiveTerms: ['Wess-Zumino', 'WZW', 'Witten'],
  },
  {
    type: 'topological_charge',
    signals: [
      'topological charge', 'winding number', 'Pontryagin',
    ],
    latexPatterns: ['Q\\s*=\\s*∫\\s*F\\s*F̃', 'Q = \\int'],
    caseSensitiveTerms: ['Pontryagin'],
  },
  {
    type: 'instanton_action',
    signals: [
      'instanton', 'instanton action', '8π²/g²', 'BPST',
    ],
    caseSensitiveTerms: ['BPST'],
  },
  {
    type: 'theta_term',
    signals: [
      'theta term', 'θ term', 'θ F F̃', 'CP violating', 'strong CP',
    ],
  },
  {
    type: 'anomaly_matching',
    signals: [
      'anomaly matching', "'t Hooft anomaly", 'anomaly inflow', 'consistent anomaly',
    ],
    caseSensitiveTerms: ["'t Hooft"],
  },
  {
    type: 'index_theorem',
    signals: [
      'index theorem', 'Atiyah-Singer', 'ind D', 'zero modes',
    ],
    caseSensitiveTerms: ['Atiyah-Singer'],
  },
  {
    type: 'atiyah_singer',
    signals: [
      'Atiyah-Singer', 'AS index',
    ],
    caseSensitiveTerms: ['Atiyah-Singer'],
  },
  {
    type: 'pontryagin',
    signals: [
      'Pontryagin number', 'Pontryagin index', 'topological invariant', 'Chern number',
    ],
    caseSensitiveTerms: ['Pontryagin', 'Chern'],
  },
];

/** Thermodynamics & Statistics */
export const THERMODYNAMICS_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'equation_of_state',
    signals: [
      'equation of state', 'EoS', 'P(T)', 'ε(T)', 'pressure vs temperature',
    ],
    caseSensitiveTerms: ['EoS'],
  },
  {
    type: 'partition_function',
    signals: [
      'partition function', 'path integral Z',
    ],
    latexPatterns: ['Z\\s*=', '∑\\s*e^{-βE}', 'Z = \\sum', 'Z = \\int'],
  },
  {
    type: 'free_energy',
    signals: [
      'free energy', 'Helmholtz', 'Gibbs free energy', 'grand potential',
    ],
    latexPatterns: ['F\\s*='],
    caseSensitiveTerms: ['Helmholtz', 'Gibbs'],
  },
  {
    type: 'pressure',
    signals: [
      'pressure', 'equation of state pressure', 'Stefan-Boltzmann',
    ],
    latexPatterns: ['P\\(T\\)', 'p\\(T\\)'],
    caseSensitiveTerms: ['Stefan-Boltzmann'],
  },
  {
    type: 'susceptibility',
    signals: [
      'susceptibility', 'response function', 'fluctuation', 'second derivative',
    ],
    latexPatterns: ['χ'],
  },
];

/** Experimental Fitting */
export const FITTING_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'fit_function',
    signals: [
      'fit function', 'fitted to', 'parametrized as', 'fit result',
      'fitting function',
    ],
  },
  {
    type: 'line_shape',
    signals: [
      'line shape', 'invariant mass distribution', 'dN/dm', 'spectrum shape',
      'lineshape',
    ],
  },
  {
    type: 'background',
    signals: [
      'background', 'background shape', 'combinatorial background',
      'smooth background', 'polynomial background',
    ],
  },
  {
    type: 'resolution',
    signals: [
      'resolution', 'resolution function', 'Gaussian resolution',
      'detector resolution', 'σ_res',
    ],
  },
  {
    type: 'efficiency',
    signals: [
      'efficiency', 'acceptance', 'reconstruction efficiency',
      'trigger efficiency', 'selection efficiency',
    ],
    latexPatterns: ['ε'],
  },
  {
    type: 'parametrization',
    signals: [
      'parametrization', 'parametrized as', 'fit model', 'functional form',
      'empirical formula', 'parameterization',
    ],
  },
];

/** Mathematical Structure */
export const MATH_STRUCTURE_SIGNALS: EquationTypeSignalConfig[] = [
  {
    type: 'recurrence',
    signals: [
      'recurrence', 'recursion', 'recurrence relation', 'recursive formula',
      'iteration',
    ],
  },
  {
    type: 'integral_representation',
    signals: [
      'integral representation', 'integral form', 'contour integral',
      'Mellin-Barnes',
    ],
    caseSensitiveTerms: ['Mellin-Barnes'],
  },
  {
    type: 'series_expansion',
    signals: [
      'series expansion', 'Taylor series', 'power series', 'Laurent series',
      'asymptotic series',
    ],
    caseSensitiveTerms: ['Taylor', 'Laurent'],
  },
  {
    type: 'asymptotic',
    signals: [
      'asymptotic', 'asymptotic behavior', 'asymptotic expansion',
      'large-x', 'small-x', 'x → ∞', 'x → 0',
    ],
  },
  {
    type: 'factorization',
    signals: [
      'factorization', 'factorized form', 'product form', 'separable',
      '= f(x) × g(y)',
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Aggregated Signal Configurations
// ═══════════════════════════════════════════════════════════════════════════════

export const ALL_EQUATION_TYPE_SIGNALS: EquationTypeSignalConfig[] = [
  ...BASIC_TYPE_SIGNALS,
  ...FIELD_THEORY_SIGNALS,
  ...SYMMETRY_SIGNALS,
  ...SCATTERING_DECAY_SIGNALS,
  ...ANALYTIC_SIGNALS,
  ...SUM_RULE_SIGNALS,
  ...RENORMALIZATION_SIGNALS,
  ...PQCD_SIGNALS,
  ...STRUCTURE_SIGNALS,
  ...EFFECTIVE_THEORY_SIGNALS,
  ...LATTICE_SIGNALS,
  ...FUNCTIONAL_SIGNALS,
  ...SUSY_SIGNALS,
  ...CFT_SIGNALS,
  ...STRING_GRAVITY_SIGNALS,
  ...TOPOLOGY_SIGNALS,
  ...THERMODYNAMICS_SIGNALS,
  ...FITTING_SIGNALS,
  ...MATH_STRUCTURE_SIGNALS,
];

// ═══════════════════════════════════════════════════════════════════════════════
// Famous Equation Names
// ═══════════════════════════════════════════════════════════════════════════════

export const FAMOUS_EQUATIONS: Record<string, string[]> = {
  // Relations
  'GMOR relation': ['GMOR', 'Gell-Mann-Oakes-Renner', 'Gell-Mann Oakes Renner'],
  'GOR relation': ['GOR', 'Goldberger-Treiman'],
  'Goldberger-Treiman relation': ['Goldberger-Treiman', 'GT relation'],
  // Sum Rules
  'Bjorken sum rule': ['Bjorken sum rule', 'Bjorken integral'],
  'Ellis-Jaffe sum rule': ['Ellis-Jaffe'],
  'Gottfried sum rule': ['Gottfried'],
  'Ji sum rule': ['Ji sum rule', 'angular momentum sum rule'],
  'GLS sum rule': ['GLS', 'Gross-Llewellyn Smith'],
  'Burkhardt-Cottingham': ['Burkhardt-Cottingham', 'BC sum rule'],
  'Adler-Weisberger': ['Adler-Weisberger'],
  // Equations
  'Roy equation': ['Roy equation', 'Roy equations'],
  'Roy-Steiner equation': ['Roy-Steiner'],
  'Omnès equation': ['Omnès', 'Omnes'],
  'Bethe-Salpeter equation': ['Bethe-Salpeter', 'BSE'],
  'Dyson-Schwinger equation': ['Dyson-Schwinger', 'DSE'],
  'Faddeev equation': ['Faddeev'],
  'Lippmann-Schwinger equation': ['Lippmann-Schwinger'],
  'Lüscher formula': ['Lüscher', 'Luscher', 'Luescher'],
  'DGLAP equation': ['DGLAP', 'Altarelli-Parisi'],
  'BFKL equation': ['BFKL', 'Balitsky-Fadin-Kuraev-Lipatov'],
  'BK equation': ['BK equation', 'Balitsky-Kovchegov'],
  // Formulas
  'Breit-Wigner formula': ['Breit-Wigner', 'BW'],
  'Flatté formula': ['Flatté', 'Flatte'],
  'Weinberg formula': ['Weinberg formula', 'Weinberg composition'],
  // Theorems
  'optical theorem': ['optical theorem'],
  'Goldstone theorem': ['Goldstone theorem', 'Nambu-Goldstone'],
  'Adler zero': ['Adler zero'],
  'soft pion theorem': ['soft pion theorem', 'soft-pion theorem'],
};

// ═══════════════════════════════════════════════════════════════════════════════
// Physical Quantities
// ═══════════════════════════════════════════════════════════════════════════════

export const PHYSICAL_QUANTITIES: Record<string, string[]> = {
  // Kinematic
  kinematic: [
    'energy', 'momentum', 'mass', 'velocity', 'rapidity', 'pseudorapidity',
    'transverse momentum', 'pT', 'invariant mass', 's', 't', 'u', 'Q²',
    'x_B', 'Bjorken x', 'center-of-mass energy', '√s', 'four-momentum', 'q²',
    'W', 'missing mass',
  ],
  // Scattering/Decay
  scattering: [
    'cross section', 'σ', 'amplitude', 'phase shift', 'δ', 'scattering length',
    'a', 'effective range', 'r', 'partial wave', 'S-matrix', 'T-matrix', 'K-matrix',
    'scattering volume', 'inelasticity', 'η', 'total cross section',
    'differential cross section',
  ],
  decay: [
    'decay rate', 'Γ', 'width', 'branching ratio', 'BR', 'lifetime', 'τ',
    'half-life', 'partial width', 'total width', 'decay constant', 'fπ', 'fK', 'fB', 'fD',
  ],
  // Form Factors
  form_factors: [
    'form factor', 'F', 'GE', 'GM', 'GA', 'GP', 'Dirac', 'Pauli', 'Sachs',
    'gravitational form factor', 'D-term', 'A-form factor', 'J-form factor',
    'scalar form factor', 'tensor form factor', 'transition form factor',
  ],
  // Radii
  radii: [
    'charge radius', 'rE', 'rM', 'magnetic radius', 'Zemach radius',
    'mass radius', 'mechanical radius', 'rms radius', 'proton radius',
  ],
  // Parton
  parton: [
    'PDF', 'f(x)', 'g(x)', 'GPD', 'H', 'E', 'TMD', 'fragmentation function',
    'D(z)', 'distribution amplitude', 'φ', 'Compton form factor', 'CFF',
    'structure function', 'F1', 'F2', 'FL', 'g1', 'g2', 'xF3',
    'Sivers function', 'Collins function',
  ],
  // Couplings
  couplings: [
    'αs', 'α', 'g', 'coupling constant', 'Fermi constant', 'GF', 'CKM', 'Vij',
    'Yukawa coupling', 'gauge coupling', 'running coupling', 'fine structure constant',
    'weak mixing angle', 'sin²θW', 'gA', 'gV', 'gπNN',
  ],
  // Condensates
  condensates: [
    'quark condensate', '⟨q̄q⟩', 'gluon condensate', '⟨G²⟩', 'chiral condensate',
    'mixed condensate', 'four-quark condensate', 'vacuum expectation value', 'VEV',
    'order parameter',
  ],
  // Masses & Scales
  masses_scales: [
    'quark mass', 'meson mass', 'baryon mass', 'pole mass', 'running mass',
    'constituent mass', 'current mass', 'ΛQCD', 'μ', 'renormalization scale',
    'factorization scale', 'threshold', 'binding energy',
  ],
  // Mixing
  mixing: [
    'mixing angle', 'θ', "η-η' mixing", 'CKM angle', 'Wolfenstein parameter',
    'CP phase', 'δCP', 'oscillation parameter', 'mass difference', 'Δm',
  ],
  // Precision
  precision: [
    'anomalous magnetic moment', 'g-2', 'aμ', 'ae', 'electric dipole moment',
    'EDM', 'ρ parameter', 'S parameter', 'T parameter', 'oblique correction',
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build pattern cache
const signalPatternCache = new Map<string, RegExp>();

/**
 * Get or create pattern for equation type signals
 */
function getSignalPattern(config: EquationTypeSignalConfig): RegExp {
  const cacheKey = config.type;
  let pattern = signalPatternCache.get(cacheKey);
  
  if (!pattern) {
    const escaped = config.signals.map(escapeRegex);
    escaped.sort((a, b) => b.length - a.length);
    pattern = new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i');
    signalPatternCache.set(cacheKey, pattern);
  }
  
  return pattern;
}

/**
 * Classify equation type based on context and LaTeX content
 * 
 * @param context - Text context around the equation
 * @param latex - The equation LaTeX content
 * @returns Array of matching equation types
 */
export function classifyEquationType(context: string, latex: string): EquationType[] {
  const types = new Set<EquationType>();
  
  for (const config of ALL_EQUATION_TYPE_SIGNALS) {
    // Check context signals
    const pattern = getSignalPattern(config);
    if (pattern.test(context)) {
      types.add(config.type as EquationType);
      continue;
    }
    
    // Check LaTeX patterns if available
    if (config.latexPatterns) {
      for (const latexPattern of config.latexPatterns) {
        try {
          const re = new RegExp(latexPattern, 'i');
          if (re.test(latex)) {
            types.add(config.type as EquationType);
            break;
          }
        } catch {
          // Skip invalid patterns
        }
      }
    }
  }
  
  // Fallback patterns for common mathematical structures
  if (types.size === 0) {
    // Light-cone / n-vectors
    if (/\\bar\{?n\}?\\cdot|n\^?\{?\\mu\}?\s*\\to|\\cdot\s*n_[123]/.test(latex)) {
      types.add('lightcone_vector' as EquationType);
    }
    // Boost/rescaling transformations
    else if (/\\to\\lambda|\\lambda\^?\{?-?1?\}?/.test(latex) && /\\mu/.test(latex)) {
      types.add('symmetry_transformation' as EquationType);
    }
    // Transverse coordinate transformation
    else if (/b_\{?\\perp\}?\^?\{?\\mu\}?\s*\\to/.test(latex)) {
      types.add('symmetry_transformation' as EquationType);
    }
    // AUC/ML metrics
    else if (/\\text\{AUC\}|\\mathcal\{AUC\}|\\calL\}?_\{?\\?(min|max)/.test(latex)) {
      types.add('observable' as EquationType);
    }
    // Probability/distribution proportional to exponential
    else if (/\\propto\s*e\^?\{?-|p\\vec/.test(latex)) {
      types.add('distribution' as EquationType);
    }
    // Theta/Heaviside step function
    else if (/\\Theta\\left?\(|\\Theta\(/.test(latex)) {
      types.add('constraint' as EquationType);
    }
    // Jet functions / soft functions
    else if (/\\mathcal\{[JS]\}|\\cal[JS]\}?_?\{?[i1]/.test(latex)) {
      types.add('soft_factor' as EquationType);
    }
    // Hierarchy conditions
    else if (/\\gg|\\ll/.test(latex)) {
      types.add('constraint' as EquationType);
    }
    // Geq/Leq inequalities
    else if (/\\geq|\\leq|\\ge|\\le/.test(latex)) {
      types.add('constraint' as EquationType);
    }
    // Proportionality relations
    else if (/\\propto/.test(latex)) {
      types.add('relation' as EquationType);
    }
    // Field transformations with arrow
    else if (/\\psi.*\\to.*\\psi|\\phi.*\\to.*\\phi/.test(latex)) {
      types.add('symmetry_transformation' as EquationType);
    }
    // Numerical inequalities/orderings
    else if (/[<>](?!=)/.test(latex) && !latex.includes('\\rightarrow') && !latex.includes('\\to')) {
      types.add('constraint' as EquationType);
    }
    // Variable assignments/substitutions
    else if (/[a-z]_?[{\d}]*\s*=\s*[^=]/.test(latex) && latex.length < 50) {
      types.add('definition' as EquationType);
    }
    // Kinematic expressions with sqrt
    else if (/\\sqrt\s*\{[^}]*[m|M|E|p|k]/.test(latex)) {
      types.add('kinematics' as EquationType);
    }
    // Functions with explicit arguments
    else if (/[a-zA-Z]+\s*\\?\(?\s*[xyztuvrspkq]/.test(latex) && /=/.test(latex)) {
      types.add('definition' as EquationType);
    }
    // Momentum transfer / scattering variables
    else if (/q\^?2|Q\^?2|s\\over|\\frac\{s\}|\\frac\{Q/.test(latex)) {
      types.add('kinematics' as EquationType);
    }
    // Reaction arrows
    else if (/\\rightarrow|\\to|\\Rightarrow/.test(latex) && /\+.*\+|\\nu|\\rm/.test(latex)) {
      types.add('reaction' as EquationType);
    }
    // Potential with r dependence
    else if (/V\^?\{?[ij]?\}?\s*\(?\s*r\)?|V_\{?\\?[a-z]+\}?\s*\(r\)/.test(latex)) {
      types.add('potential' as EquationType);
    }
    // Tensor operators with multiple indices
    else if (/[A-Z]_\{[a-z0-9]+\}|\\mathbf\{[A-Z]\}/.test(latex)) {
      types.add('definition' as EquationType);
    }
    // Matrix/lattice expressions
    else if (/M_\{?[A-Z]?\}?\^?\{?-?1?\}?_?\{[xy,]+\}|G\s*\\vec|Gt,0/.test(latex)) {
      types.add('propagator' as EquationType);
    }
    // Simple arithmetic/limit expressions
    else if (/\\hspace|\\quad|\\qquad/.test(latex) && /=/.test(latex)) {
      types.add('relation' as EquationType);
    }
    // Expectation values
    else if (/\\langle[^\\]*\\rangle/.test(latex) && /=/.test(latex)) {
      types.add('matrix_element' as EquationType);
    }
    // Mass squared expressions
    else if (/\\M\^?\{?2?\}?|M_\{?[12]\}?\^?\{?2?\}?/.test(latex)) {
      types.add('kinematics' as EquationType);
    }
    // Gravity/gravitational expressions
    else if (/G\\s*\\frac|\\frac\{.*m.*M|M\}\{R/.test(latex)) {
      types.add('potential' as EquationType);
    }
    // Flow coefficients
    else if (/v_n\^?\{?\\/.test(latex)) {
      types.add('observable' as EquationType);
    }
    // Generic fraction expression
    else if (/\\frac\{[^}]+\}\{[^}]+\}/.test(latex) && !/already matched/.test('')) {
      types.add('relation' as EquationType);
    }
    // Simple equalities
    else if (/=/.test(latex)) {
      types.add('relation' as EquationType);
    }
  }
  
  return Array.from(types).sort();
}

/**
 * Identify famous equation names in context
 * 
 * @param context - Text context around the equation
 * @returns Famous equation name if found, undefined otherwise
 */
export function identifyFamousEquation(context: string): string | undefined {
  for (const [name, patterns] of Object.entries(FAMOUS_EQUATIONS)) {
    for (const pattern of patterns) {
      const re = new RegExp(`\\b${escapeRegex(pattern)}\\b`, 'i');
      if (re.test(context)) {
        return name;
      }
    }
  }
  return undefined;
}

/**
 * Extract physical quantities mentioned in equation context
 * 
 * @param text - Text to analyze
 * @returns Array of identified physical quantities
 */
export function extractPhysicalQuantities(text: string): string[] {
  const quantities = new Set<string>();
  
  for (const [_category, terms] of Object.entries(PHYSICAL_QUANTITIES)) {
    for (const term of terms) {
      const escaped = escapeRegex(term);
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      if (re.test(text)) {
        quantities.add(term);
      }
    }
  }
  
  return Array.from(quantities).sort();
}

/**
 * Determine if an equation is a key equation based on context signals
 * 
 * @param context - Text context around the equation
 * @returns Object with is_key flag and reason if true
 */
export function isKeyEquation(context: string): { is_key: boolean; reason?: string } {
  const keySignals: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\b(main|key|central|principal|important)\s*(result|equation|formula)\b/i, reason: 'main result' },
    { pattern: /\b(our|the)\s*(final|key)\s*result\b/i, reason: 'final result' },
    { pattern: /\bstarting point\b/i, reason: 'starting point' },
    { pattern: /\bwidely\s*used\b/i, reason: 'widely used' },
    { pattern: /\bfundamental\s*(equation|relation|formula)\b/i, reason: 'fundamental' },
    { pattern: /\bmaster\s*(equation|formula)\b/i, reason: 'master equation' },
    { pattern: /\bdefining\s*(equation|relation)\b/i, reason: 'defining equation' },
  ];
  
  for (const { pattern, reason } of keySignals) {
    if (pattern.test(context)) {
      return { is_key: true, reason };
    }
  }
  
  return { is_key: false };
}
