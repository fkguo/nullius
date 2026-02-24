/**
 * Algorithm Configuration
 * All tunable parameters for paper importance scoring
 * Can be customized via environment variables or config file
 */

// ─────────────────────────────────────────────────────────────────────────────
// Scoring Weights
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoringWeights {
  citation: number;      // Weight for citation score
  age: number;           // Weight for age score
  influence: number;     // Weight for influence score
  quality: number;       // Weight for quality score (reserved)
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  citation: 0.40,
  age: 0.25,
  influence: 0.20,
  quality: 0.15,
};

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

export interface Thresholds {
  // Citation thresholds
  highInfluenceCitationsPerYear: number;  // Citations/year for high influence

  // Age thresholds
  seminalMinAge: number;                  // Min age for seminal papers
  seminalMinCitations: number;            // Min citations for seminal papers
  emergingMinAge: number;                 // Min age for emerging detection
  emergingMaxAge: number;                 // Max age for emerging detection

  // Momentum thresholds
  emergingMomentumThreshold: number;      // Min momentum score for emerging
  emergingAccelerationThreshold: number;  // Min acceleration for emerging
  recentYearsWindow: number;              // Years to consider as "recent" (for emerging)
  recentMonthsWindow: number;             // Months to consider as "hot" (for rapid growth)

  // Review detection
  reviewScoreThreshold: number;           // Min score to classify as review
  reviewPenalty: number;                  // Score penalty for review papers

  // Crossover detection
  crossoverRecentYears: number;           // Years to consider as "recent" for crossover
  crossoverEmergingThreshold: number;     // Min trend ratio for emerging crossover
  crossoverMinRecentPapers: number;       // Min recent papers for valid crossover
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  highInfluenceCitationsPerYear: 50,

  seminalMinAge: 10,
  seminalMinCitations: 200,
  emergingMinAge: 3,
  emergingMaxAge: 15,

  emergingMomentumThreshold: 0.4,
  emergingAccelerationThreshold: 1.5,
  recentYearsWindow: 2,
  recentMonthsWindow: 6,            // 6 months for "hot" detection

  reviewScoreThreshold: 0.4,
  reviewPenalty: 0.3,

  crossoverRecentYears: 3,
  crossoverEmergingThreshold: 1.5,
  crossoverMinRecentPapers: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Review Detection Keywords
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewDetectionConfig {
  titleKeywords: string[];
  reviewJournals: string[];
  titleWeight: number;
  journalWeight: number;
  citationPatternWeight: number;
}

export const DEFAULT_REVIEW_DETECTION: ReviewDetectionConfig = {
  titleKeywords: [
    'review',
    // 'survey' removed: some "survey" papers are systematic studies, not reviews
    'overview',
    'introduction to',
    'status of',
    'progress in',
    'advances in',
    'recent developments',
    'state of the art',
    'comprehensive',
  ],
  reviewJournals: [
    'Physics Reports',
    'Phys.Rept.',
    'Phys. Rept.',
    'Reviews of Modern Physics',
    'Rev.Mod.Phys.',
    'Rev. Mod. Phys.',
    'Annual Review',
    'Ann.Rev.',
    'Progress in Particle and Nuclear Physics',
    'Prog.Part.Nucl.Phys.',
    'Prog. Part. Nucl. Phys.',
    'Living Reviews',
    'Liv.Rev.',
    'Reports on Progress in Physics',
    'Rept.Prog.Phys.',
  ],
  titleWeight: 0.4,
  journalWeight: 0.5,
  citationPatternWeight: 0.1,
};

// ─────────────────────────────────────────────────────────────────────────────
// NPMI Distance Matrix Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface NPMIConfig {
  matrixTTL: number;           // Cache TTL in ms (default: 30 days)
  minPapersForCategory: number; // Min papers to include category
  queryBatchSize: number;       // Batch size for API queries
  queryDelayMs: number;         // Delay between batches
}

export const DEFAULT_NPMI_CONFIG: NPMIConfig = {
  matrixTTL: 30 * 24 * 60 * 60 * 1000,  // 30 days
  minPapersForCategory: 100,
  queryBatchSize: 5,
  queryDelayMs: 500,
};

// ─────────────────────────────────────────────────────────────────────────────
// Rao-Stirling Index Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface RaoStirlingConfig {
  bridgeThreshold: number;        // Score threshold for "bridge" papers
  frontierThreshold: number;      // Score threshold for "frontier" papers
  primaryCategoryWeight: number;  // Weight for primary category
}

export const DEFAULT_RAO_STIRLING_CONFIG: RaoStirlingConfig = {
  bridgeThreshold: 0.3,
  frontierThreshold: 0.6,
  primaryCategoryWeight: 0.5,
};

// ─────────────────────────────────────────────────────────────────────────────
// Crossover Detection Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface CrossoverDetectionConfig {
  distanceThresholdCore: number;      // Below this = related/core (ignore)
  distanceThresholdCrossover: number; // Above this = true crossover
  accelerationThreshold: number;      // Min growth for ambiguous pairs
}

export const DEFAULT_CROSSOVER_DETECTION_CONFIG: CrossoverDetectionConfig = {
  distanceThresholdCore: 0.4,
  distanceThresholdCrossover: 0.6,
  accelerationThreshold: 0.1,  // 10% growth
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9: Critical Deep Research Configuration
// ─────────────────────────────────────────────────────────────────────────────

// ─── Physical Unit Conversions (HEP-specific) ───

/**
 * Unit conversion factors for HEP measurements
 *
 * **Important Notes**:
 * 1. **Natural Units** (ℏ = c = 1): Most HEP theory papers use natural units,
 *    where energy, mass, and momentum have the same dimension (GeV).
 *
 * 2. **Experimental Units**: Some experimental papers retain factors of c:
 *    - Mass: GeV/c² (divide by c²)
 *    - Momentum: GeV/c (divide by c)
 *
 * 3. **Conversion Strategy**:
 *    - All values are converted to natural units (GeV) for comparison
 *    - The conversion factors below are relative to the base unit (set to 1)
 *
 * **Physical Constants** (for reference):
 * - ℏc ≈ 197.3 MeV·fm (natural units conversion)
 * - c ≈ 299792458 m/s (SI)
 *
 * **Example**:
 * ```typescript
 * // Convert 80.379 GeV to MeV:
 * const inMeV = 80.379 * (UNIT_CONVERSIONS.energy.GeV / UNIT_CONVERSIONS.energy.MeV);
 * // → 80379 MeV
 * ```
 */
export const UNIT_CONVERSIONS = {
  /** Energy/Mass/Momentum (Natural Units: all have same dimension) */
  energy: {
    'eV': 1,
    'keV': 1e3,
    'MeV': 1e6,
    'GeV': 1e9,        // Base unit for HEP
    'TeV': 1e12,
  },

  /**
   * Mass units (experimental notation with c²)
   * In natural units: 1 GeV/c² = 1 GeV
   * The conversions below assume c = 1
   */
  mass: {
    'eV/c²': 1,
    'eV/c^2': 1,       // Alternative notation
    'keV/c²': 1e3,
    'keV/c^2': 1e3,
    'MeV/c²': 1e6,
    'MeV/c^2': 1e6,
    'GeV/c²': 1e9,     // Common in experimental papers
    'GeV/c^2': 1e9,
    'TeV/c²': 1e12,
    'TeV/c^2': 1e12,
  },

  /**
   * Momentum units (experimental notation with c)
   * In natural units: 1 GeV/c = 1 GeV
   */
  momentum: {
    'eV/c': 1,
    'keV/c': 1e3,
    'MeV/c': 1e6,
    'GeV/c': 1e9,      // Common in experimental papers
    'TeV/c': 1e12,
  },

  /** Cross Section (area) units - standard in HEP */
  cross_section: {
    'barn': 1,         // 1 barn = 10^-24 cm² = 100 fm²
    'b': 1,            // Short notation
    'mb': 1e-3,        // millibarn
    'μb': 1e-6,        // microbarn
    'ub': 1e-6,        // ASCII alternative for μb
    'nb': 1e-9,        // nanobarn
    'pb': 1e-12,       // picobarn (common at LHC)
    'fb': 1e-15,       // femtobarn
    'ab': 1e-18,       // attobarn
  },

  /**
   * Length units (relevant for nuclear physics)
   * In natural units: [length] = [energy]^-1
   * Conversion: 1 fm = 1 / (ℏc) ≈ 1 / (197.3 MeV) ≈ 5.07 GeV^-1
   */
  length: {
    'm': 1,
    'cm': 1e-2,
    'mm': 1e-3,
    'μm': 1e-6,
    'um': 1e-6,        // ASCII alternative
    'nm': 1e-9,
    'pm': 1e-12,       // picometer
    'fm': 1e-15,       // femtometer (fermi) - common in nuclear physics
  },

  /** Luminosity units (integrated luminosity for collider experiments) */
  luminosity: {
    'cm^-2': 1,
    '/cm²': 1,
    '/cm^2': 1,
    '/b': 1,
    '/barn': 1,
    '/mb': 1e3,
    '/μb': 1e6,
    '/ub': 1e6,
    '/nb': 1e9,
    '/pb': 1e12,       // inverse picobarn
    '/fb': 1e15,       // inverse femtobarn (common at LHC)
    '/ab': 1e18,       // inverse attobarn
  },

  /** Time units (for lifetime measurements) */
  time: {
    's': 1,            // second
    'ms': 1e-3,
    'μs': 1e-6,
    'us': 1e-6,        // ASCII alternative
    'ns': 1e-9,
    'ps': 1e-12,
    'fs': 1e-15,
  },
} as const;

/**
 * Physical constants in natural units (ℏ = c = 1)
 */
export const PHYSICAL_CONSTANTS = {
  /** ℏc in MeV·fm (for energy-length conversion) */
  HBAR_C_MEV_FM: 197.3269804,  // MeV·fm

  /** ℏc in GeV·fm */
  HBAR_C_GEV_FM: 0.1973269804, // GeV·fm

  /** Speed of light (for reference, c = 1 in natural units) */
  SPEED_OF_LIGHT_M_S: 299792458, // m/s

  /** Fine structure constant α ≈ 1/137 */
  ALPHA: 1 / 137.035999084,
} as const;

function normalizeUnitToken(unit: string): string {
  return unit
    .trim()
    .replace(/\s+/g, '')
    .replace(/\{(-?\d+)\}/g, '$1')
    .replace(/²/g, '^2')
    .toLowerCase();
}

function pickPreferredUnitKey(candidates: string[]): string {
  const caret = candidates.find(u => u.includes('^'));
  if (caret) return caret;
  return candidates[0]!;
}

/**
 * Detect the category of a physical unit
 *
 * @param unit - Unit string (e.g., "GeV", "GeV/c²", "pb")
 * @returns Category name or null if unknown
 */
export function detectUnitCategory(unit: string): keyof typeof UNIT_CONVERSIONS | null {
  const canonical = canonicalizeUnit(unit);
  if (!canonical) return null;

  for (const [category, conversions] of Object.entries(UNIT_CONVERSIONS)) {
    if (Object.prototype.hasOwnProperty.call(conversions, canonical)) {
      return category as keyof typeof UNIT_CONVERSIONS;
    }
  }

  return null;
}

/**
 * Canonicalize unit string to the exact key used in UNIT_CONVERSIONS (case/whitespace/²-insensitive).
 *
 * @returns Canonical UNIT_CONVERSIONS key, or null if unknown
 */
export function canonicalizeUnit(unit: string): string | null {
  const normalized = normalizeUnitToken(unit);
  if (!normalized) return null;

  const candidates: string[] = [];
  for (const conversions of Object.values(UNIT_CONVERSIONS) as Array<Record<string, number>>) {
    for (const knownUnit of Object.keys(conversions)) {
      if (normalizeUnitToken(knownUnit) === normalized) {
        candidates.push(knownUnit);
      }
    }
  }

  if (candidates.length > 0) return pickPreferredUnitKey(candidates);

  // e.g. fb^{-1} / fb^-1 / 1/fb → /fb
  const inv = normalized.match(/^([a-zμ]+)\^-1$/);
  if (inv?.[1]) return canonicalizeUnit(`/${inv[1]}`);

  const inv2 = normalized.match(/^1\/([a-zμ]+)$/);
  if (inv2?.[1]) return canonicalizeUnit(`/${inv2[1]}`);

  return null;
}

/**
 * Check if two units belong to the same category
 *
 * **Important**: In natural units, energy/mass/momentum are compatible:
 * - "GeV" and "GeV/c²" are both energy-like and can be compared
 * - "GeV" and "GeV/c" are both energy-like and can be compared
 *
 * @returns true if units can be converted between each other
 */
export function areUnitsCompatible(unit1: string, unit2: string): boolean {
  const cat1 = detectUnitCategory(unit1);
  const cat2 = detectUnitCategory(unit2);

  if (!cat1 || !cat2) return false;

  // In natural units, energy/mass/momentum are interchangeable
  const naturalUnitCategories = new Set(['energy', 'mass', 'momentum']);
  if (naturalUnitCategories.has(cat1) && naturalUnitCategories.has(cat2)) {
    return true;
  }

  return cat1 === cat2;
}

/**
 * Get conversion factor from one unit to another
 *
 * @param fromUnit - Source unit (e.g., "MeV")
 * @param toUnit - Target unit (e.g., "GeV")
 * @returns Conversion factor, or null if units incompatible
 *
 * @example
 * ```typescript
 * const factor = getConversionFactor("MeV", "GeV");
 * // → 1e-3 (1 MeV = 0.001 GeV)
 *
 * const massValue = 0.938; // GeV/c²
 * const inMeV = massValue * getConversionFactor("GeV/c²", "MeV/c²");
 * // → 938 MeV/c²
 * ```
 */
export function getConversionFactor(fromUnit: string, toUnit: string): number | null {
  const fromKey = canonicalizeUnit(fromUnit);
  const toKey = canonicalizeUnit(toUnit);

  if (!fromKey || !toKey) return null;
  if (!areUnitsCompatible(fromKey, toKey)) return null;

  const cat1 = detectUnitCategory(fromKey);
  const cat2 = detectUnitCategory(toKey);

  if (!cat1 || !cat2) return null;

  // Get conversion factors relative to base unit
  const conversions1 = UNIT_CONVERSIONS[cat1] as Record<string, number>;
  const conversions2 = UNIT_CONVERSIONS[cat2] as Record<string, number>;

  const factor1 = conversions1[fromKey];
  const factor2 = conversions2[toKey];

  if (factor1 === undefined || factor2 === undefined) {
    return null;
  }

  // Convert from unit1 to base, then from base to unit2
  return factor1 / factor2;
}

export interface CriticalResearchConfig {
  // ─── Conflict Detection ───
  /** > 5σ = hard conflict */
  hardConflictThreshold: number;
  /** 3-5σ = soft conflict (below this = apparent/statistical fluctuation) */
  softConflictThreshold: number;

  // ─── Self-Citation Detection ───
  /** Warning threshold for self-citation rate (40% - typical HEP is 20-35%) */
  selfCitationWarningThreshold: number;
  /** Concern threshold for self-citation rate (60% - anomalously high) */
  selfCitationConcernThreshold: number;

  // ─── Evidence Grading: Sigma Levels ───
  /** σ level for "discovery" classification (typically 5) */
  discoveryMinSigma: number;
  /** σ level for "evidence" classification (typically 3) */
  evidenceMinSigma: number;
  /** σ level for "hint" classification (typically 2) */
  hintMinSigma: number;

  // ─── Evidence Grading: Scoring Weights ───
  /** Base score for discovery-level evidence */
  evidenceScoreDiscovery: number;
  /** Base score for evidence-level evidence */
  evidenceScoreEvidence: number;
  /** Base score for hint-level evidence */
  evidenceScoreHint: number;
  /** Base score for indirect evidence */
  evidenceScoreIndirect: number;
  /** Base score for theoretical evidence */
  evidenceScoreTheoretical: number;
  /** Score boost per independent confirmation */
  evidenceBoostPerConfirmation: number;
  /** Maximum score boost from confirmations */
  evidenceMaxConfirmationBoost: number;
  /** Score penalty per conflict */
  evidencePenaltyPerConflict: number;
  /** Maximum score penalty from conflicts */
  evidenceMaxConflictPenalty: number;
  /** Score penalty for orphan results */
  evidenceOrphanPenalty: number;
  /** Maximum claims to extract per paper */
  evidenceMaxClaims: number;
  /** Author overlap ratio threshold for independent confirmation */
  evidenceAuthorOverlapThreshold: number;

  // ─── Assumption Tracking ───
  /** Extra weight multiplier for inherited assumptions (1.2 = 20% higher weight) */
  inheritedAssumptionWeight: number;
  /** Fragility score above this = high risk (0.7) */
  fragilityHighThreshold: number;
  /** Fragility score above this = medium risk (0.4) */
  fragilityMediumThreshold: number;
  /** Max references to fetch per depth level */
  maxRefsPerLevel: number;
  /** Max assumptions to extract per reference */
  maxAssumptionsPerRef: number;
  /** Fragility weight for refuted assumptions */
  fragilityWeightRefuted: number;
  /** Fragility weight for challenged assumptions */
  fragilityWeightChallenged: number;
  /** Fragility weight for untested assumptions */
  fragilityWeightUntested: number;
  /** Fragility weight for tested assumptions */
  fragilityWeightTested: number;
  /** Extra fragility penalty for implicit assumptions */
  fragilityImplicitPenalty: number;

  // ─── Critical Questions: Red Flags ───
  /** Minimum paper age (years) to flag low citations */
  lowCitationAgeThreshold: number;
  /** Minimum citation count expected for old papers */
  lowCitationCountThreshold: number;
  /** Threshold for excessive claim keywords in abstract */
  excessiveClaimsThreshold: number;

  // ─── Critical Questions: Reliability Scoring ───
  /** Base reliability score (before adjustments) */
  reliabilityBaseScore: number;
  /** Score penalty for "concern" severity red flags */
  reliabilityPenaltyConcern: number;
  /** Score penalty for "warning" severity red flags */
  reliabilityPenaltyWarning: number;
  /** Citations per year threshold for high boost (20/year) */
  reliabilityCitationsHighThreshold: number;
  /** Citations per year threshold for medium boost (10/year) */
  reliabilityCitationsMediumThreshold: number;
  /** Score boost for high citation rate */
  reliabilityBoostHighCitations: number;
  /** Score boost for medium citation rate */
  reliabilityBoostMediumCitations: number;

  // ─── Critical Analysis: Integration ───
  /** Weight for evidence grading in integrated reliability score */
  integrationWeightEvidence: number;
  /** Weight for critical questions in integrated reliability score */
  integrationWeightQuestions: number;
  /** Weight for assumptions in integrated reliability score */
  integrationWeightAssumptions: number;
  /** Base score for integrated reliability calculation */
  integrationBaseScore: number;
  /** Risk score threshold for high risk classification */
  riskScoreHighThreshold: number;
  /** Risk score threshold for medium risk classification */
  riskScoreMediumThreshold: number;

  // ─── Review Classification ───
  /** Author count threshold for consensus classification bonus */
  reviewConsensusAuthorThreshold: number;
  /** Keyword match threshold for high-confidence consensus */
  reviewConsensusScoreThreshold: number;
  /** Keyword match threshold for high-confidence critical review */
  reviewCriticalScoreHighThreshold: number;
  /** Keyword match threshold for medium-confidence critical review */
  reviewCriticalScoreMediumThreshold: number;
  /** Keyword match threshold for high-confidence catalog */
  reviewCatalogScoreHighThreshold: number;
  /** Keyword match threshold for medium-confidence catalog */
  reviewCatalogScoreMediumThreshold: number;
  /** Author count threshold for "community" diversity level */
  reviewAuthorDiversityCommunityThreshold: number;
  /** Author count threshold for "multi_group" diversity level */
  reviewAuthorDiversityMultiGroupThreshold: number;
  /** Default years threshold for "current" reviews */
  reviewCurrentYearsThreshold: number;
  /** Multiplier for "dated" threshold (current_threshold * this = dated) */
  reviewDatedYearsMultiplier: number;

  // ─── Review Authority Scoring ───
  /** Base authority score before adjustments */
  authorityBaseScore: number;
  /** Authority bonus for consensus type */
  authorityBonusConsensus: number;
  /** Authority bonus for critical type */
  authorityBonusCritical: number;
  /** Authority bonus for authoritative source */
  authorityBonusAuthoritative: number;
  /** Citation threshold for highest authority boost (>1000) */
  authorityCitationsVeryHighThreshold: number;
  /** Citation threshold for high authority boost (>500) */
  authorityCitationsHighThreshold: number;
  /** Citation threshold for medium authority boost (>100) */
  authorityCitationsMediumThreshold: number;
  /** Authority boost for very high citations */
  authorityBoostVeryHighCitations: number;
  /** Authority boost for high citations */
  authorityBoostHighCitations: number;
  /** Authority boost for medium citations */
  authorityBoostMediumCitations: number;
  /** Authority bonus for large author count in consensus reviews */
  authorityBonusLargeAuthorCount: number;
  /** Penalty per detected bias */
  authorityPenaltyPerBias: number;
  /** Age penalty for old non-consensus reviews (>10 years) */
  authorityPenaltyOldNonConsensus: number;
  /** Age threshold for old review penalty (years) */
  authorityOldReviewThreshold: number;

  // ─── Analysis Output Limits ───
  /** Max concerns to include in integrated assessment output */
  maxConcerns: number;
  /** Max strengths to include in integrated assessment output */
  maxStrengths: number;
  /** Max recommendations to include in output */
  maxRecommendations: number;
  /** Max critical dependencies to show in assumption analysis */
  maxCriticalDependencies: number;
}

export const DEFAULT_CRITICAL_RESEARCH_CONFIG: CriticalResearchConfig = {
  // ─── Conflict Detection ───
  hardConflictThreshold: 5.0,
  softConflictThreshold: 3.0,

  // ─── Self-Citation Detection ───
  selfCitationWarningThreshold: 0.4,   // 40%
  selfCitationConcernThreshold: 0.6,   // 60%

  // ─── Evidence Grading: Sigma Levels ───
  discoveryMinSigma: 5.0,
  evidenceMinSigma: 3.0,
  hintMinSigma: 2.0,

  // ─── Evidence Grading: Scoring Weights ───
  evidenceScoreDiscovery: 0.9,
  evidenceScoreEvidence: 0.7,
  evidenceScoreHint: 0.4,
  evidenceScoreIndirect: 0.3,
  evidenceScoreTheoretical: 0.5,
  evidenceBoostPerConfirmation: 0.1,
  evidenceMaxConfirmationBoost: 0.2,
  evidencePenaltyPerConflict: 0.2,
  evidenceMaxConflictPenalty: 0.4,
  evidenceOrphanPenalty: 0.1,
  evidenceMaxClaims: 5,
  evidenceAuthorOverlapThreshold: 0.5,

  // ─── Assumption Tracking ───
  inheritedAssumptionWeight: 1.2,
  fragilityHighThreshold: 0.7,
  fragilityMediumThreshold: 0.4,
  maxRefsPerLevel: 5,
  maxAssumptionsPerRef: 2,
  fragilityWeightRefuted: 1.0,
  fragilityWeightChallenged: 0.7,
  fragilityWeightUntested: 0.4,
  fragilityWeightTested: 0.1,
  fragilityImplicitPenalty: 0.1,

  // ─── Critical Questions: Red Flags ───
  lowCitationAgeThreshold: 5,
  lowCitationCountThreshold: 5,
  excessiveClaimsThreshold: 3,

  // ─── Critical Questions: Reliability Scoring ───
  reliabilityBaseScore: 0.7,
  reliabilityPenaltyConcern: 0.15,
  reliabilityPenaltyWarning: 0.08,
  reliabilityCitationsHighThreshold: 20,
  reliabilityCitationsMediumThreshold: 10,
  reliabilityBoostHighCitations: 0.1,
  reliabilityBoostMediumCitations: 0.05,

  // ─── Critical Analysis: Integration ───
  integrationWeightEvidence: 0.4,
  integrationWeightQuestions: 0.3,
  integrationWeightAssumptions: 0.3,
  integrationBaseScore: 0.5,
  riskScoreHighThreshold: 5,
  riskScoreMediumThreshold: 2,

  // ─── Review Classification ───
  reviewConsensusAuthorThreshold: 20,
  reviewConsensusScoreThreshold: 2,
  reviewCriticalScoreHighThreshold: 3,
  reviewCriticalScoreMediumThreshold: 1,
  reviewCatalogScoreHighThreshold: 2,
  reviewCatalogScoreMediumThreshold: 1,
  reviewAuthorDiversityCommunityThreshold: 20,
  reviewAuthorDiversityMultiGroupThreshold: 5,
  reviewCurrentYearsThreshold: 3,
  reviewDatedYearsMultiplier: 3,

  // ─── Review Authority Scoring ───
  authorityBaseScore: 0.5,
  authorityBonusConsensus: 0.3,
  authorityBonusCritical: 0.1,
  authorityBonusAuthoritative: 0.2,
  authorityCitationsVeryHighThreshold: 1000,
  authorityCitationsHighThreshold: 500,
  authorityCitationsMediumThreshold: 100,
  authorityBoostVeryHighCitations: 0.15,
  authorityBoostHighCitations: 0.1,
  authorityBoostMediumCitations: 0.05,
  authorityBonusLargeAuthorCount: 0.1,
  authorityPenaltyPerBias: 0.05,
  authorityPenaltyOldNonConsensus: 0.1,
  authorityOldReviewThreshold: 10,

  // ─── Analysis Output Limits ───
  maxConcerns: 5,
  maxStrengths: 5,
  maxRecommendations: 5,
  maxCriticalDependencies: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// Combined Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface AlgorithmConfig {
  weights: ScoringWeights;
  thresholds: Thresholds;
  reviewDetection: ReviewDetectionConfig;
  npmi?: NPMIConfig;
  raoStirling?: RaoStirlingConfig;
  crossoverDetection?: CrossoverDetectionConfig;
  criticalResearch?: CriticalResearchConfig;
}

export const DEFAULT_CONFIG: AlgorithmConfig = {
  weights: DEFAULT_SCORING_WEIGHTS,
  thresholds: DEFAULT_THRESHOLDS,
  reviewDetection: DEFAULT_REVIEW_DETECTION,
  npmi: DEFAULT_NPMI_CONFIG,
  raoStirling: DEFAULT_RAO_STIRLING_CONFIG,
  crossoverDetection: DEFAULT_CROSSOVER_DETECTION_CONFIG,
  criticalResearch: DEFAULT_CRITICAL_RESEARCH_CONFIG,
};

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Loading
// ─────────────────────────────────────────────────────────────────────────────

let currentConfig: AlgorithmConfig = { ...DEFAULT_CONFIG };

/**
 * Get current algorithm configuration
 */
export function getConfig(): AlgorithmConfig {
  return currentConfig;
}

/**
 * Update algorithm configuration (partial update supported)
 */
export function updateConfig(partial: Partial<AlgorithmConfig>): void {
  if (partial.weights) {
    currentConfig.weights = { ...currentConfig.weights, ...partial.weights };
  }
  if (partial.thresholds) {
    currentConfig.thresholds = { ...currentConfig.thresholds, ...partial.thresholds };
  }
  if (partial.reviewDetection) {
    currentConfig.reviewDetection = { ...currentConfig.reviewDetection, ...partial.reviewDetection };
  }
}

/**
 * Reset to default configuration
 */
export function resetConfig(): void {
  currentConfig = { ...DEFAULT_CONFIG };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Default batch size for parallel API requests */
export const DEFAULT_BATCH_SIZE = 5;

/** Parameter validation limits */
export const VALIDATION_LIMITS = {
  /** Maximum recid value (INSPIRE recids are typically < 3 million) */
  maxRecidValue: 10_000_000,
};

/**
 * Get current year dynamically to avoid stale values in long-running servers
 */
export function getCurrentYear(): number {
  return new Date().getFullYear();
}

/**
 * Validate INSPIRE recid format
 * @returns Error message if invalid, null if valid
 */
export function validateRecid(recid: string): string | null {
  if (!recid || typeof recid !== 'string') {
    return 'recid must be a non-empty string';
  }

  const trimmed = recid.trim();
  if (trimmed.length === 0) {
    return 'recid cannot be empty';
  }

  // INSPIRE recids are numeric
  if (!/^\d+$/.test(trimmed)) {
    return `Invalid recid format: ${recid} (must be numeric)`;
  }

  const numericValue = parseInt(trimmed, 10);
  if (numericValue > VALIDATION_LIMITS.maxRecidValue) {
    return `recid ${recid} exceeds maximum expected value`;
  }

  return null;
}

/**
 * Validate array of recids
 * @returns Error message if invalid, null if valid
 */
export function validateRecids(recids: string[]): string | null {
  if (!Array.isArray(recids)) {
    return 'recids must be an array';
  }

  if (recids.length === 0) {
    return 'recids array cannot be empty';
  }

  for (const recid of recids) {
    const error = validateRecid(recid);
    if (error) {
      return error;
    }
  }

  return null;
}

/**
 * Validate max_depth parameter
 * @returns Clamped value within valid range
 */
export function validateMaxDepth(depth: number | undefined, defaultValue: number = 2): number {
  if (depth === undefined || depth === null) {
    return defaultValue;
  }

  if (typeof depth !== 'number' || isNaN(depth)) {
    return defaultValue;
  }

  const n = Math.trunc(depth);
  return Number.isFinite(n) ? Math.max(0, n) : defaultValue;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stance Detection Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface StanceDetectionConfig {
  confirmingPatterns: string[];
  contradictingPatterns: string[];
  negationWords: string[];
  contextWindowSize: number;
  concurrentLimit: number;
}

export const DEFAULT_STANCE_DETECTION: StanceDetectionConfig = {
  confirmingPatterns: [
    'consistent with', 'in agreement', 'confirms', 'supports',
    'corroborates', 'validates', 'compatible with', 'in line with',
    'in accord with', 'agrees with', 'verified', 'reproduced',
  ],
  contradictingPatterns: [
    'in tension with', 'contradicts', 'disagrees', 'rules out',
    'inconsistent with', 'conflicts with', 'challenges', 'refutes',
    'at odds with', 'incompatible with', 'excludes', 'disfavors',
    'contrary to', 'does not support', 'fails to confirm',
  ],
  negationWords: ['not', 'no', 'never', 'neither', 'cannot', "doesn't", "don't", "isn't", "aren't"],
  contextWindowSize: 100,
  concurrentLimit: 5,
};

// ─────────────────────────────────────────────────────────────────────────────
// Comprehensive Survey Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface ComprehensiveSurveyConfig {
  /** Default minimum papers to collect */
  defaultMinPapers: number;
  /** Default maximum papers to collect */
  defaultMaxPapers: number;
  /** Absolute maximum papers (hard limit) */
  absoluteMaxPapers: number;
  /** Batch size for parallel citation chain requests */
  citationChainBatchSize: number;
  /** Max seed papers for citation chain strategy */
  maxSeedPapers: number;
  /** Max references per seed paper */
  maxRefsPerSeed: number;
  /** Max citations per seed paper */
  maxCitationsPerSeed: number;
  /** Max keyword variants to search */
  maxKeywordVariants: number;
  /** Max key authors for network expansion */
  maxKeyAuthors: number;
  /** Papers per author search */
  papersPerAuthor: number;
  /** Recent papers search window (years) */
  recentPapersYears: number;
  /** Max recent papers to fetch */
  maxRecentPapers: number;
}

export const DEFAULT_COMPREHENSIVE_SURVEY_CONFIG: ComprehensiveSurveyConfig = {
  defaultMinPapers: 50,
  defaultMaxPapers: 100,
  absoluteMaxPapers: 500,
  citationChainBatchSize: 5,
  maxSeedPapers: 10,
  maxRefsPerSeed: 20,
  maxCitationsPerSeed: 20,
  maxKeywordVariants: 5,
  maxKeyAuthors: 5,
  papersPerAuthor: 20,
  recentPapersYears: 3,
  maxRecentPapers: 50,
};

// ─────────────────────────────────────────────────────────────────────────────
// LaTeX Parser Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface LaTeXParserConfig {
  /** Truncated parse line limit (fallback strategy) */
  truncatedParseLines: number;
  /** Parser timeout in milliseconds */
  parserTimeoutMs: number;
  /** Anchor size for location mapping */
  anchorSize: number;
  /** Maximum equations to extract */
  maxEquations: number;
  /** Maximum theorems to extract */
  maxTheorems: number;
  /** Maximum figures to extract */
  maxFigures: number;
  /** Maximum tables to extract */
  maxTables: number;
}

export const DEFAULT_LATEX_PARSER_CONFIG: LaTeXParserConfig = {
  truncatedParseLines: 1000,
  parserTimeoutMs: 5000,
  anchorSize: 32,
  maxEquations: 50,
  maxTheorems: 30,
  maxFigures: 50,
  maxTables: 30,
};
