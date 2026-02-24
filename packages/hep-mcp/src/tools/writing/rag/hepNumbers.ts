/**
 * HEP Number Extraction
 *
 * Extracts numerical measurements from HEP LaTeX text:
 * - Mass, width, lifetime measurements
 * - Cross sections, branching ratios
 * - Uncertainties (symmetric, asymmetric, multi-component)
 * - Limits (upper, lower)
 * - Chi-squared, significance, p-values
 *
 * @module rag/hepNumbers
 */

import type { HEPNumber, HEPNumberType } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Reserved for future unit-aware number extraction
/*
const UNIT_PATTERNS = [
  // Energy/Mass
  'GeV', 'TeV', 'MeV', 'keV', 'eV',
  'GeV/c', 'GeV/c\\^2', 'GeV/c\\^\\{2\\}',
  // Cross section / Luminosity
  'fb', 'pb', 'nb', 'μb', 'mb',
  'fb\\^\\{?-1\\}?', 'pb\\^\\{?-1\\}?',
  // Time
  'ps', 'fs', 'ns', 'μs', 'ms', 's',
  // Length
  'fm', 'μm', 'nm', 'mm', 'cm', 'm',
  // Dimensionless
  '%', '\\\\%',
];

const UNIT_REGEX = new RegExp(`(${UNIT_PATTERNS.join('|')})`, 'i');
*/

// ─────────────────────────────────────────────────────────────────────────────
// Number Patterns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pattern components
 */
const NUM = '[-+]?\\d+\\.?\\d*';
const SCI = `(?:[eE][-+]?\\d+|\\s*[×x]\\s*10\\^\\{?[-+]?\\d+\\}?)`;
const FULL_NUM = `(${NUM}${SCI}?)`;
const PM = '\\s*(?:\\\\pm|±|\\+\\/-)\\s*';
const ASYMERR = `\\^\\{?([+-]?${NUM})\\}?_\\{?([+-]?${NUM})\\}?`;

/**
 * Extraction patterns by type
 */
const PATTERNS: { type: HEPNumberType; pattern: RegExp; extractor: (m: RegExpMatchArray, ctx: string) => HEPNumber | null }[] = [
  // Asymmetric error: 125.09^{+0.24}_{-0.21} GeV
  {
    type: 'asymmetric',
    pattern: new RegExp(`${FULL_NUM}\\s*${ASYMERR}(?:\\s*([A-Za-z/%]+))?`, 'g'),
    extractor: (m, ctx) => {
      const value = parseFloat(m[1]);
      const plusErr = parseFloat(m[2]);
      const minusErr = parseFloat(m[3]);
      const unit = m[4];
      return {
        raw: m[0],
        type: 'asymmetric',
        value,
        uncertainties: [{
          type: 'total',
          plus: Math.abs(plusErr),
          minus: Math.abs(minusErr),
        }],
        unit,
        context: ctx,
        is_symbolic: false,
      };
    },
  },

  // Multi-error: 3871.9 ± 0.7_stat ± 0.2_sys MeV
  {
    type: 'multi_error',
    pattern: new RegExp(`${FULL_NUM}${PM}${FULL_NUM}(?:_\\{?(?:stat\\.?|statistical)\\}?)?${PM}${FULL_NUM}(?:_\\{?(?:sys[t]?\\.?|systematic)\\}?)?(?:\\s*([A-Za-z/%]+))?`, 'gi'),
    extractor: (m, ctx) => {
      const value = parseFloat(m[1]);
      const statErr = parseFloat(m[2]);
      const sysErr = parseFloat(m[3]);
      const unit = m[4];
      return {
        raw: m[0],
        type: 'multi_error',
        value,
        uncertainties: [
          { type: 'stat', plus: statErr, minus: statErr, label: 'stat' },
          { type: 'syst', plus: sysErr, minus: sysErr, label: 'syst' },
        ],
        unit,
        context: ctx,
        is_symbolic: false,
      };
    },
  },

  // Symmetric error: 125.09 ± 0.24 GeV
  {
    type: 'symmetric',
    pattern: new RegExp(`${FULL_NUM}${PM}${FULL_NUM}(?:\\s*([A-Za-z/%]+))?`, 'g'),
    extractor: (m, ctx) => {
      const value = parseFloat(m[1]);
      const err = parseFloat(m[2]);
      const unit = m[3];
      return {
        raw: m[0],
        type: 'symmetric',
        value,
        uncertainties: [{
          type: 'total',
          plus: err,
          minus: err,
        }],
        unit,
        context: ctx,
        is_symbolic: false,
      };
    },
  },

  // Upper limit: < 2.4 MeV (90% CL)
  {
    type: 'upper_limit',
    pattern: new RegExp(`[<≤]\\s*${FULL_NUM}(?:\\s*([A-Za-z/%]+))?(?:\\s*\\(?\\s*(\\d+)\\s*%\\s*(?:C\\.?L\\.?|CL|confidence)\\s*\\)?)?`, 'gi'),
    extractor: (m, ctx) => {
      const value = parseFloat(m[1]);
      const unit = m[2];
      const cl = m[3] ? `${m[3]}% CL` : undefined;
      return {
        raw: m[0],
        type: 'upper_limit',
        value,
        unit,
        confidence_level: cl,
        context: ctx,
        is_symbolic: false,
      };
    },
  },

  // Lower limit: > 1.0 GeV
  {
    type: 'lower_limit',
    pattern: new RegExp(`[>≥]\\s*${FULL_NUM}(?:\\s*([A-Za-z/%]+))?`, 'g'),
    extractor: (m, ctx) => {
      const value = parseFloat(m[1]);
      const unit = m[2];
      return {
        raw: m[0],
        type: 'lower_limit',
        value,
        unit,
        context: ctx,
        is_symbolic: false,
      };
    },
  },

  // Range: -20 < E < 20 MeV  or  1.0 - 2.0 GeV
  {
    type: 'range',
    pattern: new RegExp(`${FULL_NUM}\\s*[<≤]\\s*[A-Za-z_]+\\s*[<≤]\\s*${FULL_NUM}(?:\\s*([A-Za-z/%]+))?`, 'g'),
    extractor: (m, ctx) => {
      const lower = parseFloat(m[1]);
      const upper = parseFloat(m[2]);
      const unit = m[3];
      return {
        raw: m[0],
        type: 'range',
        value: (lower + upper) / 2,
        range: {
          lower,
          upper,
          lower_inclusive: m[0].includes('≤'),
          upper_inclusive: m[0].includes('≤'),
        },
        unit,
        context: ctx,
        is_symbolic: false,
      };
    },
  },

  // Chi-squared: χ²/ndf = 0.49/3 or chi2/ndf
  {
    type: 'chi_squared',
    pattern: /(?:χ²|\\chi\^?\{?2\}?|chi2?)(?:\s*\/\s*(?:n\.?d\.?f\.?|ndf))?\s*[=:]\s*([\d.]+)(?:\s*\/\s*(\d+))?/gi,
    extractor: (m, ctx) => {
      const chi2 = parseFloat(m[1]);
      const ndf = m[2] ? parseInt(m[2]) : undefined;
      return {
        raw: m[0],
        type: 'chi_squared',
        value: ndf ? chi2 / ndf : chi2,
        context: ctx,
        is_symbolic: false,
      };
    },
  },

  // Significance: 6.3σ or 5 sigma
  {
    type: 'significance',
    pattern: /([\d.]+)\s*(?:σ|\\sigma|sigma)/gi,
    extractor: (m, ctx) => {
      const value = parseFloat(m[1]);
      return {
        raw: m[0],
        type: 'significance',
        value,
        context: ctx,
        is_symbolic: false,
      };
    },
  },

  // p-value: p < 0.01 or p-value = 0.05
  {
    type: 'p_value',
    pattern: /p(?:-value)?\s*[<>=]\s*([\d.eE+-]+)/gi,
    extractor: (m, ctx) => {
      const value = parseFloat(m[1]);
      return {
        raw: m[0],
        type: 'p_value',
        value,
        context: ctx,
        is_symbolic: false,
      };
    },
  },

  // Confidence level: 90% CL, 95% confidence
  {
    type: 'confidence',
    pattern: /(\d+)\s*%\s*(?:C\.?L\.?|CL|confidence)/gi,
    extractor: (m, ctx) => {
      const value = parseInt(m[1]);
      return {
        raw: m[0],
        type: 'confidence',
        value,
        confidence_level: `${value}%`,
        context: ctx,
        is_symbolic: false,
      };
    },
  },

  // Ratio: (5.2±1.9)×10^{-3}
  {
    type: 'ratio',
    pattern: /\(?\s*([\d.]+)\s*(?:\\pm|±)\s*([\d.]+)\s*\)?\s*[×x]\s*10\^?\{?(-?\d+)\}?/gi,
    extractor: (m, ctx) => {
      const mantissa = parseFloat(m[1]);
      const errMantissa = parseFloat(m[2]);
      const exp = parseInt(m[3]);
      const value = mantissa * Math.pow(10, exp);
      const err = errMantissa * Math.pow(10, exp);
      return {
        raw: m[0],
        type: 'ratio',
        value,
        uncertainties: [{
          type: 'total',
          plus: err,
          minus: err,
        }],
        exponent: exp,
        context: ctx,
        is_symbolic: false,
      };
    },
  },

  // Approximate: ~100 GeV, O(1) GeV
  {
    type: 'approximate',
    pattern: /(?:~|\\sim|\\approx|O\s*\()?\s*([\d.]+)\s*\)?(?:\s*([A-Za-z/%]+))?/gi,
    extractor: (m, ctx) => {
      // Only match if preceded by ~, \sim, or O(
      if (!m[0].match(/^[~≈]|\\sim|\\approx|O\s*\(/i)) {
        return null;
      }
      const value = parseFloat(m[1]);
      const unit = m[2];
      return {
        raw: m[0],
        type: 'approximate',
        value,
        unit,
        context: ctx,
        is_symbolic: false,
      };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Main Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract all HEP numbers from text
 *
 * @param text - LaTeX or plain text
 * @returns Array of extracted HEP numbers
 */
export function extractHEPNumbers(text: string): HEPNumber[] {
  const results: HEPNumber[] = [];
  const seen = new Set<string>();

  // Get context sentences
  const sentences = text.split(/[.!?]\s+/);
  let currentContext = '';

  for (const sentence of sentences) {
    currentContext = sentence.slice(0, 200);

    for (const { pattern, extractor } of PATTERNS) {
      // Reset pattern lastIndex
      pattern.lastIndex = 0;

      let match;
      while ((match = pattern.exec(sentence)) !== null) {
        const num = extractor(match, currentContext);
        if (num && !seen.has(num.raw)) {
          seen.add(num.raw);
          results.push(num);
        }
      }
    }
  }

  return results;
}

/**
 * Extract numbers from a specific chunk
 */
export function extractNumbersFromChunk(
  latex: string,
  text: string
): HEPNumber[] {
  // Try LaTeX first (more structured)
  let numbers = extractHEPNumbers(latex);

  // If no numbers found, try plain text
  if (numbers.length === 0) {
    numbers = extractHEPNumbers(text);
  }

  return numbers;
}

// ─────────────────────────────────────────────────────────────────────────────
// Number Comparison
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if two numbers are compatible within uncertainties
 *
 * @param a - First number
 * @param b - Second number
 * @param tolerance - Number of sigma for compatibility (default: 2)
 * @returns Whether the numbers are compatible
 */
export function areNumbersCompatible(
  a: HEPNumber,
  b: HEPNumber,
  tolerance: number = 2
): boolean {
  // Skip symbolic numbers
  if (a.is_symbolic || b.is_symbolic) {
    return true;
  }

  // Different types may not be directly comparable
  if (a.type !== b.type) {
    // But values might still match
    if (Math.abs(a.value - b.value) / Math.max(Math.abs(a.value), 1e-10) < 0.001) {
      return true;
    }
  }

  // Get total uncertainties
  const errA = getTotalUncertainty(a);
  const errB = getTotalUncertainty(b);

  // Calculate tension
  const diff = Math.abs(a.value - b.value);
  const combinedErr = Math.sqrt(errA * errA + errB * errB);

  if (combinedErr === 0) {
    // Exact match required if no uncertainties
    return Math.abs(a.value - b.value) < 1e-10;
  }

  const tension = diff / combinedErr;
  return tension <= tolerance;
}

/**
 * Get total uncertainty (combine all components in quadrature)
 */
function getTotalUncertainty(num: HEPNumber): number {
  if (!num.uncertainties || num.uncertainties.length === 0) {
    return 0;
  }

  let sumSquares = 0;
  for (const unc of num.uncertainties) {
    // Use average of plus and minus
    const avg = (unc.plus + unc.minus) / 2;
    sumSquares += avg * avg;
  }

  return Math.sqrt(sumSquares);
}

/**
 * Calculate tension between two measurements
 *
 * @returns Tension in sigma units
 */
export function calculateTension(a: HEPNumber, b: HEPNumber): number {
  const errA = getTotalUncertainty(a);
  const errB = getTotalUncertainty(b);
  const combinedErr = Math.sqrt(errA * errA + errB * errB);

  if (combinedErr === 0) {
    return a.value === b.value ? 0 : Infinity;
  }

  return Math.abs(a.value - b.value) / combinedErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Number Matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find matching numbers between source and generated text
 *
 * @param sourceNumbers - Numbers from source evidence
 * @param generatedNumbers - Numbers from generated text
 * @returns Matching results
 */
export function matchNumbers(
  sourceNumbers: HEPNumber[],
  generatedNumbers: HEPNumber[]
): {
  matched: { source: HEPNumber; generated: HEPNumber; tension: number }[];
  unmatched_source: HEPNumber[];
  unmatched_generated: HEPNumber[];
} {
  const matched: { source: HEPNumber; generated: HEPNumber; tension: number }[] = [];
  const usedSource = new Set<number>();
  const usedGenerated = new Set<number>();

  // Match by value and type
  for (let gi = 0; gi < generatedNumbers.length; gi++) {
    const gen = generatedNumbers[gi];
    let bestMatch: { idx: number; tension: number } | null = null;

    for (let si = 0; si < sourceNumbers.length; si++) {
      if (usedSource.has(si)) continue;
      const src = sourceNumbers[si];

      // Check unit compatibility
      if (gen.unit && src.unit && !areUnitsCompatible(gen.unit, src.unit)) {
        continue;
      }

      const tension = calculateTension(src, gen);
      if (tension <= 3 && (!bestMatch || tension < bestMatch.tension)) {
        bestMatch = { idx: si, tension };
      }
    }

    if (bestMatch) {
      matched.push({
        source: sourceNumbers[bestMatch.idx],
        generated: gen,
        tension: bestMatch.tension,
      });
      usedSource.add(bestMatch.idx);
      usedGenerated.add(gi);
    }
  }

  // Collect unmatched
  const unmatched_source = sourceNumbers.filter((_, i) => !usedSource.has(i));
  const unmatched_generated = generatedNumbers.filter((_, i) => !usedGenerated.has(i));

  return { matched, unmatched_source, unmatched_generated };
}

/**
 * Check if units are compatible (same dimension)
 */
function areUnitsCompatible(a: string, b: string): boolean {
  const normalize = (u: string) =>
    u.toLowerCase()
      .replace(/\\mathrm\{([^}]+)\}/g, '$1')
      .replace(/\^?\{?-?1\}?/g, '')
      .trim();

  return normalize(a) === normalize(b);
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbolic Variable Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a text represents a symbolic variable (should skip verification)
 *
 * Examples: m_X, Γ_tot, σ_0, E_cm
 */
export function isSymbolicVariable(text: string): boolean {
  // Common symbolic patterns
  const symbolicPatterns = [
    /^[mMΓγσ]_\{?[A-Za-z0-9]+\}?$/,  // m_X, Γ_tot
    /^[EMPT]_\{?[A-Za-z]+\}?$/,       // E_cm, P_T
    /^\\[A-Za-z]+$/,                   // \sqrt{s}, \Lambda
    /^[α-ωΑ-Ω]$/,                      // Single Greek letter
  ];

  for (const pattern of symbolicPatterns) {
    if (pattern.test(text.trim())) {
      return true;
    }
  }

  return false;
}

/**
 * Mark symbolic variables in extracted numbers
 */
export function markSymbolicVariables(numbers: HEPNumber[]): HEPNumber[] {
  return numbers.map((num) => ({
    ...num,
    is_symbolic: isSymbolicVariable(num.raw) || num.is_symbolic,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format HEP number for display
 */
export function formatHEPNumber(num: HEPNumber): string {
  const parts: string[] = [];

  switch (num.type) {
    case 'symmetric':
      parts.push(`${num.value} ± ${num.uncertainties?.[0]?.plus ?? '?'}`);
      break;
    case 'asymmetric':
      parts.push(`${num.value}^{+${num.uncertainties?.[0]?.plus}}_{-${num.uncertainties?.[0]?.minus}}`);
      break;
    case 'upper_limit':
      parts.push(`< ${num.value}`);
      break;
    case 'lower_limit':
      parts.push(`> ${num.value}`);
      break;
    case 'range':
      parts.push(`${num.range?.lower} - ${num.range?.upper}`);
      break;
    case 'chi_squared':
      parts.push(`χ²/ndf = ${num.value}`);
      break;
    case 'significance':
      parts.push(`${num.value}σ`);
      break;
    default:
      parts.push(String(num.value));
  }

  if (num.unit) {
    parts.push(` ${num.unit}`);
  }

  if (num.confidence_level) {
    parts.push(` (${num.confidence_level})`);
  }

  return parts.join('');
}
