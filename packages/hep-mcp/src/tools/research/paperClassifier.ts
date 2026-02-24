/**
 * Paper Classifier - Identifies paper types and calculates enhanced scores
 * Distinguishes between: original research, review, conference, thesis
 *
 * Enhanced with conference paper detection for tracing to original journal papers
 */

import type { PaperSummary } from '@autoresearch/shared';
import { getConfig } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PaperType = 'original' | 'review' | 'conference' | 'thesis' | 'lecture';

/**
 * Content type for claims extraction strategy selection
 * - experimental: papers with measurements, observations, discoveries
 * - theoretical: papers with predictions, calculations, models
 * - review: comprehensive reviews of a field
 * - mixed: combination of experimental and theoretical content
 */
export type ContentType = 'experimental' | 'theoretical' | 'review' | 'mixed';

// Conference paper detection keywords
const CONFERENCE_KEYWORDS = [
  'proceedings', 'proc.', 'conf.', 'conference', 'symposium',
  'workshop', 'meeting', 'colloquium', 'congress',
];

// Common conference series in HEP
const CONFERENCE_SERIES = [
  'pos', 'epj web', 'j.phys.conf', 'aip conf', 'nucl.phys.proc.suppl',
  'acta phys.polon', 'int.j.mod.phys.conf',
];

// Experimental paper keywords (for content type classification)
// Covers: particle physics, nuclear physics, astrophysics, cosmology, neutrino, dark matter
// Reference: INSPIRE HEP categories and arXiv classifications
const EXPERIMENTAL_KEYWORDS = [
  // ═══════════════════════════════════════════════════════════════════════════
  // General experimental terms
  // ═══════════════════════════════════════════════════════════════════════════
  'measurement', 'observation', 'discovery', 'detection', 'experiment',
  'data', 'search for', 'evidence', 'first observation', 'experimental',
  'systematic uncertainty', 'statistical significance', 'upper limit', 'lower limit',
  'confidence level', 'exclusion', 'sensitivity', 'background', 'signal',
  'event selection', 'event reconstruction', 'monte carlo',

  // ═══════════════════════════════════════════════════════════════════════════
  // Standard Model Physics (experimental)
  // ═══════════════════════════════════════════════════════════════════════════
  // Flavor physics
  'b physics', 'charm physics', 'kaon physics', 'tau physics', 'muon physics',
  'top physics', 'bottom quark', 'charm quark', 'strange quark',
  'cp violation', 'flavour physics', 'flavor physics', 'rare decay',
  'lepton production', 'quarkonium', 'charmonium', 'bottomonium',
  'meson', 'baryon', 'hadron spectroscopy',

  // Electroweak and Higgs
  'higgs boson', 'electroweak', 'w boson', 'z boson', 'diboson',
  'triboson', 'vector boson', 'symmetry breaking',

  // QCD experimental
  'jet physics', 'jet substructure', 'boosted jets', 'multi-parton',
  'parton distribution', 'fragmentation', 'hadronization',
  'deep inelastic scattering', 'dis',

  // ═══════════════════════════════════════════════════════════════════════════
  // Beyond Standard Model (BSM) searches
  // ═══════════════════════════════════════════════════════════════════════════
  'new particle', 'new physics', 'bsm', 'beyond standard model',
  'supersymmetry search', 'susy search', 'exotics', 'exotic states',
  'axion search', 'dark photon', 'hidden sector',
  'long-lived particle', 'displaced vertex', 'heavy neutral lepton',
  'leptoquark', 'zprime', 'wprime', 'extra dimensions search',

  // ═══════════════════════════════════════════════════════════════════════════
  // Collider experiments and facilities
  // ═══════════════════════════════════════════════════════════════════════════
  'cross section', 'branching ratio', 'mass measurement', 'width measurement',
  'luminosity', 'detector', 'collider', 'accelerator',
  // LHC experiments
  'lhc', 'atlas', 'cms', 'lhcb', 'alice', 'totem', 'lhcf',
  // Other colliders
  'tevatron', 'cdf', 'd0', 'hera', 'lep', 'slac', 'fermilab', 'cern',
  'belle', 'belle ii', 'babar', 'besiii', 'bes iii', 'bepc',
  'kek', 'superkekb', 'cepc', 'fcc', 'ilc', 'clic',
  // Fixed target
  'fixed target', 'compass', 'na62', 'na61', 'lhcb fixed target',
  // Detector technologies
  'trigger', 'reconstruction', 'tracking', 'calorimeter', 'muon system',
  'silicon detector', 'pixel detector', 'drift chamber', 'tpc',
  'particle identification', 'pid', 'rich', 'tof',

  // ═══════════════════════════════════════════════════════════════════════════
  // Nuclear physics experiments
  // ═══════════════════════════════════════════════════════════════════════════
  'nuclear reaction', 'scattering', 'fragmentation', 'fission', 'fusion',
  'beam', 'target', 'spectrometer', 'gamma ray', 'neutron',
  'radioactive beam', 'isotope', 'half-life', 'decay rate',
  'nuclear structure', 'nuclear spectroscopy', 'isomer',
  'nucleosynthesis', 'r-process', 'rp-process', 's-process',
  // Facilities
  'gsi', 'fair', 'riken', 'ribf', 'triumf', 'ganil', 'isolde',
  'jlab', 'jefferson lab', 'lansce', 'ornl',

  // ═══════════════════════════════════════════════════════════════════════════
  // Neutrino experiments
  // ═══════════════════════════════════════════════════════════════════════════
  'neutrino oscillation', 'neutrino mass', 'mixing angle', 'pmns',
  'sterile neutrino', 'majorana', 'dirac neutrino',
  'double beta decay', 'neutrinoless', '0vbb',
  // Experiments
  'super-kamiokande', 'sno', 'daya bay', 'double chooz', 'reno',
  'nova', 'minos', 't2k', 'icecube', 'borexino', 'kamland',
  'dune', 'hyper-kamiokande', 'juno', 'katrin',

  // ═══════════════════════════════════════════════════════════════════════════
  // Dark matter experiments
  // ═══════════════════════════════════════════════════════════════════════════
  'dark matter detection', 'direct detection', 'indirect detection',
  'wimp', 'nuclear recoil', 'spin-independent', 'spin-dependent',
  'annual modulation', 'directional detection',
  // Experiments
  'xenon', 'lux', 'lz', 'pandax', 'darkside', 'deap',
  'cdms', 'supercdms', 'cresst', 'edelweiss',
  'dama', 'cosine', 'anais', 'sabre',

  // ═══════════════════════════════════════════════════════════════════════════
  // Astrophysics and cosmology observations
  // ═══════════════════════════════════════════════════════════════════════════
  'telescope', 'survey', 'photometry', 'spectroscopy', 'redshift',
  'cmb', 'cosmic microwave background', 'bao', 'weak lensing',
  'gravitational wave', 'pulsar', 'supernova', 'gamma-ray burst',
  // Observatories
  'hubble', 'jwst', 'planck', 'wmap', 'sdss', 'des', 'lsst', 'euclid',
  'ligo', 'virgo', 'kagra', 'fermi', 'hess', 'magic', 'veritas',
  'auger', 'ta', 'hawc', 'dampe', 'calet',

  // ═══════════════════════════════════════════════════════════════════════════
  // Heavy ion experiments
  // ═══════════════════════════════════════════════════════════════════════════
  'heavy ion', 'quark-gluon plasma', 'qgp', 'deconfinement',
  'centrality', 'flow', 'jet quenching', 'strangeness enhancement',
  'rhic', 'star', 'phenix', 'brahms', 'phobos',
];

// Theoretical paper keywords (for content type classification)
// Covers: QFT, string theory, cosmology theory, nuclear theory, mathematical physics
// Reference: INSPIRE HEP categories and arXiv classifications
const THEORETICAL_KEYWORDS = [
  // ═══════════════════════════════════════════════════════════════════════════
  // General theoretical terms
  // ═══════════════════════════════════════════════════════════════════════════
  'calculation', 'prediction', 'model', 'theory', 'theoretical',
  'analytical', 'numerical', 'simulation', 'framework', 'formalism',
  'derivation', 'proof', 'conjecture', 'hypothesis', 'ansatz',

  // ═══════════════════════════════════════════════════════════════════════════
  // QCD and hadron physics theory
  // ═══════════════════════════════════════════════════════════════════════════
  'qcd', 'lattice qcd', 'perturbative qcd', 'non-perturbative',
  'effective field theory', 'chiral perturbation', 'heavy quark',
  'sum rules', 'qcd sum rules', 'light-cone', 'dispersion relation',
  'amplitude', 'form factor', 'coupling constant', 'decay constant',
  'hadronic', 'quark model', 'potential model', 'constituent quark',
  'molecular state', 'tetraquark', 'pentaquark', 'exotic hadron',
  'phenomenology', 'unitarized', 'coupled channel', 'final state interaction',

  // ═══════════════════════════════════════════════════════════════════════════
  // Electroweak and BSM theory
  // ═══════════════════════════════════════════════════════════════════════════
  'standard model', 'electroweak', 'higgs mechanism', 'spontaneous symmetry breaking',
  'supersymmetry', 'susy', 'mssm', 'nmssm', 'split susy',
  'grand unified', 'gut', 'so(10)', 'su(5)',
  'extra dimensions', 'kaluza-klein', 'randall-sundrum', 'add',
  'composite higgs', 'technicolor', 'little higgs', 'twin higgs',
  'neutral naturalness', 'relaxion', 'clockwork',

  // ═══════════════════════════════════════════════════════════════════════════
  // String theory and quantum gravity
  // ═══════════════════════════════════════════════════════════════════════════
  'string theory', 'superstring', 'm-theory', 'brane', 'd-brane',
  'ads/cft', 'holography', 'gauge/gravity', 'conformal field theory', 'cft',
  'quantum gravity', 'loop quantum gravity', 'spin foam',
  'black hole', 'hawking radiation', 'bekenstein-hawking', 'entropy',
  'information paradox', 'firewall', 'swampland', 'landscape',

  // ═══════════════════════════════════════════════════════════════════════════
  // Cosmology theory
  // ═══════════════════════════════════════════════════════════════════════════
  'inflation', 'slow-roll', 'chaotic inflation', 'eternal inflation',
  'dark energy', 'cosmological constant', 'quintessence', 'phantom',
  'modified gravity', 'f(r)', 'scalar-tensor', 'horndeski',
  'baryogenesis', 'leptogenesis', 'electroweak baryogenesis',
  'primordial', 'perturbation theory', 'power spectrum', 'non-gaussianity',

  // ═══════════════════════════════════════════════════════════════════════════
  // Nuclear theory
  // ═══════════════════════════════════════════════════════════════════════════
  'nuclear structure', 'shell model', 'mean field', 'density functional',
  'ab initio', 'many-body', 'nuclear force', 'chiral effective field theory',
  'halo nuclei', 'neutron star', 'equation of state', 'nuclear matter',

  // ═══════════════════════════════════════════════════════════════════════════
  // Mathematical physics
  // ═══════════════════════════════════════════════════════════════════════════
  'symmetry', 'group theory', 'representation', 'lie algebra',
  'topology', 'anomaly', 'instanton', 'soliton', 'monopole',
  'renormalization', 'regularization', 'divergence', 'resummation',
  'scattering amplitude', 'unitarity', 'analyticity', 'crossing',
];

export interface ClassifiedPaper extends PaperSummary {
  paper_type: PaperType;
  is_review: boolean;
  is_conference: boolean;
  type_confidence: number; // 0-1
}

// ─────────────────────────────────────────────────────────────────────────────
// Conference Paper Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a paper is a conference paper based on INSPIRE metadata and heuristics
 *
 * Detection priority:
 * 1. INSPIRE document_type field (most reliable, tc c in search syntax)
 * 2. INSPIRE publication_type field
 * 3. Heuristic fallback: publication info keywords
 */
export function isConferencePaper(paper: PaperSummary): { isConference: boolean; confidence: number } {
  // Priority 1: Check INSPIRE document_type field (definitive)
  // This is the official INSPIRE classification (tc c in search syntax)
  if (paper.document_type?.some(t =>
    t.toLowerCase().includes('conference') || t.toLowerCase().includes('proceedings')
  )) {
    return { isConference: true, confidence: 1.0 };
  }

  // Priority 2: Check INSPIRE publication_type field
  if (paper.publication_type?.includes('conference')) {
    return { isConference: true, confidence: 1.0 };
  }

  // Priority 3: Heuristic detection from publication info
  const pubInfo = paper.publication_summary?.toLowerCase() || '';

  let score = 0;
  let maxScore = 0;

  // Check conference keywords in publication info
  maxScore += 0.4;
  for (const keyword of CONFERENCE_KEYWORDS) {
    if (pubInfo.includes(keyword)) {
      score += 0.4;
      break;
    }
  }

  // Check known conference series
  maxScore += 0.4;
  for (const series of CONFERENCE_SERIES) {
    if (pubInfo.includes(series)) {
      score += 0.4;
      break;
    }
  }

  // Check for "contribution to" pattern (common in conference papers)
  maxScore += 0.2;
  if (pubInfo.includes('contribution to') || pubInfo.includes('talk given at')) {
    score += 0.2;
  }

  const confidence = maxScore > 0 ? score / maxScore : 0;
  return {
    isConference: confidence >= 0.5,
    confidence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Review Paper Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a paper is likely a review based on INSPIRE metadata and heuristics
 *
 * Detection priority:
 * 1. INSPIRE publication_type field (most reliable, tc r in search)
 * 2. Heuristic fallback: title keywords + journal names + citation patterns
 */
export function isReviewPaper(paper: PaperSummary): { isReview: boolean; confidence: number } {
  // Priority 1: Check INSPIRE publication_type field (definitive)
  // This is the official INSPIRE classification (tc r in search syntax)
  if (paper.publication_type?.includes('review')) {
    return { isReview: true, confidence: 1.0 };
  }

  // Priority 2: Heuristic fallback for papers without publication_type
  const config = getConfig();
  const { reviewDetection, thresholds } = config;

  const title = paper.title?.toLowerCase() || '';
  const pubSummary = paper.publication_summary?.toLowerCase() || '';

  let score = 0;
  let maxScore = 0;

  // Check title keywords
  maxScore += reviewDetection.titleWeight;
  for (const keyword of reviewDetection.titleKeywords) {
    if (title.includes(keyword)) {
      score += reviewDetection.titleWeight;
      break;
    }
  }

  // Check journal
  maxScore += reviewDetection.journalWeight;
  for (const journal of reviewDetection.reviewJournals) {
    if (pubSummary.includes(journal.toLowerCase())) {
      score += reviewDetection.journalWeight;
      break;
    }
  }

  // High citation count for recent papers suggests review
  maxScore += reviewDetection.citationPatternWeight;
  const currentYear = new Date().getFullYear();
  const age = paper.year ? currentYear - paper.year : 0;
  if (age <= 3 && (paper.citation_count || 0) > 200) {
    score += reviewDetection.citationPatternWeight;
  }

  const confidence = score / maxScore;
  return {
    isReview: confidence >= thresholds.reviewScoreThreshold,
    confidence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Paper Type Classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify paper type based on available metadata
 * Priority: review > conference > original
 */
export function classifyPaper(paper: PaperSummary): ClassifiedPaper {
  const reviewCheck = isReviewPaper(paper);
  const conferenceCheck = isConferencePaper(paper);

  // Priority 1: Review papers
  if (reviewCheck.isReview) {
    return {
      ...paper,
      paper_type: 'review',
      is_review: true,
      is_conference: false,
      type_confidence: reviewCheck.confidence,
    };
  }

  // Priority 2: Conference papers
  if (conferenceCheck.isConference) {
    return {
      ...paper,
      paper_type: 'conference',
      is_review: false,
      is_conference: true,
      type_confidence: conferenceCheck.confidence,
    };
  }

  // Default: Original research
  return {
    ...paper,
    paper_type: 'original',
    is_review: false,
    is_conference: false,
    type_confidence: Math.max(1 - reviewCheck.confidence, 1 - conferenceCheck.confidence),
  };
}

/**
 * Batch classify papers
 */
export function classifyPapers(papers: PaperSummary[]): ClassifiedPaper[] {
  return papers.map(classifyPaper);
}

// ─────────────────────────────────────────────────────────────────────────────
// Content Type Classification (for claims extraction strategy)
// ─────────────────────────────────────────────────────────────────────────────

// arXiv category to content type mapping (most reliable classification method)
const ARXIV_EXPERIMENTAL_CATEGORIES = [
  'hep-ex',      // High Energy Physics - Experiment
  'nucl-ex',     // Nuclear Experiment
  'physics.ins-det', // Instrumentation and Detectors
  'astro-ph.IM', // Instrumentation and Methods
  'astro-ph.HE', // High Energy Astrophysical Phenomena (often observational)
];

const ARXIV_THEORETICAL_CATEGORIES = [
  'hep-th',      // High Energy Physics - Theory
  'hep-ph',      // High Energy Physics - Phenomenology
  'nucl-th',     // Nuclear Theory
  'gr-qc',       // General Relativity and Quantum Cosmology
  'astro-ph.CO', // Cosmology and Nongalactic Astrophysics (theory-heavy)
  'quant-ph',    // Quantum Physics
  'cond-mat.str-el', // Strongly Correlated Electrons
  'math-ph',     // Mathematical Physics
];

const ARXIV_MIXED_CATEGORIES = [
  'hep-lat',     // Lattice (numerical/computational)
  'astro-ph.GA', // Galaxies (mixed obs/theory)
  'astro-ph.SR', // Solar and Stellar (mixed)
];

export interface ContentClassification {
  content_type: ContentType;
  confidence: number;
  experimental_score: number;
  theoretical_score: number;
  /** Classification method used */
  method: 'arxiv' | 'keywords' | 'default';
}

/**
 * Classify paper content type for claims extraction strategy selection
 *
 * Priority:
 * 1. Review paper check (highest priority)
 * 2. arXiv category (most reliable for non-review papers)
 * 3. Keyword matching (fallback)
 *
 * @param paper - Paper metadata from INSPIRE
 * @param abstract - Optional abstract text (if not in paper object)
 * @returns Content type classification with confidence scores
 */
export function classifyContentType(
  paper: PaperSummary,
  abstract?: string
): ContentClassification {
  // Priority 1: Check if it's a review first
  const reviewCheck = isReviewPaper(paper);
  if (reviewCheck.isReview && reviewCheck.confidence >= 0.8) {
    return {
      content_type: 'review',
      confidence: reviewCheck.confidence,
      experimental_score: 0,
      theoretical_score: 0,
      method: 'arxiv',
    };
  }

  // Priority 2: Use arXiv category (most reliable)
  const arxivResult = classifyByArxivCategory(paper);
  if (arxivResult) {
    return arxivResult;
  }

  // Priority 3: Fallback to keyword matching
  return classifyByKeywords(paper, abstract);
}

/**
 * Classify by arXiv category (most reliable method)
 */
function classifyByArxivCategory(paper: PaperSummary): ContentClassification | null {
  const primaryCat = paper.arxiv_primary_category?.toLowerCase();
  const allCats = paper.arxiv_categories?.map(c => c.toLowerCase()) || [];

  if (!primaryCat && allCats.length === 0) {
    return null; // No arXiv info available
  }

  // Check primary category first
  if (primaryCat) {
    if (ARXIV_EXPERIMENTAL_CATEGORIES.includes(primaryCat)) {
      return {
        content_type: 'experimental',
        confidence: 0.95,
        experimental_score: 1,
        theoretical_score: 0,
        method: 'arxiv',
      };
    }
    if (ARXIV_THEORETICAL_CATEGORIES.includes(primaryCat)) {
      return {
        content_type: 'theoretical',
        confidence: 0.95,
        experimental_score: 0,
        theoretical_score: 1,
        method: 'arxiv',
      };
    }
    if (ARXIV_MIXED_CATEGORIES.includes(primaryCat)) {
      return {
        content_type: 'mixed',
        confidence: 0.9,
        experimental_score: 0.5,
        theoretical_score: 0.5,
        method: 'arxiv',
      };
    }
  }

  // Check cross-listed categories
  const expCount = allCats.filter(c => ARXIV_EXPERIMENTAL_CATEGORIES.includes(c)).length;
  const theoCount = allCats.filter(c => ARXIV_THEORETICAL_CATEGORIES.includes(c)).length;

  if (expCount > 0 && theoCount === 0) {
    return {
      content_type: 'experimental',
      confidence: 0.85,
      experimental_score: 1,
      theoretical_score: 0,
      method: 'arxiv',
    };
  }
  if (theoCount > 0 && expCount === 0) {
    return {
      content_type: 'theoretical',
      confidence: 0.85,
      experimental_score: 0,
      theoretical_score: 1,
      method: 'arxiv',
    };
  }
  if (expCount > 0 && theoCount > 0) {
    return {
      content_type: 'mixed',
      confidence: 0.8,
      experimental_score: expCount / (expCount + theoCount),
      theoretical_score: theoCount / (expCount + theoCount),
      method: 'arxiv',
    };
  }

  return null; // Unknown category
}

/**
 * Classify by keyword matching (fallback method)
 */
function classifyByKeywords(
  paper: PaperSummary,
  abstract?: string
): ContentClassification {
  const title = paper.title?.toLowerCase() || '';
  const abstractText = (abstract || '').toLowerCase();
  const text = `${title} ${abstractText}`;

  let expScore = 0;
  let theoScore = 0;

  for (const kw of EXPERIMENTAL_KEYWORDS) {
    if (text.includes(kw)) expScore++;
  }
  for (const kw of THEORETICAL_KEYWORDS) {
    if (text.includes(kw)) theoScore++;
  }

  const maxExp = EXPERIMENTAL_KEYWORDS.length;
  const maxTheo = THEORETICAL_KEYWORDS.length;
  const normalizedExp = expScore / maxExp;
  const normalizedTheo = theoScore / maxTheo;

  let contentType: ContentType;
  let confidence: number;

  if (expScore > 0 && theoScore > 0) {
    const ratio = expScore / (expScore + theoScore);
    if (ratio > 0.7) {
      contentType = 'experimental';
      confidence = ratio * 0.7; // Lower confidence for keyword method
    } else if (ratio < 0.3) {
      contentType = 'theoretical';
      confidence = (1 - ratio) * 0.7;
    } else {
      contentType = 'mixed';
      confidence = 0.6;
    }
  } else if (expScore > theoScore) {
    contentType = 'experimental';
    confidence = Math.min(normalizedExp * 2, 0.7);
  } else if (theoScore > expScore) {
    contentType = 'theoretical';
    confidence = Math.min(normalizedTheo * 2, 0.7);
  } else {
    contentType = 'mixed';
    confidence = 0.5;
  }

  return {
    content_type: contentType,
    confidence,
    experimental_score: normalizedExp,
    theoretical_score: normalizedTheo,
    method: expScore > 0 || theoScore > 0 ? 'keywords' : 'default',
  };
}
