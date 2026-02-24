/**
 * LLM-based Claims Extractor
 *
 * Provides semantic understanding for claims extraction using LLM.
 * Supports three modes:
 * - passthrough: Returns prompt for external LLM to process
 * - client: Returns structured data for client-side LLM processing
 * - internal: Uses configured LLM provider (if available)
 *
 * Different prompts for different paper types:
 * - experimental: Focus on measurements, significance, physical meaning
 * - theoretical: Focus on arguments, methodology, derivations, conclusions
 * - review: Focus on multi-viewpoint comparison, controversies, consensus
 */

import type { ContentType } from '../../research/paperClassifier.js';
import type { ExtractedClaim } from './types.js';
import type { Measurement } from '../../research/measurementExtractor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type LLMExtractionMode = 'passthrough' | 'client' | 'internal';

export interface LLMExtractionParams {
  /** Paper identifier */
  recid: string;
  /** Paper title */
  title: string;
  /** Paper abstract */
  abstract: string;
  /** LaTeX content (optional, for full-text analysis) */
  texContent?: string;
  /** Content type classification */
  contentType: ContentType;
  /** Rule-based extracted claims (Layer 1 results) */
  ruleClaims: ExtractedClaim[];
  /** Rule-based extracted measurements (Layer 1 results) */
  measurements?: Measurement[];
  /** LLM mode */
  mode: LLMExtractionMode;
}

export interface LLMExtractionResult {
  /** Mode used */
  mode: LLMExtractionMode;
  /** Enhanced claims from LLM */
  claims: LLMEnhancedClaim[];
  /** Prompt used (for passthrough/client modes) */
  prompt?: string;
  /** Raw LLM response (for internal mode) */
  rawResponse?: string;
}

export interface LLMEnhancedClaim {
  /** Original claim text */
  text: string;
  /** Physical meaning or interpretation */
  physicalMeaning?: string;
  /** Importance ranking (1 = most important) */
  importanceRank?: number;
  /** Related equation labels */
  relatedEquations?: string[];
  /** For theoretical papers: argument type */
  argumentType?: 'assumption' | 'derivation' | 'prediction' | 'conclusion';
  /** For review papers: consensus level */
  consensusLevel?: 'consensus' | 'majority' | 'disputed' | 'emerging';
  /** Supporting papers (for review papers) */
  supportingPapers?: string[];
  /** Opposing papers (for review papers) */
  opposingPapers?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Templates
// ─────────────────────────────────────────────────────────────────────────────

const EXPERIMENTAL_PROMPT_TEMPLATE = `You are analyzing an EXPERIMENTAL physics paper. Extract and enhance the claims.

## Paper Information
Title: {{title}}
Abstract: {{abstract}}

## Rule-based Extracted Claims
{{ruleClaims}}

## Extracted Measurements
{{measurements}}

## Your Task
For each claim, provide:
1. **Physical Meaning**: What does this measurement/observation mean physically?
2. **Importance Rank**: Rate 1-5 (1 = most important discovery/result)
3. **Related Equations**: List any equation labels referenced

## Output Format (JSON)
{
  "claims": [
    {
      "text": "original claim text",
      "physicalMeaning": "explanation of physical significance",
      "importanceRank": 1,
      "relatedEquations": ["eq:1", "eq:mass"]
    }
  ]
}

Focus on:
- Statistical significance (σ levels)
- Comparison with theoretical predictions
- Comparison with previous measurements
- Systematic uncertainties and their sources
`;

const THEORETICAL_PROMPT_TEMPLATE = `You are analyzing a THEORETICAL physics paper. Extract and enhance the claims.

## Paper Information
Title: {{title}}
Abstract: {{abstract}}

## Rule-based Extracted Claims
{{ruleClaims}}

## Your Task
For each claim, identify:
1. **Argument Type**: Is this an assumption, derivation, prediction, or conclusion?
2. **Physical Meaning**: What is the physical interpretation?
3. **Importance Rank**: Rate 1-5 (1 = key result/prediction)
4. **Related Equations**: List equation labels for key derivations

## Output Format (JSON)
{
  "claims": [
    {
      "text": "original claim text",
      "argumentType": "prediction",
      "physicalMeaning": "physical interpretation",
      "importanceRank": 1,
      "relatedEquations": ["eq:main"]
    }
  ]
}

Focus on:
- Core assumptions and their validity
- Key derivation steps
- Testable predictions
- Limitations and applicability range
`;

const REVIEW_PROMPT_TEMPLATE = `You are analyzing a REVIEW paper. Extract claims and identify consensus/controversies.

## Paper Information
Title: {{title}}
Abstract: {{abstract}}

## Rule-based Extracted Claims
{{ruleClaims}}

## Your Task
For each claim, identify:
1. **Consensus Level**: Is this consensus, majority view, disputed, or emerging?
2. **Supporting Papers**: Which papers/groups support this view?
3. **Opposing Papers**: Which papers/groups oppose this view (if disputed)?
4. **Physical Meaning**: Brief explanation

## Output Format (JSON)
{
  "claims": [
    {
      "text": "original claim text",
      "consensusLevel": "disputed",
      "supportingPapers": ["Author1 et al.", "Collaboration X"],
      "opposingPapers": ["Author2 et al."],
      "physicalMeaning": "explanation"
    }
  ]
}

Focus on:
- Field consensus vs. open questions
- Experimental vs. theoretical disagreements
- Historical evolution of understanding
- Current status and future directions
`;

const MIXED_PROMPT_TEMPLATE = `You are analyzing a physics paper with both experimental and theoretical content.

## Paper Information
Title: {{title}}
Abstract: {{abstract}}

## Rule-based Extracted Claims
{{ruleClaims}}

## Extracted Measurements
{{measurements}}

## Your Task
Classify and enhance each claim:
1. **Claim Type**: experimental_result, theoretical_prediction, or interpretation
2. **Physical Meaning**: What does this mean physically?
3. **Importance Rank**: Rate 1-5

## Output Format (JSON)
{
  "claims": [
    {
      "text": "original claim text",
      "argumentType": "experimental_result",
      "physicalMeaning": "explanation",
      "importanceRank": 1
    }
  ]
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Select appropriate prompt template based on content type
 */
function selectPromptTemplate(contentType: ContentType): string {
  switch (contentType) {
    case 'experimental':
      return EXPERIMENTAL_PROMPT_TEMPLATE;
    case 'theoretical':
      return THEORETICAL_PROMPT_TEMPLATE;
    case 'review':
      return REVIEW_PROMPT_TEMPLATE;
    case 'mixed':
    default:
      return MIXED_PROMPT_TEMPLATE;
  }
}

/**
 * Format rule-based claims for prompt
 */
function formatRuleClaims(claims: ExtractedClaim[]): string {
  if (claims.length === 0) return '(No claims extracted by rule-based methods)';

  return claims.map((c, i) =>
    `${i + 1}. [${c.category}] ${c.text}\n   Evidence: ${c.evidence_level}`
  ).join('\n');
}

/**
 * Format measurements for prompt
 */
function formatMeasurements(measurements?: Measurement[]): string {
  if (!measurements || measurements.length === 0) {
    return '(No measurements extracted)';
  }

  return measurements.map((m, i) => {
    let str = `${i + 1}. ${m.quantity_hint}: ${m.value}`;
    if (m.asymmetric) {
      str += ` +${m.asymmetric.plus} -${m.asymmetric.minus}`;
    } else {
      str += ` ± ${m.uncertainty}`;
    }
    if (m.unit) str += ` ${m.unit}`;
    return str;
  }).join('\n');
}

/**
 * Build prompt from template and parameters
 */
function buildPrompt(params: LLMExtractionParams): string {
  const template = selectPromptTemplate(params.contentType);

  return template
    .replace('{{title}}', params.title)
    .replace('{{abstract}}', params.abstract)
    .replace('{{ruleClaims}}', formatRuleClaims(params.ruleClaims))
    .replace('{{measurements}}', formatMeasurements(params.measurements));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract and enhance claims using LLM
 *
 * @param params - Extraction parameters
 * @returns Enhanced claims with LLM analysis
 */
export async function extractWithLLM(
  params: LLMExtractionParams
): Promise<LLMExtractionResult> {
  const prompt = buildPrompt(params);

  switch (params.mode) {
    case 'passthrough':
      // Return prompt for external processing
      return {
        mode: 'passthrough',
        claims: [],
        prompt,
      };

    case 'client':
      // Return structured data for client-side LLM
      return {
        mode: 'client',
        claims: params.ruleClaims.map(c => ({
          text: c.text,
          // Client will fill in these fields
        })),
        prompt,
      };

    case 'internal':
      // Use internal LLM provider (if configured)
      return await extractWithInternalLLM(params, prompt);

    default:
      return {
        mode: 'passthrough',
        claims: [],
        prompt,
      };
  }
}

/**
 * Internal LLM extraction (uses configured provider)
 */
async function extractWithInternalLLM(
  _params: LLMExtractionParams,
  prompt: string
): Promise<LLMExtractionResult> {
  // Check for LLM provider configuration
  const provider = process.env.WRITING_LLM_PROVIDER;
  const apiKey = process.env.WRITING_LLM_API_KEY;

  if (!provider || !apiKey) {
    console.error('[llmExtractor] No LLM provider configured, falling back to passthrough');
    return {
      mode: 'passthrough',
      claims: [],
      prompt,
    };
  }

  try {
    // Dynamic import to avoid bundling issues
    const response = await callLLMProvider(provider, apiKey, prompt);
    const parsed = parseJSONResponse(response);

    return {
      mode: 'internal',
      claims: parsed.claims || [],
      rawResponse: response,
    };
  } catch (error) {
    console.error('[llmExtractor] LLM call failed:', error);
    return {
      mode: 'passthrough',
      claims: [],
      prompt,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM Provider Integration
// ─────────────────────────────────────────────────────────────────────────────

/** LLM API timeout in milliseconds */
const LLM_API_TIMEOUT_MS = 60000; // 60 seconds

/**
 * Call LLM provider API with timeout and error handling
 */
async function callLLMProvider(
  provider: string,
  apiKey: string,
  prompt: string
): Promise<string> {
  const model = process.env.WRITING_LLM_MODEL || 'deepseek-chat';

  if (provider === 'deepseek') {
    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LLM_API_TIMEOUT_MS);

    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Try to get error details from response body
        let errorDetail = '';
        try {
          const errorBody = await response.text();
          errorDetail = errorBody.slice(0, 200); // Limit error message length
        } catch {
          // Ignore if we can't read the body
        }
        throw new Error(`DeepSeek API error: ${response.status}${errorDetail ? ` - ${errorDetail}` : ''}`);
      }

      const data: unknown = await response.json();

      // Type-safe response parsing
      if (
        typeof data === 'object' &&
        data !== null &&
        'choices' in data &&
        Array.isArray((data as { choices: unknown[] }).choices)
      ) {
        const choices = (data as { choices: Array<{ message?: { content?: string } }> }).choices;
        return choices[0]?.message?.content || '';
      }

      throw new Error('Invalid response format from DeepSeek API');
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`DeepSeek API timeout after ${LLM_API_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    }
  }

  // Add more providers as needed
  throw new Error(`Unsupported LLM provider: ${provider}`);
}

/**
 * Parse JSON response from LLM
 */
function parseJSONResponse(response: string): { claims: LLMEnhancedClaim[] } {
  // Try to find JSON block containing "claims" array
  // Use balanced brace matching for robustness
  const startIdx = response.indexOf('{');
  if (startIdx === -1) {
    console.error('[llmExtractor] No JSON found in response');
    return { claims: [] };
  }

  // Find matching closing brace
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < response.length; i++) {
    if (response[i] === '{') depth++;
    else if (response[i] === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  if (endIdx === -1) {
    console.error('[llmExtractor] Unbalanced braces in response');
    return { claims: [] };
  }

  const jsonStr = response.slice(startIdx, endIdx + 1);

  try {
    const parsed = JSON.parse(jsonStr);
    // Validate structure
    if (!parsed.claims || !Array.isArray(parsed.claims)) {
      console.error('[llmExtractor] Invalid response structure: missing claims array');
      return { claims: [] };
    }
    return parsed;
  } catch {
    console.error('[llmExtractor] Failed to parse JSON response');
    return { claims: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fusion Layer (Phase 4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum Jaccard similarity threshold for claim matching.
 *
 * Rationale for 0.2:
 * - Jaccard = |intersection| / |union|
 * - For two sentences about the same topic, expect ~20-40% word overlap
 * - Lower threshold (0.2) allows LLM rewrites while filtering unrelated claims
 * - Higher values (>0.5) would only match nearly identical sentences
 *
 * Example: "X(3872) mass is 3871.9 MeV" vs "We measure X(3872) at 3871.9 MeV"
 * → Jaccard ≈ 0.38 (5 common words / 13 total unique words)
 */
const MIN_JACCARD_THRESHOLD = 0.2;

/**
 * Tokenize text into words for similarity comparison.
 * Normalizes to lowercase and splits on whitespace/punctuation.
 */
function tokenize(text: string): Set<string> {
  const normalized = text.toLowerCase();
  // Split on whitespace and punctuation, preserve physics notation
  const tokens = normalized
    .replace(/[.,;:!?()[\]{}]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
  return new Set(tokens);
}

/**
 * Calculate Jaccard similarity between two texts.
 * J(A,B) = |A ∩ B| / |A ∪ B|
 *
 * @returns Value in [0, 1], where 1 = identical word sets
 */
function jaccardSimilarity(text1: string, text2: string): number {
  const set1 = tokenize(text1);
  const set2 = tokenize(text2);

  if (set1.size === 0 || set2.size === 0) return 0;

  let intersection = 0;
  for (const token of set1) {
    if (set2.has(token)) intersection++;
  }

  const union = set1.size + set2.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Merge rule-based claims with LLM-enhanced claims using greedy best-match.
 *
 * Algorithm:
 * 1. Compute similarity matrix between all rule claims and LLM claims
 * 2. Greedily assign best matches (highest similarity first)
 * 3. Each LLM claim can only be matched once
 * 4. Only accept matches above MIN_JACCARD_THRESHOLD
 *
 * Rule-based results take priority for numerical values.
 */
export function mergeClaims(
  ruleClaims: ExtractedClaim[],
  llmClaims: LLMEnhancedClaim[]
): ExtractedClaim[] {
  if (llmClaims.length === 0) {
    return ruleClaims;
  }

  // Build similarity matrix: [ruleIdx, llmIdx, score]
  const similarities: Array<{ ruleIdx: number; llmIdx: number; score: number }> = [];

  for (let r = 0; r < ruleClaims.length; r++) {
    for (let l = 0; l < llmClaims.length; l++) {
      const score = jaccardSimilarity(ruleClaims[r].text, llmClaims[l].text);
      if (score >= MIN_JACCARD_THRESHOLD) {
        similarities.push({ ruleIdx: r, llmIdx: l, score });
      }
    }
  }

  // Sort by score descending (greedy best-match)
  similarities.sort((a, b) => b.score - a.score);

  // Track matched indices
  const matchedRules = new Set<number>();
  const matchedLLMs = new Set<number>();
  const matches = new Map<number, LLMEnhancedClaim>(); // ruleIdx -> llmClaim

  // Greedy assignment
  for (const { ruleIdx, llmIdx, score } of similarities) {
    if (matchedRules.has(ruleIdx) || matchedLLMs.has(llmIdx)) continue;

    matchedRules.add(ruleIdx);
    matchedLLMs.add(llmIdx);
    matches.set(ruleIdx, llmClaims[llmIdx]);

    // Debug logging
    console.error(`[mergeClaims] Matched rule[${ruleIdx}] <-> llm[${llmIdx}] (Jaccard=${score.toFixed(2)})`);
  }

  // Enhance rule claims with matched LLM insights
  return ruleClaims.map((ruleClaim, idx) => {
    const llmMatch = matches.get(idx);

    if (llmMatch) {
      const existingContext = ruleClaim.source_context || { before: '', after: '' };
      return {
        ...ruleClaim,
        source_context: {
          ...existingContext,
          llm_physical_meaning: llmMatch.physicalMeaning,
          llm_importance_rank: llmMatch.importanceRank,
        },
      };
    }

    return ruleClaim;
  });
}
