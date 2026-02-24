/**
 * HEP-related arXiv categories for NPMI distance matrix
 */

// Core HEP categories
export const HEP_CORE = [
  'hep-th',   // High Energy Physics - Theory
  'hep-ph',   // High Energy Physics - Phenomenology
  'hep-ex',   // High Energy Physics - Experiment
  'hep-lat',  // High Energy Physics - Lattice
] as const;

// Nuclear physics
export const NUCLEAR = [
  'nucl-th',  // Nuclear Theory
  'nucl-ex',  // Nuclear Experiment
] as const;

// Gravity and cosmology
export const GRAVITY_COSMO = [
  'gr-qc',        // General Relativity and Quantum Cosmology
  'astro-ph.CO',  // Cosmology and Nongalactic Astrophysics
  'astro-ph.HE',  // High Energy Astrophysical Phenomena
  'astro-ph.GA',  // Astrophysics of Galaxies
  'astro-ph.SR',  // Solar and Stellar Astrophysics
  'astro-ph.IM',  // Instrumentation and Methods
] as const;

// Mathematical physics
export const MATH_PHYSICS = [
  'math-ph',  // Mathematical Physics
  'math.MP',  // Mathematical Physics (math archive)
  'math.QA',  // Quantum Algebra
  'math.DG',  // Differential Geometry
  'math.AG',  // Algebraic Geometry
] as const;

// Quantum information
export const QUANTUM = [
  'quant-ph',  // Quantum Physics
] as const;

// Condensed matter (crossover targets)
export const COND_MAT = [
  'cond-mat.str-el',    // Strongly Correlated Electrons
  'cond-mat.supr-con',  // Superconductivity
  'cond-mat.stat-mech', // Statistical Mechanics
  'cond-mat.mes-hall',  // Mesoscale and Nanoscale Physics
  'cond-mat.mtrl-sci',  // Materials Science
] as const;

// Computer science / ML (crossover targets)
export const CS_ML = [
  'cs.LG',    // Machine Learning
  'cs.AI',    // Artificial Intelligence
  'cs.CV',    // Computer Vision
  'stat.ML',  // Machine Learning (statistics)
] as const;

// Other physics
export const OTHER_PHYSICS = [
  'physics.ins-det',    // Instrumentation and Detectors
  'physics.data-an',    // Data Analysis
  'physics.comp-ph',    // Computational Physics
  'physics.acc-ph',     // Accelerator Physics
] as const;

/**
 * All HEP-related categories for NPMI matrix
 * Total: ~40 categories
 */
export const HEP_CATEGORIES = [
  ...HEP_CORE,
  ...NUCLEAR,
  ...GRAVITY_COSMO,
  ...MATH_PHYSICS,
  ...QUANTUM,
  ...COND_MAT,
  ...CS_ML,
  ...OTHER_PHYSICS,
] as const;

export type HEPCategory = (typeof HEP_CATEGORIES)[number];

/**
 * Category groups for reference
 */
export const CATEGORY_GROUPS = {
  hep_core: HEP_CORE,
  nuclear: NUCLEAR,
  gravity_cosmo: GRAVITY_COSMO,
  math_physics: MATH_PHYSICS,
  quantum: QUANTUM,
  cond_mat: COND_MAT,
  cs_ml: CS_ML,
  other_physics: OTHER_PHYSICS,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Pre-computed NPMI Distances (based on INSPIRE co-occurrence data)
// These values are stable over time and can be updated periodically
// Distance range: 0 (always co-occur) to 1 (never co-occur)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default distances between category groups
 * Used when specific pair distance is not available
 */
export const GROUP_DISTANCES: Record<string, Record<string, number>> = {
  hep_core: {
    hep_core: 0.15,      // Within HEP core
    nuclear: 0.25,       // HEP-Nuclear overlap
    gravity_cosmo: 0.30, // Theory-Cosmology connection
    math_physics: 0.35,  // Math-Physics connection
    quantum: 0.45,       // Quantum info emerging
    cond_mat: 0.55,      // AdS/CMT crossover
    cs_ml: 0.65,         // ML applications
    other_physics: 0.30, // Instrumentation etc.
  },
  nuclear: {
    nuclear: 0.15,
    gravity_cosmo: 0.50,
    math_physics: 0.45,
    quantum: 0.55,
    cond_mat: 0.50,
    cs_ml: 0.65,
    other_physics: 0.35,
  },
  gravity_cosmo: {
    gravity_cosmo: 0.20,
    math_physics: 0.30,
    quantum: 0.40,
    cond_mat: 0.60,
    cs_ml: 0.70,
    other_physics: 0.45,
  },
  math_physics: {
    math_physics: 0.20,
    quantum: 0.35,
    cond_mat: 0.45,
    cs_ml: 0.60,
    other_physics: 0.50,
  },
  quantum: {
    quantum: 0.15,
    cond_mat: 0.40,
    cs_ml: 0.50,
    other_physics: 0.55,
  },
  cond_mat: {
    cond_mat: 0.20,
    cs_ml: 0.55,
    other_physics: 0.50,
  },
  cs_ml: {
    cs_ml: 0.20,
    other_physics: 0.60,
  },
  other_physics: {
    other_physics: 0.25,
  },
};

/**
 * Specific pair distances (computed from INSPIRE data 2025-12)
 * Format: "catA|catB" -> distance (catA < catB alphabetically)
 */
export const SPECIFIC_DISTANCES: Record<string, number> = {
  // Computed from INSPIRE data 2025-12-25 (N=902,434 papers with arXiv categories)
  // 31 categories, 465 pairs
  'astro-ph.CO|astro-ph.GA': 0.31,
  'astro-ph.CO|astro-ph.HE': 0.5,
  'astro-ph.CO|astro-ph.IM': 0.41,
  'astro-ph.CO|astro-ph.SR': 0.55,
  'astro-ph.CO|cond-mat.mes-hall': 0.71,
  'astro-ph.CO|cond-mat.mtrl-sci': 0.62,
  'astro-ph.CO|cond-mat.stat-mech': 0.65,
  'astro-ph.CO|cond-mat.str-el': 0.71,
  'astro-ph.CO|cond-mat.supr-con': 0.65,
  'astro-ph.CO|cs.AI': 0.54,
  'astro-ph.CO|cs.CV': 0.5,
  'astro-ph.CO|cs.LG': 0.52,
  'astro-ph.CO|gr-qc': 0.42,
  'astro-ph.CO|hep-ex': 0.58,
  'astro-ph.CO|hep-lat': 0.66,
  'astro-ph.CO|hep-ph': 0.5,
  'astro-ph.CO|hep-th': 0.52,
  'astro-ph.CO|math-ph': 0.66,
  'astro-ph.CO|math.AG': 0.71,
  'astro-ph.CO|math.DG': 0.66,
  'astro-ph.CO|math.MP': 0.65,
  'astro-ph.CO|math.QA': 1,
  'astro-ph.CO|nucl-ex': 0.65,
  'astro-ph.CO|nucl-th': 0.67,
  'astro-ph.CO|physics.acc-ph': 0.69,
  'astro-ph.CO|physics.comp-ph': 0.54,
  'astro-ph.CO|physics.data-an': 0.53,
  'astro-ph.CO|physics.ins-det': 0.6,
  'astro-ph.CO|quant-ph': 0.73,
  'astro-ph.CO|stat.ML': 0.51,
  'astro-ph.GA|astro-ph.HE': 0.35,
  'astro-ph.GA|astro-ph.IM': 0.43,
  'astro-ph.GA|astro-ph.SR': 0.41,
  'astro-ph.GA|cond-mat.mes-hall': 0.71,
  'astro-ph.GA|cond-mat.mtrl-sci': 0.66,
  'astro-ph.GA|cond-mat.stat-mech': 0.64,
  'astro-ph.GA|cond-mat.str-el': 1,
  'astro-ph.GA|cond-mat.supr-con': 0.67,
  'astro-ph.GA|cs.AI': 0.53,
  'astro-ph.GA|cs.CV': 0.47,
  'astro-ph.GA|cs.LG': 0.54,
  'astro-ph.GA|gr-qc': 0.55,
  'astro-ph.GA|hep-ex': 0.65,
  'astro-ph.GA|hep-lat': 0.71,
  'astro-ph.GA|hep-ph': 0.61,
  'astro-ph.GA|hep-th': 0.66,
  'astro-ph.GA|math-ph': 0.67,
  'astro-ph.GA|math.AG': 1,
  'astro-ph.GA|math.DG': 0.69,
  'astro-ph.GA|math.MP': 0.66,
  'astro-ph.GA|math.QA': 1,
  'astro-ph.GA|nucl-ex': 0.66,
  'astro-ph.GA|nucl-th': 0.69,
  'astro-ph.GA|physics.acc-ph': 0.68,
  'astro-ph.GA|physics.comp-ph': 0.54,
  'astro-ph.GA|physics.data-an': 0.55,
  'astro-ph.GA|physics.ins-det': 0.65,
  'astro-ph.GA|quant-ph': 0.75,
  'astro-ph.GA|stat.ML': 0.55,
  'astro-ph.HE|astro-ph.IM': 0.38,
  'astro-ph.HE|astro-ph.SR': 0.34,
  'astro-ph.HE|cond-mat.mes-hall': 0.73,
  'astro-ph.HE|cond-mat.mtrl-sci': 0.64,
  'astro-ph.HE|cond-mat.stat-mech': 0.67,
  'astro-ph.HE|cond-mat.str-el': 0.69,
  'astro-ph.HE|cond-mat.supr-con': 0.6,
  'astro-ph.HE|cs.AI': 0.56,
  'astro-ph.HE|cs.CV': 0.56,
  'astro-ph.HE|cs.LG': 0.56,
  'astro-ph.HE|gr-qc': 0.48,
  'astro-ph.HE|hep-ex': 0.57,
  'astro-ph.HE|hep-lat': 0.69,
  'astro-ph.HE|hep-ph': 0.57,
  'astro-ph.HE|hep-th': 0.63,
  'astro-ph.HE|math-ph': 0.67,
  'astro-ph.HE|math.AG': 1,
  'astro-ph.HE|math.DG': 1,
  'astro-ph.HE|math.MP': 0.67,
  'astro-ph.HE|math.QA': 0.71,
  'astro-ph.HE|nucl-ex': 0.59,
  'astro-ph.HE|nucl-th': 0.52,
  'astro-ph.HE|physics.acc-ph': 0.65,
  'astro-ph.HE|physics.comp-ph': 0.52,
  'astro-ph.HE|physics.data-an': 0.55,
  'astro-ph.HE|physics.ins-det': 0.6,
  'astro-ph.HE|quant-ph': 0.75,
  'astro-ph.HE|stat.ML': 0.55,
  'astro-ph.IM|astro-ph.SR': 0.45,
  'astro-ph.IM|cond-mat.mes-hall': 0.65,
  'astro-ph.IM|cond-mat.mtrl-sci': 0.56,
  'astro-ph.IM|cond-mat.stat-mech': 0.67,
  'astro-ph.IM|cond-mat.str-el': 0.7,
  'astro-ph.IM|cond-mat.supr-con': 0.55,
  'astro-ph.IM|cs.AI': 0.44,
  'astro-ph.IM|cs.CV': 0.4,
  'astro-ph.IM|cs.LG': 0.42,
  'astro-ph.IM|gr-qc': 0.49,
  'astro-ph.IM|hep-ex': 0.49,
  'astro-ph.IM|hep-lat': 0.72,
  'astro-ph.IM|hep-ph': 0.62,
  'astro-ph.IM|hep-th': 0.7,
  'astro-ph.IM|math-ph': 0.65,
  'astro-ph.IM|math.AG': 1,
  'astro-ph.IM|math.DG': 0.65,
  'astro-ph.IM|math.MP': 0.65,
  'astro-ph.IM|math.QA': 1,
  'astro-ph.IM|nucl-ex': 0.54,
  'astro-ph.IM|nucl-th': 0.64,
  'astro-ph.IM|physics.acc-ph': 0.57,
  'astro-ph.IM|physics.comp-ph': 0.46,
  'astro-ph.IM|physics.data-an': 0.4,
  'astro-ph.IM|physics.ins-det': 0.36,
  'astro-ph.IM|quant-ph': 0.67,
  'astro-ph.IM|stat.ML': 0.43,
  'astro-ph.SR|cond-mat.mes-hall': 0.72,
  'astro-ph.SR|cond-mat.mtrl-sci': 0.64,
  'astro-ph.SR|cond-mat.stat-mech': 0.67,
  'astro-ph.SR|cond-mat.str-el': 0.73,
  'astro-ph.SR|cond-mat.supr-con': 0.63,
  'astro-ph.SR|cs.AI': 0.63,
  'astro-ph.SR|cs.CV': 0.58,
  'astro-ph.SR|cs.LG': 0.64,
  'astro-ph.SR|gr-qc': 0.58,
  'astro-ph.SR|hep-ex': 0.61,
  'astro-ph.SR|hep-lat': 0.68,
  'astro-ph.SR|hep-ph': 0.62,
  'astro-ph.SR|hep-th': 0.69,
  'astro-ph.SR|math-ph': 0.67,
  'astro-ph.SR|math.AG': 1,
  'astro-ph.SR|math.DG': 1,
  'astro-ph.SR|math.MP': 0.66,
  'astro-ph.SR|math.QA': 1,
  'astro-ph.SR|nucl-ex': 0.53,
  'astro-ph.SR|nucl-th': 0.52,
  'astro-ph.SR|physics.acc-ph': 0.69,
  'astro-ph.SR|physics.comp-ph': 0.54,
  'astro-ph.SR|physics.data-an': 0.58,
  'astro-ph.SR|physics.ins-det': 0.61,
  'astro-ph.SR|quant-ph': 0.74,
  'astro-ph.SR|stat.ML': 1,
  'cond-mat.mes-hall|cond-mat.mtrl-sci': 0.29,
  'cond-mat.mes-hall|cond-mat.stat-mech': 0.44,
  'cond-mat.mes-hall|cond-mat.str-el': 0.35,
  'cond-mat.mes-hall|cond-mat.supr-con': 0.28,
  'cond-mat.mes-hall|cs.AI': 0.54,
  'cond-mat.mes-hall|cs.CV': 0.51,
  'cond-mat.mes-hall|cs.LG': 0.55,
  'cond-mat.mes-hall|gr-qc': 0.65,
  'cond-mat.mes-hall|hep-ex': 0.67,
  'cond-mat.mes-hall|hep-lat': 0.59,
  'cond-mat.mes-hall|hep-ph': 0.66,
  'cond-mat.mes-hall|hep-th': 0.57,
  'cond-mat.mes-hall|math-ph': 0.5,
  'cond-mat.mes-hall|math.AG': 0.61,
  'cond-mat.mes-hall|math.DG': 0.62,
  'cond-mat.mes-hall|math.MP': 0.5,
  'cond-mat.mes-hall|math.QA': 0.61,
  'cond-mat.mes-hall|nucl-ex': 0.66,
  'cond-mat.mes-hall|nucl-th': 0.6,
  'cond-mat.mes-hall|physics.acc-ph': 0.58,
  'cond-mat.mes-hall|physics.comp-ph': 0.46,
  'cond-mat.mes-hall|physics.data-an': 0.56,
  'cond-mat.mes-hall|physics.ins-det': 0.51,
  'cond-mat.mes-hall|quant-ph': 0.35,
  'cond-mat.mes-hall|stat.ML': 0.55,
  'cond-mat.mtrl-sci|cond-mat.stat-mech': 0.47,
  'cond-mat.mtrl-sci|cond-mat.str-el': 0.37,
  'cond-mat.mtrl-sci|cond-mat.supr-con': 0.35,
  'cond-mat.mtrl-sci|cs.AI': 0.54,
  'cond-mat.mtrl-sci|cs.CV': 0.47,
  'cond-mat.mtrl-sci|cs.LG': 0.49,
  'cond-mat.mtrl-sci|gr-qc': 0.62,
  'cond-mat.mtrl-sci|hep-ex': 0.56,
  'cond-mat.mtrl-sci|hep-lat': 0.57,
  'cond-mat.mtrl-sci|hep-ph': 0.62,
  'cond-mat.mtrl-sci|hep-th': 0.59,
  'cond-mat.mtrl-sci|math-ph': 0.53,
  'cond-mat.mtrl-sci|math.AG': 1,
  'cond-mat.mtrl-sci|math.DG': 0.63,
  'cond-mat.mtrl-sci|math.MP': 0.52,
  'cond-mat.mtrl-sci|math.QA': 1,
  'cond-mat.mtrl-sci|nucl-ex': 0.54,
  'cond-mat.mtrl-sci|nucl-th': 0.57,
  'cond-mat.mtrl-sci|physics.acc-ph': 0.46,
  'cond-mat.mtrl-sci|physics.comp-ph': 0.35,
  'cond-mat.mtrl-sci|physics.data-an': 0.45,
  'cond-mat.mtrl-sci|physics.ins-det': 0.37,
  'cond-mat.mtrl-sci|quant-ph': 0.42,
  'cond-mat.mtrl-sci|stat.ML': 0.55,
  'cond-mat.stat-mech|cond-mat.str-el': 0.3,
  'cond-mat.stat-mech|cond-mat.supr-con': 0.47,
  'cond-mat.stat-mech|cs.AI': 0.52,
  'cond-mat.stat-mech|cs.CV': 0.54,
  'cond-mat.stat-mech|cs.LG': 0.47,
  'cond-mat.stat-mech|gr-qc': 0.58,
  'cond-mat.stat-mech|hep-ex': 0.71,
  'cond-mat.stat-mech|hep-lat': 0.46,
  'cond-mat.stat-mech|hep-ph': 0.63,
  'cond-mat.stat-mech|hep-th': 0.46,
  'cond-mat.stat-mech|math-ph': 0.39,
  'cond-mat.stat-mech|nucl-ex': 0.65,
  'cond-mat.stat-mech|nucl-th': 0.58,
  'cond-mat.stat-mech|physics.acc-ph': 0.55,  // estimated from group default
  'cond-mat.stat-mech|physics.comp-ph': 0.42, // estimated from group default
  'cond-mat.stat-mech|physics.data-an': 0.44,
  'cond-mat.stat-mech|physics.ins-det': 0.64,
  'cond-mat.stat-mech|quant-ph': 0.37,
  'cond-mat.stat-mech|stat.ML': 0.44,
  'cond-mat.stat-mech|math.AG': 0.61,
  'cond-mat.stat-mech|math.DG': 0.6,
  'cond-mat.stat-mech|math.MP': 0.38,
  'cond-mat.stat-mech|math.QA': 0.51,
  'cond-mat.str-el|cond-mat.supr-con': 0.33,
  'cond-mat.str-el|cs.AI': 0.58,
  'cond-mat.str-el|cs.CV': 0.54,
  'cond-mat.str-el|cs.LG': 0.5,
  'cond-mat.str-el|gr-qc': 0.6,
  'cond-mat.str-el|hep-ex': 0.7,
  'cond-mat.str-el|hep-lat': 0.46,
  'cond-mat.str-el|hep-ph': 0.63,
  'cond-mat.str-el|hep-th': 0.45,
  'cond-mat.str-el|math-ph': 0.45,
  'cond-mat.str-el|math.AG': 0.61,
  'cond-mat.str-el|math.DG': 0.61,
  'cond-mat.str-el|math.MP': 0.44,
  'cond-mat.str-el|math.QA': 0.46,
  'cond-mat.str-el|nucl-ex': 0.65,
  'cond-mat.str-el|nucl-th': 0.56,
  'cond-mat.str-el|physics.acc-ph': 0.64,
  'cond-mat.str-el|physics.comp-ph': 0.4,
  'cond-mat.str-el|physics.data-an': 0.59,
  'cond-mat.str-el|physics.ins-det': 0.6,
  'cond-mat.str-el|quant-ph': 0.41,
  'cond-mat.str-el|stat.ML': 0.51,
  'cond-mat.supr-con|cs.AI': 0.52,
  'cond-mat.supr-con|cs.CV': 1,
  'cond-mat.supr-con|cs.LG': 1,
  'cond-mat.supr-con|gr-qc': 0.61,
  'cond-mat.supr-con|hep-ex': 0.62,
  'cond-mat.supr-con|hep-lat': 0.55,
  'cond-mat.supr-con|hep-ph': 0.61,
  'cond-mat.supr-con|hep-th': 0.54,
  'cond-mat.supr-con|math-ph': 0.55,
  'cond-mat.supr-con|math.AG': 1,
  'cond-mat.supr-con|math.DG': 1,
  'cond-mat.supr-con|math.MP': 0.55,
  'cond-mat.supr-con|math.QA': 1,
  'cond-mat.supr-con|nucl-ex': 0.59,
  'cond-mat.supr-con|nucl-th': 0.53,
  'cond-mat.supr-con|physics.acc-ph': 0.47,
  'cond-mat.supr-con|physics.comp-ph': 0.5,
  'cond-mat.supr-con|physics.data-an': 0.58,
  'cond-mat.supr-con|physics.ins-det': 0.46,
  'cond-mat.supr-con|quant-ph': 0.43,
  'cond-mat.supr-con|stat.ML': 0.55,
  'cs.AI|cs.CV': 0.27,
  'cs.AI|cs.LG': 0.19,
  'cs.AI|gr-qc': 0.58,
  'cs.AI|hep-ex': 0.51,
  'cs.AI|hep-lat': 0.57,
  'cs.AI|hep-ph': 0.59,
  'cs.AI|hep-th': 0.59,
  'cs.AI|math-ph': 0.55,
  'cs.AI|math.AG': 1,
  'cs.AI|math.DG': 0.58,
  'cs.AI|math.MP': 0.54,
  'cs.AI|math.QA': 0.55,
  'cs.AI|nucl-ex': 0.55,
  'cs.AI|nucl-th': 0.61,
  'cs.AI|physics.acc-ph': 0.48,
  'cs.AI|physics.comp-ph': 0.4,
  'cs.AI|physics.data-an': 0.4,
  'cs.AI|physics.ins-det': 0.5,
  'cs.AI|quant-ph': 0.41,
  'cs.AI|stat.ML': 0.29,
  'cs.CV|cs.LG': 0.23,
  'cs.CV|gr-qc': 0.57,
  'cs.CV|hep-ex': 0.47,
  'cs.CV|hep-lat': 0.56,
  'cs.CV|hep-ph': 0.58,
  'cs.CV|hep-th': 0.63,
  'cs.CV|math-ph': 0.61,
  'cs.CV|math.AG': 1,
  'cs.CV|math.DG': 1,
  'cs.CV|math.MP': 0.61,
  'cs.CV|math.QA': 0.52,
  'cs.CV|nucl-ex': 0.54,
  'cs.CV|nucl-th': 1,
  'cs.CV|physics.acc-ph': 0.56,
  'cs.CV|physics.comp-ph': 0.48,
  'cs.CV|physics.data-an': 0.37,
  'cs.CV|physics.ins-det': 0.4,
  'cs.CV|quant-ph': 0.48,
  'cs.CV|stat.ML': 0.29,
  'cs.LG|gr-qc': 0.58,
  'cs.LG|hep-ex': 0.46,
  'cs.LG|hep-lat': 0.5,
  'cs.LG|hep-ph': 0.55,
  'cs.LG|hep-th': 0.57,
  'cs.LG|math-ph': 0.57,
  'cs.LG|math.AG': 0.49,
  'cs.LG|math.DG': 0.53,
  'cs.LG|math.MP': 0.56,
  'cs.LG|math.QA': 0.54,
  'cs.LG|nucl-ex': 0.55,
  'cs.LG|nucl-th': 0.59,
  'cs.LG|physics.acc-ph': 0.47,
  'cs.LG|physics.comp-ph': 0.36,
  'cs.LG|physics.data-an': 0.32,
  'cs.LG|physics.ins-det': 0.46,
  'cs.LG|quant-ph': 0.41,
  'cs.LG|stat.ML': 0.16,
  'gr-qc|hep-ex': 0.69,
  'gr-qc|hep-lat': 0.64,
  'gr-qc|hep-ph': 0.58,
  'gr-qc|hep-th': 0.41,
  'gr-qc|math-ph': 0.48,
  'gr-qc|math.AG': 0.64,
  'gr-qc|math.DG': 0.43,
  'gr-qc|math.MP': 0.47,
  'gr-qc|math.QA': 0.6,
  'gr-qc|nucl-ex': 0.69,
  'gr-qc|nucl-th': 0.64,
  'gr-qc|physics.acc-ph': 0.68,
  'gr-qc|physics.comp-ph': 0.55,
  'gr-qc|physics.data-an': 0.57,
  'gr-qc|physics.ins-det': 0.63,
  'gr-qc|quant-ph': 0.61,
  'gr-qc|stat.ML': 0.58,
  'hep-ex|hep-lat': 0.49,
  'hep-ex|hep-ph': 0.41,
  'hep-ex|hep-th': 0.67,
  'hep-ex|math-ph': 0.73,
  'hep-ex|math.AG': 1,
  'hep-ex|math.DG': 1,
  'hep-ex|math.MP': 0.72,
  'hep-ex|math.QA': 0.7,
  'hep-ex|nucl-ex': 0.35,
  'hep-ex|nucl-th': 0.48,
  'hep-ex|physics.acc-ph': 0.48,
  'hep-ex|physics.comp-ph': 0.5,
  'hep-ex|physics.data-an': 0.41,
  'hep-ex|physics.ins-det': 0.33,
  'hep-ex|quant-ph': 0.7,
  'hep-ex|stat.ML': 0.46,
  'hep-lat|hep-ph': 0.46,
  'hep-lat|hep-th': 0.52,
  'hep-lat|math-ph': 0.57,
  'hep-lat|math.AG': 0.67,
  'hep-lat|math.DG': 0.62,
  'hep-lat|math.MP': 0.56,
  'hep-lat|math.QA': 0.66,
  'hep-lat|nucl-ex': 0.5,
  'hep-lat|nucl-th': 0.43,
  'hep-lat|physics.acc-ph': 0.68,
  'hep-lat|physics.comp-ph': 0.46,
  'hep-lat|physics.data-an': 0.58,
  'hep-lat|physics.ins-det': 0.72,
  'hep-lat|quant-ph': 0.6,
  'hep-lat|stat.ML': 0.5,
  'hep-ph|hep-th': 0.56,
  'hep-ph|math-ph': 0.65,
  'hep-ph|math.AG': 0.64,
  'hep-ph|math.DG': 0.68,
  'hep-ph|math.MP': 0.64,
  'hep-ph|math.QA': 0.69,
  'hep-ph|nucl-ex': 0.49,
  'hep-ph|nucl-th': 0.44,
  'hep-ph|physics.acc-ph': 0.62,
  'hep-ph|physics.comp-ph': 0.57,
  'hep-ph|physics.data-an': 0.53,
  'hep-ph|physics.ins-det': 0.62,
  'hep-ph|quant-ph': 0.71,
  'hep-ph|stat.ML': 0.52,
  'hep-th|math-ph': 0.41,
  'hep-th|math.AG': 0.42,
  'hep-th|math.DG': 0.47,
  'hep-th|math.MP': 0.39,
  'hep-th|math.QA': 0.44,
  'hep-th|nucl-ex': 0.67,
  'hep-th|nucl-th': 0.6,
  'hep-th|physics.acc-ph': 0.7,
  'hep-th|physics.comp-ph': 0.59,
  'hep-th|physics.data-an': 0.63,
  'hep-th|physics.ins-det': 0.76,
  'hep-th|quant-ph': 0.6,
  'hep-th|stat.ML': 0.55,
  'math-ph|math.AG': 0.36,
  'math-ph|math.DG': 0.34,
  'math-ph|math.MP': 0.02,
  'math-ph|math.QA': 0.32,
  'math-ph|nucl-ex': 0.71,
  'math-ph|nucl-th': 0.62,
  'math-ph|physics.acc-ph': 0.6,
  'math-ph|physics.comp-ph': 0.5,
  'math-ph|physics.data-an': 0.54,
  'math-ph|physics.ins-det': 0.7,
  'math-ph|quant-ph': 0.42,
  'math-ph|stat.ML': 0.55,
  'math.AG|math.DG': 0.31,
  'math.AG|math.MP': 0.35,
  'math.AG|math.QA': 0.33,
  'math.AG|nucl-ex': 1,
  'math.AG|nucl-th': 0.7,
  'math.AG|physics.acc-ph': 1,
  'math.AG|physics.comp-ph': 0.61,
  'math.AG|physics.data-an': 1,
  'math.AG|physics.ins-det': 1,
  'math.AG|quant-ph': 0.6,
  'math.AG|stat.ML': 0.45,
  'math.DG|math.MP': 0.33,
  'math.DG|math.QA': 0.41,
  'math.DG|nucl-ex': 1,
  'math.DG|nucl-th': 0.71,
  'math.DG|physics.acc-ph': 0.64,
  'math.DG|physics.comp-ph': 0.6,
  'math.DG|physics.data-an': 0.58,
  'math.DG|physics.ins-det': 1,
  'math.DG|quant-ph': 0.62,
  'math.DG|stat.ML': 0.52,
  'math.MP|math.QA': 0.31,
  'math.MP|nucl-ex': 0.7,
  'math.MP|nucl-th': 0.61,
  'math.MP|physics.acc-ph': 0.59,
  'math.MP|physics.comp-ph': 0.49,
  'math.MP|physics.data-an': 0.53,
  'math.MP|physics.ins-det': 0.69,
  'math.MP|quant-ph': 0.4,
  'math.MP|stat.ML': 0.54,
  'math.QA|nucl-ex': 1,
  'math.QA|nucl-th': 0.67,
  'math.QA|physics.acc-ph': 1,
  'math.QA|physics.comp-ph': 0.62,
  'math.QA|physics.data-an': 1,
  'math.QA|physics.ins-det': 1,
  'math.QA|quant-ph': 0.55,
  'math.QA|stat.ML': 0.53,
  'nucl-ex|nucl-th': 0.3,
  'nucl-ex|physics.acc-ph': 0.5,
  'nucl-ex|physics.comp-ph': 0.52,
  'nucl-ex|physics.data-an': 0.47,
  'nucl-ex|physics.ins-det': 0.37,
  'nucl-ex|quant-ph': 0.68,
  'nucl-ex|stat.ML': 0.55,
  'nucl-th|physics.acc-ph': 0.64,
  'nucl-th|physics.comp-ph': 0.5,
  'nucl-th|physics.data-an': 0.54,
  'nucl-th|physics.ins-det': 0.65,
  'nucl-th|quant-ph': 0.64,
  'nucl-th|stat.ML': 0.56,
  'physics.acc-ph|physics.comp-ph': 0.4,
  'physics.acc-ph|physics.data-an': 0.5,
  'physics.acc-ph|physics.ins-det': 0.43,
  'physics.acc-ph|quant-ph': 0.63,
  'physics.acc-ph|stat.ML': 0.54,
  'physics.comp-ph|physics.data-an': 0.34,
  'physics.comp-ph|physics.ins-det': 0.46,
  'physics.comp-ph|quant-ph': 0.42,
  'physics.comp-ph|stat.ML': 0.38,
  'physics.data-an|physics.ins-det': 0.41,
  'physics.data-an|quant-ph': 0.55,
  'physics.data-an|stat.ML': 0.29,
  'physics.ins-det|quant-ph': 0.61,
  'physics.ins-det|stat.ML': 0.51,
  'quant-ph|stat.ML': 0.45,
};

/**
 * Get the group a category belongs to
 */
export function getCategoryGroup(category: string): string | null {
  for (const [group, cats] of Object.entries(CATEGORY_GROUPS)) {
    if ((cats as readonly string[]).includes(category)) {
      return group;
    }
  }
  return null;
}
