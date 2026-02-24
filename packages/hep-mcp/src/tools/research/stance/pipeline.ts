/**
 * Stance Detection Pipeline
 *
 * End-to-end pipeline for analyzing citation stance from LaTeX source.
 * Implements the Phase 2 design with caching, batch resolution, and aggregation.
 */

import type {
  StancePipelineInput,
  StancePipelineOptions,
  StancePipelineResult,
  CitationContextWithStance,
  CitationContext,
  PipelineError,
  BibEntryIdentifiers,
} from './types.js';

import { extractCitationContextsFromRegex } from './extractor.js';
import { parseBibliographyContent } from './bibitemParser.js';
import { batchResolveCitekeys } from './resolver.js';
import { analyzeTextStance } from './analyzer.js';
import { aggregateStances } from './aggregator.js';
import * as api from '../../../api/client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Default Options
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PIPELINE_OPTIONS: Required<Omit<StancePipelineOptions, 'onProgress'>> = {
  maxContexts: 20,
  includeNeighbors: true,
  resolverConcurrency: 4,
  skipUnresolved: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Reverse Lookup: Get texkeys for target paper (Performance Optimization)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get texkeys for a paper by recid
 * Returns array of possible texkeys (e.g., ["Guo:2017jvc", "Guo:2017"])
 */
async function getTexkeysForRecid(recid: string): Promise<string[]> {
  try {
    const paper = await api.getPaper(recid);
    const texkeys: string[] = [];

    // Extract texkey from paper metadata (singular)
    if (paper.texkey) {
      texkeys.push(paper.texkey);
    }

    // Generate fallback patterns from authors and year
    if (paper.authors?.length && paper.earliest_date) {
      // authors is string[], first element is "LastName, FirstName"
      const firstAuthor = paper.authors[0].split(',')[0] || '';
      const year = paper.earliest_date.slice(0, 4);
      if (firstAuthor && year) {
        texkeys.push(`${firstAuthor}:${year}`);
      }
    }

    return texkeys;
  } catch (err) {
    console.warn(`[stance/pipeline] Failed to get texkeys for ${recid}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Find citekeys in bbl that match target texkeys
 */
function findMatchingCitekeys(
  allCitekeys: string[],
  targetTexkeys: string[]
): string[] {
  const matched: string[] = [];

  for (const citekey of allCitekeys) {
    for (const texkey of targetTexkeys) {
      // Exact match or prefix match (e.g., "Guo:2017jvc" matches "Guo:2017")
      if (citekey === texkey ||
          citekey.toLowerCase().startsWith(texkey.toLowerCase())) {
        matched.push(citekey);
        break;
      }
    }
  }

  return matched;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/** Build empty result for fatal errors */
function buildEmptyResult(
  targetRecid: string,
  startTime: number,
  errors: PipelineError[],
  warnings: string[]
): StancePipelineResult {
  return {
    targetRecid,
    contexts: [],
    aggregated: {
      stance: 'neutral',
      confidence: 'low',
      scores: { confirming: 0, contradicting: 0, neutral: 0, mixed: 0 },
      counts: { confirming: 0, contradicting: 0, neutral: 0, mixed: 0 },
      needsLLMReview: true,
      reviewReasons: ['Pipeline failed'],
    },
    metadata: {
      totalCitations: 0,
      resolvedCitekeysCount: 0,
      resolvedUniqueRecidsCount: 0,
      targetCitations: 0,
      processingTimeMs: Date.now() - startTime,
    },
    errors,
    warnings,
  };
}

/** Extract all unique citekeys from contexts */
function extractUniqueCitekeys(contexts: CitationContext[]): string[] {
  const citekeys = new Set<string>();
  for (const ctx of contexts) {
    citekeys.add(ctx.citekey);
  }
  return [...citekeys];
}

/** Extract all citekeys from LaTeX content */
function extractAllCitekeysFromLatex(latex: string): string[] {
  const citekeys = new Set<string>();
  const citePattern = /\\[a-zA-Z]*cite[a-zA-Z*]*\s*(?:\[[^\]]*\]){0,2}\s*\{([^}]+)\}/g;

  let match;
  while ((match = citePattern.exec(latex)) !== null) {
    const keys = match[1].split(',').map(k => k.trim());
    for (const key of keys) {
      if (key) citekeys.add(key);
    }
  }

  return [...citekeys];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Pipeline Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze citation stance from LaTeX source
 *
 * Pipeline steps:
 * 1. Extract all citation contexts from LaTeX
 * 2. Parse bib/bbl to get citekey identifiers
 * 3. Batch resolve citekeys to recids
 * 4. Filter contexts citing target paper
 * 5. Analyze stance for each context
 * 6. Aggregate results
 */
export async function analyzeStanceFromLatex(
  input: StancePipelineInput
): Promise<StancePipelineResult> {
  const startTime = Date.now();
  const options = { ...DEFAULT_PIPELINE_OPTIONS, ...input.options };

  // R3 P0-2: Maintain error and warning collection channels
  const errors: PipelineError[] = [];
  const warnings: string[] = [];

  // Report progress if callback provided
  const reportProgress = (stage: string, progress: number) => {
    input.options?.onProgress?.(stage, progress);
  };

  reportProgress('extraction', 0);

  // Step 1: Extract all citation contexts
  let allContexts: CitationContext[] = [];
  try {
    // Get all unique citekeys first, then extract contexts for all of them
    const allCitekeys = extractAllCitekeysFromLatex(input.latexContent);
    allContexts = extractCitationContextsFromRegex(input.latexContent, allCitekeys);
  } catch (err) {
    errors.push({
      type: 'extraction',
      message: `Failed to extract contexts: ${(err as Error).message}`,
      recoverable: false,
    });
    return buildEmptyResult(input.targetRecid, startTime, errors, warnings);
  }

  reportProgress('extraction', 100);

  if (allContexts.length === 0) {
    warnings.push('No citation contexts found in LaTeX');
    return buildEmptyResult(input.targetRecid, startTime, errors, warnings);
  }

  reportProgress('parsing', 0);

  // Step 2: Parse bib/bbl content
  let bibEntries: Map<string, BibEntryIdentifiers> = new Map();
  let bibFormat = 'none';

  if (input.bibContent) {
    const bibResult = parseBibliographyContent(input.bibContent);
    bibEntries = bibResult.entries;
    bibFormat = bibResult.format;
    warnings.push(...bibResult.warnings);
  }

  reportProgress('parsing', 100);
  reportProgress('resolution', 0);

  // Step 3: Optimized resolution using reverse lookup
  // Instead of resolving ALL citekeys, we:
  // 1. Get target paper's texkeys (1 API call)
  // 2. Find matching citekeys locally (no API calls)
  // 3. Only resolve matched citekeys for verification (few API calls)

  const uniqueCitekeys = extractUniqueCitekeys(allContexts);
  let targetCitekeys: string[] = [];
  let resolveResult: Awaited<ReturnType<typeof batchResolveCitekeys>>;

  // Try reverse lookup optimization first
  const targetTexkeys = await getTexkeysForRecid(input.targetRecid);

  if (targetTexkeys.length > 0) {
    // Fast path: match texkeys locally
    targetCitekeys = findMatchingCitekeys(uniqueCitekeys, targetTexkeys);

    if (targetCitekeys.length > 0) {
      // Only resolve matched citekeys for verification
      resolveResult = await batchResolveCitekeys(
        targetCitekeys,
        bibEntries,
        options.resolverConcurrency
      );
    } else {
      // No matches found - fall back to full resolution directly
      warnings.push('No citekeys matched target texkeys, trying full resolution');
      resolveResult = await batchResolveCitekeys(
        uniqueCitekeys,
        bibEntries,
        options.resolverConcurrency
      );
    }
  } else {
    // Fallback: full resolution (slow path)
    warnings.push('Could not get target texkeys, using full resolution');
    resolveResult = await batchResolveCitekeys(
      uniqueCitekeys,
      bibEntries,
      options.resolverConcurrency
    );
  }

  // Collect resolver errors
  for (const err of resolveResult.resolverErrors) {
    errors.push({ ...err, recoverable: true });
  }

  reportProgress('resolution', 100);
  reportProgress('analysis', 0);

  // Step 4: Filter contexts citing target paper
  // Use texkey-matched citekeys if available, otherwise use recid matching
  const targetContexts = allContexts.filter(ctx => {
    // Fast path: check if citekey was matched by texkey
    if (targetCitekeys.length > 0 && targetCitekeys.includes(ctx.citekey)) {
      return true;
    }
    // Slow path: check resolved recid
    return resolveResult.citekeyToRecid.get(ctx.citekey) === input.targetRecid;
  });

  // Step 5: Analyze stance for each context
  const contextsWithStance: CitationContextWithStance[] = targetContexts
    .slice(0, options.maxContexts)
    .map(context => {
      const stance = analyzeTextStance(
        options.includeNeighbors ? context.extendedContext : context.sentence,
        { section: context.section, inputType: 'citation_context' }
      );

      return {
        context,
        stance,
        resolvedRecid: resolveResult.citekeyToRecid.get(context.citekey) || null,
        resolutionMethod: resolveResult.citekeyToMethod.get(context.citekey),
      };
    });

  reportProgress('analysis', 100);
  reportProgress('aggregation', 0);

  // Step 6: Aggregate stances
  const aggregated = aggregateStances(contextsWithStance);

  reportProgress('aggregation', 100);

  // R3 P0-1: Calculate correct statistics
  const resolvedValues = [...resolveResult.citekeyToRecid.values()].filter(Boolean);
  const uniqueRecids = new Set(resolvedValues);
  const totalResolved = resolveResult.cacheHits + resolveResult.cacheMisses;
  const cacheHitRate = totalResolved > 0 ? resolveResult.cacheHits / totalResolved : 0;

  return {
    targetRecid: input.targetRecid,
    contexts: contextsWithStance,
    aggregated,
    metadata: {
      totalCitations: allContexts.length,
      resolvedCitekeysCount: resolvedValues.length,
      resolvedUniqueRecidsCount: uniqueRecids.size,
      targetCitations: targetContexts.length,
      processingTimeMs: Date.now() - startTime,
      cacheHitRate,
      bibFormatDetected: bibFormat,
    },
    errors,
    warnings,
  };
}
