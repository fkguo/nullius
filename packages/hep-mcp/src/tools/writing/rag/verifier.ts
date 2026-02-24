/**
 * RAG Verifier
 *
 * Complete verification pipeline for RAG-generated content:
 * - Runs all quality gates
 * - Generates rewrite feedback
 * - Tracks verification rounds
 *
 * @module rag/verifier
 */

import type {
  WriterOutput,
  EvidencePacket,
  EvidenceChunk,
  VerifyResult,
  VerifyIssue,
  QualityGateResult,
  SectionOutput,
  SentenceAttribution,
} from './types.js';
import {
  runAllGates,
} from './qualityGates.js';
import {
  parseWriterOutput,
  writerOutputToText,
  validateWriterOutput,
  generateRewritePrompt,
} from './writerPrompt.js';
import { countWords } from './hepTokenizer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface VerificationContext {
  /** Current round number */
  round: number;
  /** Maximum rounds allowed */
  maxRounds: number;
  /** Time limit in ms */
  timeLimit: number;
  /** Start time */
  startTime: number;
}

export interface VerificationResult {
  /** Final writer output */
  output: WriterOutput;
  /** Section output with attributions */
  sectionOutput: SectionOutput;
  /** Gate results from all rounds */
  gateHistory: QualityGateResult[][];
  /** Final verification result */
  final: VerifyResult;
  /** Number of rounds used */
  rounds: number;
  /** Total time in ms */
  timeMs: number;
}

export interface VerifierOptions {
  /** Maximum rewrite rounds */
  maxRounds?: number;
  /** Time limit in ms */
  timeLimit?: number;
  /** Whether to generate rewrite prompts */
  generateRewrites?: boolean;
  /** LLM callback for rewrites */
  rewriteCallback?: (prompt: { system: string; user: string }) => Promise<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_TIME_LIMIT = 60000; // 1 minute

// ─────────────────────────────────────────────────────────────────────────────
// Main Verifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify RAG-generated content
 *
 * Runs quality gates and optionally triggers rewrites
 */
export async function verifyOutput(
  rawOutput: string,
  packet: EvidencePacket,
  options: VerifierOptions = {}
): Promise<VerificationResult> {
  const {
    maxRounds = DEFAULT_MAX_ROUNDS,
    timeLimit = DEFAULT_TIME_LIMIT,
    generateRewrites = false,
    rewriteCallback,
  } = options;

  const startTime = Date.now();
  const gateHistory: QualityGateResult[][] = [];
  let currentOutput = rawOutput;
  let round = 0;

  // Parse initial output
  let parsedOutput = parseWriterOutput(currentOutput);
  if (!parsedOutput) {
    return createFailedResult('Failed to parse initial output', startTime);
  }

  // Verification loop
  while (round < maxRounds) {
    round++;

    // Check time limit
    if (Date.now() - startTime > timeLimit) {
      const finalResult = createTimeoutResult(parsedOutput, gateHistory, round, startTime);
      return finalResult;
    }

    // Run all quality gates
    const allowedIds = new Set([
      ...packet.allowed.claim_ids,
      ...packet.allowed.chunk_ids,
    ]);

    const { results, overall } = runAllGates(
      parsedOutput,
      packet.chunks,
      packet.context_chunks,
      allowedIds
    );

    gateHistory.push(results);

    // Check if passed
    if (overall.pass) {
      return createSuccessResult(parsedOutput, gateHistory, round, startTime, packet);
    }

    // Determine if we should rewrite
    if (overall.action === 'reject') {
      return createRejectedResult(parsedOutput, overall, gateHistory, round, startTime);
    }

    if (!generateRewrites || !rewriteCallback) {
      // No rewrite capability, return current state
      return createPartialResult(parsedOutput, overall, gateHistory, round, startTime, packet);
    }

    // Generate rewrite prompt
    const rewritePrompt = generateRewritePrompt(
      parsedOutput,
      overall.issues.map((i) => i.details),
      packet
    );

    // Call LLM for rewrite
    try {
      currentOutput = await rewriteCallback(rewritePrompt);
      parsedOutput = parseWriterOutput(currentOutput);

      if (!parsedOutput) {
        return createFailedResult('Failed to parse rewritten output', startTime);
      }
    } catch (e) {
      console.error('Rewrite callback failed:', e);
      if (parsedOutput) {
        return createPartialResult(parsedOutput, overall, gateHistory, round, startTime, packet);
      }
      return createFailedResult('Rewrite callback failed and no valid output', startTime);
    }
  }

  // Max rounds reached
  const allowedIds = new Set([
    ...packet.allowed.claim_ids,
    ...packet.allowed.chunk_ids,
  ]);
  const { results, overall } = runAllGates(
    parsedOutput,
    packet.chunks,
    packet.context_chunks,
    allowedIds
  );
  gateHistory.push(results);

  return createMaxRoundsResult(parsedOutput, overall, gateHistory, round, startTime, packet);
}

// ─────────────────────────────────────────────────────────────────────────────
// Result Builders
// ─────────────────────────────────────────────────────────────────────────────

function createSuccessResult(
  output: WriterOutput,
  gateHistory: QualityGateResult[][],
  rounds: number,
  startTime: number,
  packet: EvidencePacket
): VerificationResult {
  return {
    output,
    sectionOutput: buildSectionOutput(output, packet.chunks),
    gateHistory,
    final: {
      pass: true,
      issues: [],
      action: 'accept',
    },
    rounds,
    timeMs: Date.now() - startTime,
  };
}

function createFailedResult(
  error: string,
  startTime: number
): VerificationResult {
  const emptyOutput: WriterOutput = {
    plan: [],
    paragraphs: [],
    gaps: [{ description: error, suggested_query: '' }],
  };

  return {
    output: emptyOutput,
    sectionOutput: {
      content: '',
      attributions: [],
      metadata: {
        word_count: 0,
        paragraph_count: 0,
        citation_count: 0,
        gaps: emptyOutput.gaps,
      },
    },
    gateHistory: [],
    final: {
      pass: false,
      issues: [{ type: 'timeout', sentence: error, details: error }],
      action: 'reject',
    },
    rounds: 0,
    timeMs: Date.now() - startTime,
  };
}

function createTimeoutResult(
  output: WriterOutput,
  gateHistory: QualityGateResult[][],
  rounds: number,
  startTime: number
): VerificationResult {
  return {
    output,
    sectionOutput: buildSectionOutput(output, []),
    gateHistory,
    final: {
      pass: false,
      issues: [{ type: 'timeout', sentence: 'Verification timed out', details: 'Time limit exceeded' }],
      action: 'accept', // Accept with warning
    },
    rounds,
    timeMs: Date.now() - startTime,
  };
}

function createRejectedResult(
  output: WriterOutput,
  overall: VerifyResult,
  gateHistory: QualityGateResult[][],
  rounds: number,
  startTime: number
): VerificationResult {
  return {
    output,
    sectionOutput: buildSectionOutput(output, []),
    gateHistory,
    final: overall,
    rounds,
    timeMs: Date.now() - startTime,
  };
}

function createPartialResult(
  output: WriterOutput,
  overall: VerifyResult,
  gateHistory: QualityGateResult[][],
  rounds: number,
  startTime: number,
  packet: EvidencePacket
): VerificationResult {
  return {
    output,
    sectionOutput: buildSectionOutput(output, packet.chunks),
    gateHistory,
    final: overall,
    rounds,
    timeMs: Date.now() - startTime,
  };
}

function createMaxRoundsResult(
  output: WriterOutput,
  overall: VerifyResult,
  gateHistory: QualityGateResult[][],
  rounds: number,
  startTime: number,
  packet: EvidencePacket
): VerificationResult {
  // Add max rounds issue
  const issues: VerifyIssue[] = [
    ...overall.issues,
    { type: 'max_rounds', sentence: 'Max verification rounds reached', details: `Stopped after ${rounds} rounds` },
  ];

  return {
    output,
    sectionOutput: buildSectionOutput(output, packet.chunks),
    gateHistory,
    final: {
      pass: false,
      issues,
      action: 'accept', // Accept with warnings
    },
    rounds,
    timeMs: Date.now() - startTime,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section Output Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build SectionOutput from WriterOutput
 */
function buildSectionOutput(
  output: WriterOutput,
  chunks: EvidenceChunk[]
): SectionOutput {
  const content = writerOutputToText(output);
  const attributions = buildAttributions(output, chunks);

  return {
    content,
    attributions,
    metadata: {
      word_count: countWords(content),
      paragraph_count: output.paragraphs.length,
      citation_count: countCitations(output),
      gaps: output.gaps,
    },
  };
}

/**
 * Build sentence attributions
 */
function buildAttributions(
  output: WriterOutput,
  chunks: EvidenceChunk[]
): SentenceAttribution[] {
  const chunkMap = new Map(chunks.map((c) => [c.id, c]));
  const attributions: SentenceAttribution[] = [];

  for (const para of output.paragraphs) {
    for (const sentence of para.sentences) {
      // Determine confidence based on support
      const evidence = sentence.evidence_ids
        .map((id) => chunkMap.get(id))
        .filter((c): c is EvidenceChunk => c !== undefined);

      let confidence: SentenceAttribution['confidence'] = 'low';
      let status: SentenceAttribution['status'] = 'unverified';

      if (evidence.length > 0) {
        // Calculate support score using checkSupportStrength logic
        const supportScore = calculateQuickSupportScore(sentence.text, evidence);

        if (supportScore >= 0.7) {
          confidence = 'high';
          status = 'verified';
        } else if (supportScore >= 0.3) {
          confidence = 'medium';
          status = 'partial';
        }
      } else if (sentence.kind === 'meta') {
        // Meta sentences don't need evidence
        confidence = 'high';
        status = 'verified';
      }

      attributions.push({
        sentence: sentence.text,
        evidence_ids: sentence.evidence_ids,
        claim_ids: sentence.claim_ids || [],
        confidence,
        status,
      });
    }
  }

  return attributions;
}

/**
 * Quick support score calculation
 */
function calculateQuickSupportScore(
  sentence: string,
  evidence: EvidenceChunk[]
): number {
  const sentenceWords = new Set(
    sentence.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
  );

  let maxOverlap = 0;

  for (const chunk of evidence) {
    const chunkWords = new Set(
      chunk.text.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
    );

    const intersection = [...sentenceWords].filter((w) => chunkWords.has(w));
    const overlap = sentenceWords.size > 0 ? intersection.length / sentenceWords.size : 0;

    maxOverlap = Math.max(maxOverlap, overlap);
  }

  return maxOverlap;
}

/**
 * Count total citations in output
 */
function countCitations(output: WriterOutput): number {
  let count = 0;
  for (const para of output.paragraphs) {
    for (const sentence of para.sentences) {
      count += sentence.evidence_ids.length;
    }
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick Verification (no rewrites)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quick verification without rewrite loop
 */
export function quickVerify(
  rawOutput: string,
  packet: EvidencePacket
): { parsed: WriterOutput | null; result: VerifyResult } {
  const parsedOutput = parseWriterOutput(rawOutput);

  if (!parsedOutput) {
    return {
      parsed: null,
      result: {
        pass: false,
        issues: [{ type: 'timeout', sentence: 'Parse error', details: 'Failed to parse output' }],
        action: 'reject',
      },
    };
  }

  // Run validation
  const validation = validateWriterOutput(parsedOutput, packet.allowed);

  if (!validation.valid) {
    return {
      parsed: parsedOutput,
      result: {
        pass: false,
        issues: validation.issues.map((i) => ({
          type: 'invalid_attribution' as const,
          sentence: i,
          details: i,
        })),
        action: 'rewrite',
      },
    };
  }

  // Run all gates
  const allowedIds = new Set([
    ...packet.allowed.claim_ids,
    ...packet.allowed.chunk_ids,
  ]);

  const { overall } = runAllGates(
    parsedOutput,
    packet.chunks,
    packet.context_chunks,
    allowedIds
  );

  return {
    parsed: parsedOutput,
    result: overall,
  };
}
