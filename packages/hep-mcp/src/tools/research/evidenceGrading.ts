/**
 * Evidence Grading Module
 * Evaluates the reliability of claims in scientific papers
 *
 * Features:
 * - Claim extraction from abstract/conclusions
 * - Independent confirmation detection
 * - "Orphan result" identification
 * - Conflict detection
 */

import * as api from '../../api/client.js';
import { validateRecid, DEFAULT_STANCE_DETECTION } from './config.js';
import { cleanMathML } from './preprocess/utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EvidenceLevel = 'discovery' | 'evidence' | 'hint' | 'indirect' | 'theoretical';
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'controversial';
export type CitationStance = 'confirming' | 'contradicting' | 'neutral';

export interface EvidenceGrade {
  /** The claim being evaluated */
  claim: string;
  /** Source context: sentences before and after the claim */
  source_context?: {
    before: string;
    after: string;
  };
  /** Evidence level based on statistical significance */
  evidence_level: EvidenceLevel;
  /** Statistical significance if mentioned (e.g., 5.0 for 5σ) */
  sigma_level?: number;
  /** Number of independent confirmations found */
  independent_confirmations: number;
  /** Whether this is an "orphan" result (only one group reports it) */
  is_orphan: boolean;
  /** Number of conflicting results found */
  conflicting_count: number;
  /** Overall confidence assessment */
  confidence: ConfidenceLevel;
  /** Confirming papers */
  confirming_papers?: Array<{ recid: string; title: string; }>;
  /** Conflicting papers */
  conflicting_papers?: Array<{ recid: string; title: string; }>;
}

export interface EvidenceGradingParams {
  /** INSPIRE recid of the paper to analyze */
  recid: string;
  /** Whether to search for independent confirmations (default: true) */
  search_confirmations?: boolean;
  /** Maximum search results for confirmation search (default: 20) */
  max_search_results?: number;
}

export interface EvidenceGradingResult {
  paper_recid: string;
  paper_title: string;
  paper_year?: number;
  /** Paper abstract (for reuse, avoid duplicate API calls) */
  paper_abstract?: string;
  success: boolean;
  error?: string;
  /** Main claims extracted from the paper */
  main_claims: EvidenceGrade[];
  /** Overall reliability score (0-1) */
  overall_reliability: number;
  /** Warnings about the paper's claims */
  warnings: string[];
  /** Summary statistics */
  summary: {
    total_claims: number;
    well_established: number;
    controversial: number;
    orphan: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Keywords indicating claims/findings
const CLAIM_KEYWORDS = [
  'discover', 'discovered', 'discovery',
  'observe', 'observed', 'observation',
  'measure', 'measured', 'measurement',
  'find', 'found', 'finding',
  'detect', 'detected', 'detection',
  'evidence', 'show', 'shown', 'demonstrate',
  'confirm', 'confirmed', 'confirmation',
  'first', 'new', 'novel',
  // Additional keywords added for better coverage
  'report', 'reported',
  'establish', 'established',
  'identify', 'identified', 'identification',
  'constrain', 'constrained', 'constraint',
  'determine', 'determined', 'determination',
];

// Keywords indicating statistical significance
const SIGMA_PATTERNS = [
  /(\d+\.?\d*)\s*[σ\\sigma]/i,       // 5σ, 5.0σ
  /(\d+\.?\d*)\s*sigma/i,             // 5 sigma
  /significance\s+of\s+(\d+\.?\d*)/i, // significance of 5
  /(\d+\.?\d*)\s*standard\s+deviation/i,
];

// Keywords suggesting theoretical/indirect evidence
const THEORETICAL_KEYWORDS = [
  'predict', 'prediction', 'theoretical', 'model',
  'suggest', 'imply', 'indicate', 'consistent with',
  'expect', 'expected', 'calculate', 'computation',
];

// Keywords suggesting hints rather than discoveries
const HINT_KEYWORDS = [
  'hint', 'possible', 'potential', 'tentative',
  'preliminary', 'indication', 'excess', 'anomaly',
];

// Stance detection patterns (from config)
const STANCE_PATTERNS = {
  confirming: DEFAULT_STANCE_DETECTION.confirmingPatterns,
  contradicting: DEFAULT_STANCE_DETECTION.contradictingPatterns,
};

// Negation words (from config)
const NEGATION_WORDS = DEFAULT_STANCE_DETECTION.negationWords;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if there's a negation word before the pattern
 */
function hasNegationBefore(text: string, patternIndex: number): boolean {
  const prefixStart = Math.max(0, patternIndex - 15);
  const prefix = text.slice(prefixStart, patternIndex).toLowerCase();
  return NEGATION_WORDS.some(neg => prefix.includes(neg));
}

/**
 * Find context windows around keywords in text
 */
function findRelevantContextWindows(
  text: string,
  keywords: string[],
  windowSize: number = DEFAULT_STANCE_DETECTION.contextWindowSize
): string[] {
  const windows: string[] = [];
  const textLower = text.toLowerCase();

  for (const kw of keywords) {
    let idx = 0;
    while ((idx = textLower.indexOf(kw.toLowerCase(), idx)) !== -1) {
      const start = Math.max(0, idx - windowSize);
      const end = Math.min(text.length, idx + kw.length + windowSize);
      windows.push(textLower.slice(start, end));
      idx += kw.length;
    }
  }

  return windows;
}

/**
 * Stance analysis result with confidence
 */
export interface StanceResult {
  stance: CitationStance;
  confidence: 'high' | 'medium' | 'low';
  matched_pattern?: string;
  needs_llm_review?: boolean;
}

/**
 * Analyze citation stance using keyword + context window method
 * Returns stance with confidence level for optional LLM fallback
 */
export function analyzeCitationStance(
  abstract: string,
  claimKeywords: string[]
): StanceResult {
  if (!abstract || abstract.length === 0) {
    return { stance: 'neutral', confidence: 'low', needs_llm_review: true };
  }

  const abstractLower = abstract.toLowerCase();

  // Find context windows around claim keywords
  const contextWindows = findRelevantContextWindows(abstractLower, claimKeywords);

  // If no relevant context found, check entire abstract with lower confidence
  const textsToCheck = contextWindows.length > 0 ? contextWindows : [abstractLower];
  const baseConfidence = contextWindows.length > 0 ? 'high' : 'medium';

  for (const text of textsToCheck) {
    // Check contradicting patterns first (higher priority)
    for (const pattern of STANCE_PATTERNS.contradicting) {
      const idx = text.indexOf(pattern);
      if (idx !== -1) {
        // Negation flips contradicting to confirming
        if (hasNegationBefore(text, idx)) {
          return { stance: 'confirming', confidence: baseConfidence, matched_pattern: `NOT ${pattern}` };
        }
        return { stance: 'contradicting', confidence: baseConfidence, matched_pattern: pattern };
      }
    }

    // Check confirming patterns
    for (const pattern of STANCE_PATTERNS.confirming) {
      const idx = text.indexOf(pattern);
      if (idx !== -1) {
        // Negation flips confirming to contradicting
        if (hasNegationBefore(text, idx)) {
          return { stance: 'contradicting', confidence: baseConfidence, matched_pattern: `NOT ${pattern}` };
        }
        return { stance: 'confirming', confidence: baseConfidence, matched_pattern: pattern };
      }
    }
  }

  // No pattern matched - low confidence, suggest LLM review
  return { stance: 'neutral', confidence: 'low', needs_llm_review: true };
}

/** Claim with source context */
interface ClaimWithContext {
  text: string;
  context_before: string;
  context_after: string;
}

/**
 * Extract claims from text (abstract or conclusions) with surrounding context
 */
function extractClaims(text: string): ClaimWithContext[] {
  const claims: ClaimWithContext[] = [];

  // Clean MathML/HTML tags first
  const cleanedText = cleanMathML(text);

  // Split into sentences
  const sentences = cleanedText.split(/[.!?]+/).filter(s => s.trim().length > 20);

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    const sentenceLower = sentence.toLowerCase();

    // Check if sentence contains claim keywords
    const hasClaim = CLAIM_KEYWORDS.some(kw => sentenceLower.includes(kw));
    if (hasClaim) {
      claims.push({
        text: sentence.trim(),
        context_before: i > 0 ? sentences[i - 1].trim() : '',
        context_after: i < sentences.length - 1 ? sentences[i + 1].trim() : '',
      });
    }
  }

  return claims;
}

/**
 * Extract sigma level from text
 */
function extractSigmaLevel(text: string): number | undefined {
  const textLower = text.toLowerCase();

  for (const pattern of SIGMA_PATTERNS) {
    const match = textLower.match(pattern);
    if (match) {
      const sigma = parseFloat(match[1]);
      if (sigma > 0 && sigma < 100) {
        return sigma;
      }
    }
  }

  return undefined;
}

/**
 * Determine evidence level based on text content
 */
function determineEvidenceLevel(text: string, sigmaLevel?: number): EvidenceLevel {
  const textLower = text.toLowerCase();

  // Check sigma level first
  if (sigmaLevel !== undefined) {
    if (sigmaLevel >= 5) return 'discovery';
    if (sigmaLevel >= 3) return 'evidence';
    if (sigmaLevel >= 2) return 'hint';
  }

  // Check for theoretical keywords
  if (THEORETICAL_KEYWORDS.some(kw => textLower.includes(kw))) {
    return 'theoretical';
  }

  // Check for hint keywords
  if (HINT_KEYWORDS.some(kw => textLower.includes(kw))) {
    return 'hint';
  }

  // Check for discovery keywords with strong language
  if (textLower.includes('discover') || textLower.includes('first observation')) {
    return 'discovery';
  }

  // Default to evidence
  return 'evidence';
}

/**
 * Extract author identifier from full name for matching
 * Uses "FirstInitials LastName" format to reduce CJK name collisions
 * Example: "Feng-Kun Guo" -> "f k guo", "John Smith" -> "j smith"
 */
function extractAuthorIdentifier(fullName: string): string {
  const parts = fullName.trim().toLowerCase().split(/\s+/);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];

  const lastName = parts[parts.length - 1];
  // Extract initials from all first/middle names (handle hyphenated names)
  const initials = parts.slice(0, -1)
    .map(p => p.split('-').map(s => s.charAt(0)).join(' '))
    .join(' ');

  return `${initials} ${lastName}`;
}

/**
 * Extract key topic words from a claim for searching
 */
function extractTopicWords(claim: string): string[] {
  // Remove common words and extract meaningful terms
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
    'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
    'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'this', 'that', 'these', 'those', 'it', 'its', 'we', 'our', 'they', 'their',
    'which', 'where', 'when', 'what', 'who', 'how', 'than', 'then', 'can', 'also',
    'first', 'new', 'show', 'find', 'found', 'measure', 'observe', 'discover',
  ]);

  const words = claim
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  // Return top 5 most relevant words
  return words.slice(0, 5);
}

/**
 * Search for independent confirmations of a claim
 * Uses stance detection to classify papers as confirming/contradicting/neutral
 */
async function searchConfirmations(
  claim: string,
  originalRecid: string,
  originalAuthors: string[],
  maxResults: number
): Promise<{
  confirming: Array<{ recid: string; title: string; stance_confidence?: string }>;
  conflicting: Array<{ recid: string; title: string; stance_confidence?: string }>;
  truncated: boolean;
  warning?: string;
}> {
  const confirming: Array<{ recid: string; title: string; stance_confidence?: string; }> = [];
  const conflicting: Array<{ recid: string; title: string; stance_confidence?: string; }> = [];
  let truncated = false;
  let warning: string | undefined;

  try {
    // Extract topic words from claim for stance analysis
    const topicWords = extractTopicWords(claim);
    if (topicWords.length === 0) {
      return { confirming, conflicting, truncated, warning };
    }

    // Search for papers with similar topics
    const query = topicWords.join(' ');
    const searchResult = await api.searchAll(query, {
      sort: 'mostcited',
      size: Math.min(1000, Math.max(1, maxResults)),
      max_results: maxResults,
    });
    truncated = searchResult.total > searchResult.papers.length;
    warning = searchResult.warning;

    // Filter out the original paper and papers by same author group
    // Use "FirstInitial.LastName" format to reduce CJK name collisions
    const originalAuthorsSet = new Set(
      originalAuthors.map(a => extractAuthorIdentifier(a))
    );

    // First pass: identify independent papers
    const independentPapers: Array<{ recid: string; title: string }> = [];
    for (const paper of searchResult.papers) {
      if (paper.recid === originalRecid || !paper.recid) continue;

      const paperAuthors = paper.authors || [];
      const paperAuthorIds = new Set(
        paperAuthors.map(a => extractAuthorIdentifier(a))
      );

      const overlapCount = [...originalAuthorsSet].filter(a => paperAuthorIds.has(a)).length;
      const overlapRatio = overlapCount / Math.max(originalAuthorsSet.size, 1);

      if (overlapRatio < 0.5) {
        independentPapers.push({ recid: paper.recid, title: paper.title });
      }
    }

    // Second pass: analyze stance with concurrent limit
    const CONCURRENT_LIMIT = DEFAULT_STANCE_DETECTION.concurrentLimit;
    for (let i = 0; i < independentPapers.length; i += CONCURRENT_LIMIT) {
      const batch = independentPapers.slice(i, i + CONCURRENT_LIMIT);

      const results = await Promise.all(
        batch.map(async (paper) => {
          let abstract = '';
          try {
            const paperDetails = await api.getPaper(paper.recid);
            abstract = paperDetails.abstract || '';
          } catch {
            abstract = paper.title;
          }

          const stanceResult = analyzeCitationStance(abstract, topicWords);
          return { paper, stanceResult };
        })
      );

      for (const { paper, stanceResult } of results) {
        const paperInfo = {
          recid: paper.recid,
          title: paper.title,
          stance_confidence: stanceResult.confidence,
        };

        if (stanceResult.stance === 'contradicting') {
          conflicting.push(paperInfo);
        } else if (stanceResult.stance === 'confirming') {
          confirming.push(paperInfo);
        }
      }
    }

  } catch (error) {
    console.debug(`[hep-research-mcp] searchConfirmations: Skipped - ${error instanceof Error ? error.message : String(error)}`);
  }

  return { confirming, conflicting, truncated, warning };
}

/**
 * Search for "Comment on" papers that might indicate controversy
 */
async function searchComments(recid: string): Promise<Array<{ recid: string; title: string; }>> {
  const comments: Array<{ recid: string; title: string; }> = [];

  try {
    // Search for papers that cite this one and have "comment" in title
    const query = `refersto:recid:${recid} and t:comment`;
    const result = await api.searchAll(query, { sort: 'mostrecent', size: 1000 });

    for (const paper of result.papers) {
      comments.push({
        recid: paper.recid || '',
        title: paper.title,
      });
    }
  } catch (error) {
    // Log at debug level for troubleshooting
    console.debug(`[hep-research-mcp] searchComments: Skipped - ${error instanceof Error ? error.message : String(error)}`);
  }

  return comments;
}

/**
 * Calculate confidence level based on evidence
 */
function calculateConfidence(
  evidenceLevel: EvidenceLevel,
  confirmations: number,
  conflicts: number,
  isOrphan: boolean
): ConfidenceLevel {
  // Controversial if there are conflicts
  if (conflicts > 0) {
    return 'controversial';
  }

  // Low confidence for orphan theoretical results
  if (isOrphan && evidenceLevel === 'theoretical') {
    return 'low';
  }

  // High confidence for discoveries with confirmations
  if (evidenceLevel === 'discovery' && confirmations >= 2) {
    return 'high';
  }

  // Medium confidence for evidence with some confirmations
  if ((evidenceLevel === 'discovery' || evidenceLevel === 'evidence') && confirmations >= 1) {
    return 'medium';
  }

  // Low confidence for hints and orphan results
  if (evidenceLevel === 'hint' || isOrphan) {
    return 'low';
  }

  return 'medium';
}

/**
 * Calculate overall reliability score
 */
function calculateReliabilityScore(claims: EvidenceGrade[]): number {
  if (claims.length === 0) return 0;

  let totalScore = 0;

  for (const claim of claims) {
    let score = 0;

    // Base score from evidence level
    switch (claim.evidence_level) {
      case 'discovery': score = 0.9; break;
      case 'evidence': score = 0.7; break;
      case 'hint': score = 0.4; break;
      case 'indirect': score = 0.3; break;
      case 'theoretical': score = 0.5; break;
    }

    // Boost for confirmations
    score += Math.min(0.1 * claim.independent_confirmations, 0.2);

    // Penalty for conflicts
    score -= Math.min(0.2 * claim.conflicting_count, 0.4);

    // Penalty for orphan results
    if (claim.is_orphan) {
      score -= 0.1;
    }

    totalScore += Math.max(0, Math.min(1, score));
  }

  return totalScore / claims.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grade the evidence quality of claims in a paper
 */
export async function gradeEvidence(
  params: EvidenceGradingParams
): Promise<EvidenceGradingResult> {
  const {
    recid,
    search_confirmations = true,
    max_search_results: rawMaxSearchResults = 20,
  } = params;
  const maxSearchResults =
    Number.isFinite(rawMaxSearchResults) && Number.isInteger(rawMaxSearchResults) && rawMaxSearchResults >= 1
      ? rawMaxSearchResults
      : 20;

  // Validate recid
  const recidError = validateRecid(recid);
  if (recidError) {
    return {
      paper_recid: recid || '',
      paper_title: '',
      success: false,
      error: recidError,
      main_claims: [],
      overall_reliability: 0,
      warnings: [],
      summary: {
        total_claims: 0,
        well_established: 0,
        controversial: 0,
        orphan: 0,
      },
    };
  }

  try {
    // Get paper metadata
    const paper = await api.getPaper(recid);

    // Extract claims from abstract
    const abstractText = paper.abstract || '';
    const claims = extractClaims(abstractText);

    if (claims.length === 0) {
      return {
        paper_recid: recid,
        paper_title: paper.title,
        paper_year: paper.year,
        paper_abstract: abstractText,  // Return abstract for reuse
        success: true,
        main_claims: [],
        overall_reliability: 0.5,
        warnings: ['No claims could be extracted from abstract'],
        summary: {
          total_claims: 0,
          well_established: 0,
          controversial: 0,
          orphan: 0,
        },
      };
    }

    // Check for "Comment on" papers
    const comments = await searchComments(recid);
    const hasComments = comments.length > 0;

    // Grade each claim
    const gradedClaims: EvidenceGrade[] = [];
    let confirmationSearchTruncated = false;
    const confirmationSearchWarnings = new Set<string>();

    // Grade each claim (no limit - process all)
    for (const claimObj of claims) {
      const sigmaLevel = extractSigmaLevel(claimObj.text);
      const evidenceLevel = determineEvidenceLevel(claimObj.text, sigmaLevel);

      let confirming: Array<{ recid: string; title: string; }> = [];
      let conflicting: Array<{ recid: string; title: string; }> = [];

      if (search_confirmations) {
        const result = await searchConfirmations(
          claimObj.text,
          recid,
          paper.authors,
          maxSearchResults
        );
        confirming = result.confirming;
        conflicting = result.conflicting;
        if (result.truncated) confirmationSearchTruncated = true;
        if (result.warning) confirmationSearchWarnings.add(result.warning);
      }

      // Add comments as potential conflicts
      if (hasComments) {
        conflicting = [...conflicting, ...comments];
      }

      const isOrphan = confirming.length === 0 && !hasComments;
      const confidence = calculateConfidence(
        evidenceLevel,
        confirming.length,
        conflicting.length,
        isOrphan
      );

      gradedClaims.push({
        claim: claimObj.text,
        source_context: {
          before: claimObj.context_before,
          after: claimObj.context_after,
        },
        evidence_level: evidenceLevel,
        sigma_level: sigmaLevel,
        independent_confirmations: confirming.length,
        is_orphan: isOrphan,
        conflicting_count: conflicting.length,
        confidence,
        confirming_papers: confirming.slice(0, 3),
        conflicting_papers: conflicting.slice(0, 3),
      });
    }

    // Calculate statistics
    const wellEstablished = gradedClaims.filter(
      c => c.confidence === 'high' || (c.confidence === 'medium' && c.independent_confirmations >= 2)
    ).length;
    const controversial = gradedClaims.filter(c => c.confidence === 'controversial').length;
    const orphan = gradedClaims.filter(c => c.is_orphan).length;

    // Generate warnings
    const warnings: string[] = [];
    if (hasComments) {
      warnings.push(`Paper has ${comments.length} "Comment on" paper(s) - may indicate controversy`);
    }
    if (search_confirmations && confirmationSearchTruncated) {
      warnings.push(
        `Confirmation search truncated at max_search_results=${maxSearchResults}; evidence grading may be incomplete.`
      );
    }
    if (search_confirmations && confirmationSearchWarnings.size > 0) {
      // Keep this compact: include at most one representative upstream warning.
      const [first] = [...confirmationSearchWarnings];
      if (first && !first.startsWith('Results truncated')) {
        warnings.push(`Confirmation search: ${first}`);
      }
    }
    if (orphan === gradedClaims.length && gradedClaims.length > 0) {
      warnings.push('All claims appear to be "orphan" results without independent confirmation');
    }
    if (controversial > 0) {
      warnings.push(`${controversial} claim(s) have conflicting results in the literature`);
    }

    return {
      paper_recid: recid,
      paper_title: paper.title,
      paper_year: paper.year,
      paper_abstract: abstractText,  // Return abstract for reuse
      success: true,
      main_claims: gradedClaims,
      overall_reliability: calculateReliabilityScore(gradedClaims),
      warnings,
      summary: {
        total_claims: gradedClaims.length,
        well_established: wellEstablished,
        controversial,
        orphan,
      },
    };

  } catch (error) {
    return {
      paper_recid: recid,
      paper_title: 'Unknown',
      success: false,
      error: error instanceof Error ? error.message : String(error),
      main_claims: [],
      overall_reliability: 0,
      warnings: [],
      summary: {
        total_claims: 0,
        well_established: 0,
        controversial: 0,
        orphan: 0,
      },
    };
  }
}
