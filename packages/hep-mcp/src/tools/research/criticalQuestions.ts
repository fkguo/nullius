/**
 * Critical Questions Generator
 * Generates reviewer-style critical questions and detects red flags
 *
 * Features:
 * - Paper type classification (experimental, theoretical, etc.)
 * - Targeted question generation based on paper type
 * - Red flag detection (high self-citation, comments, etc.)
 * - Reliability scoring
 */

import * as api from '../../api/client.js';
import { getConfig, validateRecid } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PaperType = 'experimental' | 'theoretical' | 'phenomenological' | 'review' | 'lattice' | 'instrumentation';

export type RedFlagType =
  | 'high_self_citation'
  | 'no_confirmation'
  | 'comment_exists'
  | 'single_author'
  | 'no_experimental_basis'
  | 'excessive_claims'
  | 'methodology_unclear'
  | 'low_citations_old_paper';

export interface RedFlag {
  type: RedFlagType;
  description: string;
  severity: 'warning' | 'concern';
  details?: string;
}

export interface CriticalQuestions {
  /** Questions about methodology */
  methodology: string[];
  /** Questions about assumptions */
  assumptions: string[];
  /** Questions about alternative explanations */
  alternatives: string[];
  /** Questions about reproducibility */
  reproducibility: string[];
  /** Questions about implications */
  implications: string[];
}

export interface CriticalQuestionsParams {
  /** INSPIRE recid of the paper to analyze */
  recid: string;
  /** Check for "Comment on" papers (default: true) */
  check_comments?: boolean;
  /** Calculate self-citation rate (default: true) */
  check_self_citations?: boolean;
}

export interface CriticalQuestionsResult {
  paper_recid: string;
  paper_title: string;
  paper_year?: number;
  paper_type: PaperType;
  success: boolean;
  error?: string;
  /** Generated critical questions */
  questions: CriticalQuestions;
  /** Detected red flags */
  red_flags: RedFlag[];
  /** Overall reliability score (0-1) */
  reliability_score: number;
  /** Metrics used for analysis */
  metrics: {
    author_count: number;
    citation_count: number;
    self_citation_rate?: number;
    has_comments: boolean;
    paper_age_years: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Keywords for paper type classification
const PAPER_TYPE_KEYWORDS: Record<PaperType, string[]> = {
  experimental: [
    'data', 'detector', 'measurement', 'observation', 'luminosity',
    'collision', 'experiment', 'ATLAS', 'CMS', 'LHCb', 'ALICE', 'Belle',
    'BaBar', 'BESIII', 'event', 'trigger', 'reconstruction',
  ],
  theoretical: [
    'derive', 'proof', 'theorem', 'conjecture', 'calculation',
    'analytical', 'exact', 'string theory', 'quantum field',
    'supersymmetry', 'holography', 'conformal',
  ],
  phenomenological: [
    'phenomenology', 'model', 'predict', 'fit', 'parameter',
    'standard model', 'beyond standard model', 'BSM', 'effective',
    'cross section', 'branching ratio',
  ],
  review: [
    'review', 'status', 'progress', 'overview', 'survey',
    'perspective', 'lecture', 'introduction to',
  ],
  lattice: [
    'lattice', 'Monte Carlo', 'QCD simulation', 'gauge configuration',
    'quenched', 'dynamical fermion', 'chiral extrapolation',
  ],
  instrumentation: [
    'detector', 'calibration', 'performance', 'upgrade',
    'technical design', 'readout', 'silicon', 'calorimeter',
  ],
};

// Question templates by paper type
const QUESTION_TEMPLATES: Record<PaperType, CriticalQuestions> = {
  experimental: {
    methodology: [
      'What are the main sources of systematic uncertainty?',
      'How was the background estimated and validated?',
      'What selection criteria were used and how were they optimized?',
      'How was the detector response simulated and validated?',
    ],
    assumptions: [
      'What theoretical model was assumed for signal extraction?',
      'Are the efficiency corrections model-dependent?',
      'What assumptions were made about background composition?',
    ],
    alternatives: [
      'Could the observed effect be due to detector artifacts?',
      'Have alternative signal hypotheses been tested?',
      'Could statistical fluctuations explain the result?',
    ],
    reproducibility: [
      'Has this measurement been confirmed by other experiments?',
      'Are the results consistent with previous measurements?',
      'Is the analysis procedure documented sufficiently for reproduction?',
    ],
    implications: [
      'How does this result constrain theoretical models?',
      'What follow-up measurements would strengthen the conclusion?',
      'What are the implications for related physics processes?',
    ],
  },
  theoretical: {
    methodology: [
      'Are the approximations used justified for this regime?',
      'How sensitive are the results to the choice of regularization?',
      'Have higher-order corrections been estimated?',
    ],
    assumptions: [
      'What are the key assumptions underlying the derivation?',
      'Under what conditions do these assumptions break down?',
      'Are there implicit assumptions about the UV completion?',
    ],
    alternatives: [
      'Could alternative theoretical frameworks give different predictions?',
      'Have competing approaches been compared?',
      'What happens if key assumptions are relaxed?',
    ],
    reproducibility: [
      'Can the derivation be reproduced from the given equations?',
      'Are intermediate steps sufficiently documented?',
      'Have the results been cross-checked with numerical methods?',
    ],
    implications: [
      'What experimental signatures would test this theory?',
      'How does this relate to existing theoretical frameworks?',
      'What are the phenomenological consequences?',
    ],
  },
  phenomenological: {
    methodology: [
      'How were the model parameters constrained?',
      'What fitting procedure was used and is it robust?',
      'How were theoretical uncertainties propagated?',
    ],
    assumptions: [
      'What new physics assumptions underlie the model?',
      'How model-dependent are the extracted parameters?',
      'Are there degeneracies in the parameter space?',
    ],
    alternatives: [
      'Could other new physics scenarios explain the data?',
      'Have SM explanations been fully excluded?',
      'What alternative parametrizations exist?',
    ],
    reproducibility: [
      'Are the model implementation details publicly available?',
      'Can the fits be reproduced with different statistical methods?',
      'Have the results been validated against other groups?',
    ],
    implications: [
      'What additional observables could distinguish models?',
      'What are the discovery prospects at future experiments?',
      'How does this constrain the parameter space?',
    ],
  },
  review: {
    methodology: [
      'What criteria were used for paper selection?',
      'How were conflicting results treated?',
      'Is the coverage comprehensive for the stated scope?',
    ],
    assumptions: [
      'Does the review present a balanced view of competing interpretations?',
      'Are potential biases of the authors acknowledged?',
      'Are limitations of reviewed methods discussed?',
    ],
    alternatives: [
      'Are alternative viewpoints adequately represented?',
      'Have minority opinions been given fair treatment?',
      'Are there important works missing from the review?',
    ],
    reproducibility: [
      'Can the conclusions be verified from the cited sources?',
      'Are the summary statistics correctly extracted?',
      'Is the logic chain from evidence to conclusions clear?',
    ],
    implications: [
      'What are the identified open questions?',
      'What future directions are suggested?',
      'How does this change the current understanding?',
    ],
  },
  lattice: {
    methodology: [
      'What lattice actions were used for gauge and fermion fields?',
      'How were finite volume effects estimated?',
      'What continuum extrapolation procedure was applied?',
    ],
    assumptions: [
      'What are the systematic effects from using unphysical quark masses?',
      'How was the chiral extrapolation performed?',
      'What assumptions were made about excited state contamination?',
    ],
    alternatives: [
      'How do results compare between different discretizations?',
      'Have alternative analysis strategies been tested?',
      'What happens with different fit ranges?',
    ],
    reproducibility: [
      'Are gauge configurations publicly available?',
      'Can the analysis be reproduced from the provided details?',
      'Have results been cross-checked with other collaborations?',
    ],
    implications: [
      'How do these results compare with phenomenological determinations?',
      'What precision is achievable with current methods?',
      'What are the implications for precision tests of the Standard Model?',
    ],
  },
  instrumentation: {
    methodology: [
      'How was the detector performance validated?',
      'What calibration procedures were used?',
      'How were systematic effects in measurements controlled?',
    ],
    assumptions: [
      'What assumptions were made about detector conditions?',
      'How sensitive are results to environmental factors?',
      'What are the limits of the simulation accuracy?',
    ],
    alternatives: [
      'How does this compare to alternative detector technologies?',
      'Could different design choices improve performance?',
      'What are the trade-offs in the design decisions?',
    ],
    reproducibility: [
      'Are the technical specifications sufficiently detailed?',
      'Can the performance be reproduced in simulation?',
      'Have results been validated in test beam measurements?',
    ],
    implications: [
      'What physics reach is enabled by this detector performance?',
      'What are the implications for future detector designs?',
      'How does this compare to requirements for future experiments?',
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify paper type based on content
 */
function classifyPaperType(title: string, abstract: string): PaperType {
  const text = `${title} ${abstract}`.toLowerCase();

  // Score each type
  const scores: Record<PaperType, number> = {
    experimental: 0,
    theoretical: 0,
    phenomenological: 0,
    review: 0,
    lattice: 0,
    instrumentation: 0,
  };

  for (const [type, keywords] of Object.entries(PAPER_TYPE_KEYWORDS)) {
    for (const keyword of keywords) {
      if (text.includes(keyword.toLowerCase())) {
        scores[type as PaperType]++;
      }
    }
  }

  // Find highest scoring type
  let maxType: PaperType = 'phenomenological';
  let maxScore = 0;

  for (const [type, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxType = type as PaperType;
    }
  }

  return maxType;
}

/**
 * Calculate self-citation rate
 */
async function calculateSelfCitationRate(
  recid: string,
  authors: string[]
): Promise<number | undefined> {
  try {
    // Use full references (no silent truncation) to avoid biased self-citation estimates.
    const refs = await api.getReferences(recid);
    if (refs.length === 0) return undefined;

    // Get author last names
    const authorLastNames = new Set(
      authors.map(a => a.toLowerCase().split(' ').pop() || '').filter(n => n.length > 2)
    );

    let selfCitations = 0;

    for (const ref of refs) {
      if (!ref.authors) continue;
      const refAuthorLastNames = ref.authors.map(
        a => a.toLowerCase().split(' ').pop() || ''
      );

      // Check if any author overlaps
      if (refAuthorLastNames.some(n => authorLastNames.has(n))) {
        selfCitations++;
      }
    }

    return selfCitations / refs.length;
  } catch (error) {
    // Log at debug level for troubleshooting
    console.debug(`[hep-mcp] calculateSelfCitationRatio (recid=${recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Check for "Comment on" papers
 */
async function checkForComments(recid: string): Promise<boolean> {
  try {
    const query = `refersto:recid:${recid} and t:comment`;
    const result = await api.search(query, { size: 1 });
    return result.papers.length > 0;
  } catch (error) {
    // Log at debug level for troubleshooting
    console.debug(`[hep-mcp] checkForComments (recid=${recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Detect red flags based on paper metrics
 */
function detectRedFlags(
  paperType: PaperType,
  authorCount: number,
  citationCount: number,
  selfCitationRate: number | undefined,
  hasComments: boolean,
  paperAgeYears: number,
  abstract: string
): RedFlag[] {
  const redFlags: RedFlag[] = [];
  const config = getConfig().criticalResearch;
  const selfCiteWarning = config?.selfCitationWarningThreshold ?? 0.4;
  const selfCiteConcern = config?.selfCitationConcernThreshold ?? 0.6;
  const lowCiteAge = config?.lowCitationAgeThreshold ?? 5;
  const lowCiteCount = config?.lowCitationCountThreshold ?? 5;

  // High self-citation rate
  // Threshold: 40% (not 30%) because in specialized HEP subfields,
  // self-citation rates of 20-35% are common and acceptable.
  // Only flag truly anomalous cases.
  if (selfCitationRate !== undefined && selfCitationRate > selfCiteWarning) {
    redFlags.push({
      type: 'high_self_citation',
      description: `High self-citation rate: ${(selfCitationRate * 100).toFixed(1)}%`,
      severity: selfCitationRate > selfCiteConcern ? 'concern' : 'warning',
      details: `More than ${(selfCiteWarning * 100).toFixed(0)}% of references are to papers by the same author group. In HEP, 20-35% is typical.`,
    });
  }

  // Comment exists
  if (hasComments) {
    redFlags.push({
      type: 'comment_exists',
      description: 'Paper has published "Comment on" responses',
      severity: 'concern',
      details: 'The existence of comments may indicate controversy or errors',
    });
  }

  // Single author for experimental paper
  if (authorCount === 1 && paperType === 'experimental') {
    redFlags.push({
      type: 'single_author',
      description: 'Single author for experimental paper',
      severity: 'warning',
      details: 'Experimental papers typically have multiple authors for cross-checking',
    });
  }

  // Low citations for old paper
  if (paperAgeYears > lowCiteAge && citationCount < lowCiteCount) {
    redFlags.push({
      type: 'low_citations_old_paper',
      description: `Paper is ${paperAgeYears} years old with only ${citationCount} citations`,
      severity: 'warning',
      details: 'Low citation count for an older paper may indicate limited impact or issues',
    });
  }

  // Check for excessive claims in abstract
  const claimWords = ['first', 'discover', 'breakthrough', 'revolutionary', 'prove'];
  const claimCount = claimWords.filter(w => abstract.toLowerCase().includes(w)).length;
  if (claimCount >= 3) {
    redFlags.push({
      type: 'excessive_claims',
      description: 'Abstract contains multiple strong claim keywords',
      severity: 'warning',
      details: 'Multiple words like "first", "discover", "breakthrough" may indicate overselling',
    });
  }

  // Theoretical paper without experimental connection
  if (paperType === 'theoretical') {
    const experimentalWords = ['data', 'measurement', 'experiment', 'test', 'observable'];
    const hasExperimentalConnection = experimentalWords.some(w =>
      abstract.toLowerCase().includes(w)
    );
    if (!hasExperimentalConnection) {
      redFlags.push({
        type: 'no_experimental_basis',
        description: 'Theoretical paper without clear experimental connection',
        severity: 'warning',
        details: 'No mention of experimental tests or observables in abstract',
      });
    }
  }

  return redFlags;
}

/**
 * Calculate reliability score based on metrics and red flags
 */
function calculateReliabilityScore(
  redFlags: RedFlag[],
  citationCount: number,
  paperAgeYears: number
): number {
  let score = 0.7; // Base score

  // Penalty for red flags
  for (const flag of redFlags) {
    if (flag.severity === 'concern') {
      score -= 0.15;
    } else {
      score -= 0.08;
    }
  }

  // Boost for well-cited papers (normalized by age)
  const citationsPerYear = paperAgeYears > 0 ? citationCount / paperAgeYears : citationCount;
  if (citationsPerYear > 20) {
    score += 0.1;
  } else if (citationsPerYear > 10) {
    score += 0.05;
  }

  return Math.max(0, Math.min(1, score));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate critical questions and detect red flags for a paper
 */
export async function generateCriticalQuestions(
  params: CriticalQuestionsParams
): Promise<CriticalQuestionsResult> {
  const {
    recid,
    check_comments = true,
    check_self_citations = true,
  } = params;

  // Validate recid
  const recidError = validateRecid(recid);
  if (recidError) {
    return {
      paper_recid: recid || '',
      paper_title: '',
      success: false,
      error: recidError,
      paper_type: 'theoretical',  // Default type for error case
      questions: {
        methodology: [],
        assumptions: [],
        alternatives: [],
        reproducibility: [],
        implications: [],
      },
      red_flags: [],
      metrics: {
        citation_count: 0,
        self_citation_rate: 0,
        author_count: 0,
        has_comments: false,
        paper_age_years: 0,
      },
      reliability_score: 0,
    };
  }

  try {
    // Get paper metadata
    const paper = await api.getPaper(recid);

    const currentYear = new Date().getFullYear();
    const paperYear = paper.year || currentYear;
    const paperAgeYears = currentYear - paperYear;

    // Classify paper type
    const paperType = classifyPaperType(paper.title, paper.abstract || '');

    // Get metrics
    const authorCount = paper.author_count ?? paper.authors?.length ?? 0;
    const citationCount = paper.citation_count || 0;

    let selfCitationRate: number | undefined;
    if (check_self_citations) {
      selfCitationRate = await calculateSelfCitationRate(recid, paper.authors || []);
    }

    let hasComments = false;
    if (check_comments) {
      hasComments = await checkForComments(recid);
    }

    // Detect red flags
    const redFlags = detectRedFlags(
      paperType,
      authorCount,
      citationCount,
      selfCitationRate,
      hasComments,
      paperAgeYears,
      paper.abstract || ''
    );

    // Get questions for paper type
    const questions = QUESTION_TEMPLATES[paperType];

    // Calculate reliability score
    const reliabilityScore = calculateReliabilityScore(
      redFlags,
      citationCount,
      paperAgeYears
    );

    return {
      paper_recid: recid,
      paper_title: paper.title,
      paper_year: paper.year,
      paper_type: paperType,
      success: true,
      questions,
      red_flags: redFlags,
      reliability_score: reliabilityScore,
      metrics: {
        author_count: authorCount,
        citation_count: citationCount,
        self_citation_rate: selfCitationRate,
        has_comments: hasComments,
        paper_age_years: paperAgeYears,
      },
    };

  } catch (error) {
    return {
      paper_recid: recid,
      paper_title: 'Unknown',
      paper_type: 'phenomenological',
      success: false,
      error: error instanceof Error ? error.message : String(error),
      questions: {
        methodology: [],
        assumptions: [],
        alternatives: [],
        reproducibility: [],
        implications: [],
      },
      red_flags: [],
      reliability_score: 0,
      metrics: {
        author_count: 0,
        citation_count: 0,
        has_comments: false,
        paper_age_years: 0,
      },
    };
  }
}
