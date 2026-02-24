/**
 * Quality Gates
 *
 * Three-gate verification for generated content:
 * 1. Attribution Gate - Every fact sentence has valid citations
 * 2. Number Gate - Numbers match source evidence
 * 3. N-gram Gate - No plagiarism (high overlap with source)
 *
 * @module rag/qualityGates
 */

import type {
  WriterOutput,
  EvidenceChunk,
  QualityGateResult,
  VerifyResult,
  VerifyIssue,
  HEPNumber,
} from './types.js';
import {
  extractHEPNumbers,
  matchNumbers,
  markSymbolicVariables,
} from './hepNumbers.js';
import { extractKeyTokens } from './hepTokenizer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gate thresholds
 */
const THRESHOLDS = {
  /** Minimum support score for weak support warning */
  min_support_score: 0.3,
  /** Maximum n-gram overlap before flagging */
  max_ngram_overlap: 0.35,
  /** Hard fail threshold for n-gram overlap */
  ngram_hard_fail: 0.80,
  /** Number tension tolerance (sigma) */
  number_tension_tolerance: 2.0,
  /** Minimum sentence length to check (characters) */
  min_sentence_length: 20,
};

/**
 * N-gram sizes for overlap detection
 */
const NGRAM_SIZES = [3, 4, 5];

// ─────────────────────────────────────────────────────────────────────────────
// Attribution Gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check that every factual sentence has valid citations
 */
export function checkAttributionGate(
  output: WriterOutput,
  allowedIds: Set<string>
): QualityGateResult {
  const issues: string[] = [];
  let validCount = 0;
  let totalFactual = 0;

  for (const para of output.paragraphs) {
    for (const sentence of para.sentences) {
      // Only check factual sentence types
      if (!['fact', 'result', 'method'].includes(sentence.kind)) {
        continue;
      }

      totalFactual++;

      // Check if has citations
      if (sentence.evidence_ids.length === 0) {
        issues.push(`Missing citation: "${sentence.text.slice(0, 50)}..."`);
        continue;
      }

      // Check if all citations are valid
      const invalidIds = sentence.evidence_ids.filter(
        (id) => !allowedIds.has(id)
      );

      if (invalidIds.length > 0) {
        issues.push(
          `Invalid citation IDs [${invalidIds.join(', ')}] in: "${sentence.text.slice(0, 50)}..."`
        );
        continue;
      }

      validCount++;
    }
  }

  const score = totalFactual > 0 ? validCount / totalFactual : 1.0;

  return {
    gate: 'attribution',
    pass: issues.length === 0,
    score,
    issues,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Support Score Calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate support score for a sentence against its evidence
 *
 * Based on key token overlap and semantic similarity
 */
export function calculateSupportScore(
  sentence: string,
  evidence: EvidenceChunk[]
): number {
  if (evidence.length === 0) return 0;

  // Extract key tokens from sentence
  const sentenceTokens = new Set(extractKeyTokens(sentence));
  if (sentenceTokens.size === 0) return 0.5; // Neutral for sentences without key tokens

  let maxScore = 0;

  for (const chunk of evidence) {
    const chunkTokens = new Set(extractKeyTokens(chunk.text));

    // Calculate Jaccard-like overlap
    const intersection = [...sentenceTokens].filter((t) => chunkTokens.has(t));
    const score = intersection.length / sentenceTokens.size;

    maxScore = Math.max(maxScore, score);
  }

  return maxScore;
}

/**
 * Check support strength for all sentences
 */
export function checkSupportStrength(
  output: WriterOutput,
  chunks: EvidenceChunk[]
): { weak: string[]; scores: Map<string, number> } {
  const weak: string[] = [];
  const scores = new Map<string, number>();
  const chunkMap = new Map(chunks.map((c) => [c.id, c]));

  for (const para of output.paragraphs) {
    for (const sentence of para.sentences) {
      if (sentence.evidence_ids.length === 0) continue;

      const evidence = sentence.evidence_ids
        .map((id) => chunkMap.get(id))
        .filter((c): c is EvidenceChunk => c !== undefined);

      const score = calculateSupportScore(sentence.text, evidence);
      scores.set(sentence.text.slice(0, 50), score);

      if (score < THRESHOLDS.min_support_score) {
        weak.push(`Weak support (${(score * 100).toFixed(0)}%): "${sentence.text.slice(0, 50)}..."`);
      }
    }
  }

  return { weak, scores };
}

// ─────────────────────────────────────────────────────────────────────────────
// Number Gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check that all numbers in generated text match source evidence
 */
export function checkNumberGate(
  output: WriterOutput,
  chunks: EvidenceChunk[]
): QualityGateResult {
  const issues: string[] = [];

  // Extract numbers from all evidence chunks
  const sourceNumbers: HEPNumber[] = [];
  for (const chunk of chunks) {
    const nums = extractHEPNumbers(chunk.text);
    sourceNumbers.push(...markSymbolicVariables(nums));
  }

  // Extract numbers from generated text
  const generatedText = output.paragraphs
    .flatMap((p) => p.sentences.map((s) => s.text))
    .join(' ');

  const generatedNumbers = markSymbolicVariables(
    extractHEPNumbers(generatedText)
  );

  // Match numbers
  const { unmatched_generated } = matchNumbers(sourceNumbers, generatedNumbers);

  // Report unmatched (potentially hallucinated) numbers
  for (const num of unmatched_generated) {
    if (num.is_symbolic) continue; // Skip symbolic variables

    issues.push(
      `Unverified number: ${num.raw} (type: ${num.type})`
    );
  }

  // Calculate score
  const totalGenerated = generatedNumbers.filter((n) => !n.is_symbolic).length;
  const unmatchedCount = unmatched_generated.filter((n) => !n.is_symbolic).length;
  const score = totalGenerated > 0
    ? 1 - unmatchedCount / totalGenerated
    : 1.0;

  return {
    gate: 'number',
    pass: issues.length === 0,
    score,
    issues,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// N-gram Gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate n-grams from text
 */
function generateNgrams(text: string, n: number): Set<string> {
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  const ngrams = new Set<string>();

  for (let i = 0; i <= words.length - n; i++) {
    ngrams.add(words.slice(i, i + n).join(' '));
  }

  return ngrams;
}

/**
 * Calculate n-gram overlap ratio
 */
function calculateNgramOverlap(
  generated: string,
  source: string,
  n: number
): number {
  const genNgrams = generateNgrams(generated, n);
  const srcNgrams = generateNgrams(source, n);

  if (genNgrams.size === 0) return 0;

  let matchCount = 0;
  for (const ngram of genNgrams) {
    if (srcNgrams.has(ngram)) {
      matchCount++;
    }
  }

  return matchCount / genNgrams.size;
}

/**
 * Check for excessive n-gram overlap (potential plagiarism)
 */
export function checkNgramGate(
  output: WriterOutput,
  chunks: EvidenceChunk[]
): QualityGateResult {
  const issues: string[] = [];
  let maxOverlap = 0;

  // Combine all source text
  const sourceText = chunks.map((c) => c.text).join(' ');

  for (const para of output.paragraphs) {
    for (const sentence of para.sentences) {
      if (sentence.text.length < THRESHOLDS.min_sentence_length) continue;

      // Check each n-gram size
      for (const n of NGRAM_SIZES) {
        const overlap = calculateNgramOverlap(sentence.text, sourceText, n);
        maxOverlap = Math.max(maxOverlap, overlap);

        if (overlap >= THRESHOLDS.ngram_hard_fail) {
          issues.push(
            `High ${n}-gram overlap (${(overlap * 100).toFixed(0)}%): "${sentence.text.slice(0, 50)}..."`
          );
        } else if (overlap >= THRESHOLDS.max_ngram_overlap) {
          issues.push(
            `Moderate ${n}-gram overlap (${(overlap * 100).toFixed(0)}%): "${sentence.text.slice(0, 50)}..."`
          );
        }
      }
    }
  }

  // Calculate score (inverse of max overlap)
  const score = 1 - maxOverlap;

  return {
    gate: 'ngram',
    pass: maxOverlap < THRESHOLDS.ngram_hard_fail,
    score,
    issues,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Leakage Gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check for context leakage (citing context chunks as primary evidence)
 */
export function checkContextLeakage(
  output: WriterOutput,
  mainChunkIds: Set<string>,
  contextChunkIds: Set<string>
): QualityGateResult {
  const issues: string[] = [];
  let leakageCount = 0;
  let totalCitations = 0;

  for (const para of output.paragraphs) {
    for (const sentence of para.sentences) {
      for (const id of sentence.evidence_ids) {
        totalCitations++;
        if (contextChunkIds.has(id) && !mainChunkIds.has(id)) {
          leakageCount++;
          issues.push(
            `Context chunk cited as evidence [${id}]: "${sentence.text.slice(0, 50)}..."`
          );
        }
      }
    }
  }

  const score = totalCitations > 0
    ? 1 - leakageCount / totalCitations
    : 1.0;

  return {
    gate: 'context_leakage',
    pass: issues.length === 0,
    score,
    issues,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined Verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all quality gates on writer output
 */
export function runAllGates(
  output: WriterOutput,
  chunks: EvidenceChunk[],
  contextChunks: EvidenceChunk[],
  allowedIds: Set<string>
): {
  results: QualityGateResult[];
  overall: VerifyResult;
} {
  const mainChunkIds = new Set(chunks.map((c) => c.id));
  const contextChunkIds = new Set(contextChunks.map((c) => c.id));

  // Run all gates
  const attributionResult = checkAttributionGate(output, allowedIds);
  const numberResult = checkNumberGate(output, chunks);
  const ngramResult = checkNgramGate(output, chunks);
  const contextResult = checkContextLeakage(output, mainChunkIds, contextChunkIds);

  const results = [attributionResult, numberResult, ngramResult, contextResult];

  // Check support strength (soft warning)
  const { weak } = checkSupportStrength(output, chunks);

  // Determine overall result
  const allIssues: VerifyIssue[] = [];

  // Attribution issues
  for (const issue of attributionResult.issues) {
    allIssues.push({
      type: issue.includes('Missing') ? 'missing_attribution' : 'invalid_attribution',
      sentence: issue,
      details: issue,
    });
  }

  // Number issues
  for (const issue of numberResult.issues) {
    allIssues.push({
      type: 'unverified_number',
      sentence: issue,
      details: issue,
    });
  }

  // N-gram issues
  for (const issue of ngramResult.issues) {
    allIssues.push({
      type: 'ngram_overlap',
      sentence: issue,
      details: issue,
    });
  }

  // Context leakage issues
  for (const issue of contextResult.issues) {
    allIssues.push({
      type: 'context_leakage',
      sentence: issue,
      details: issue,
    });
  }

  // Weak support (soft warning)
  for (const issue of weak) {
    allIssues.push({
      type: 'weak_support',
      sentence: issue,
      details: issue,
    });
  }

  // Determine action
  let action: VerifyResult['action'] = 'accept';

  // Hard failures
  const hardFail =
    !attributionResult.pass ||
    (ngramResult.score < 1 - THRESHOLDS.ngram_hard_fail);

  if (hardFail) {
    action = 'reject';
  } else if (!numberResult.pass || !ngramResult.pass) {
    action = 'rewrite';
  } else if (weak.length > 0) {
    action = 'retrieve_more';
  }

  return {
    results,
    overall: {
      pass: results.every((r) => r.pass),
      issues: allIssues,
      action,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate Thresholds Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get current gate thresholds
 */
export function getThresholds(): typeof THRESHOLDS {
  return { ...THRESHOLDS };
}

/**
 * Update gate thresholds
 */
export function setThresholds(
  updates: Partial<typeof THRESHOLDS>
): void {
  Object.assign(THRESHOLDS, updates);
}
