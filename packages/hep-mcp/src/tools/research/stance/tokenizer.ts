/**
 * Tokenizer and Sentence Splitter
 *
 * Handles text tokenization with placeholder protection and sentence splitting.
 */

import { NEGATION_WORDS } from './patterns.js';
import { DEFAULT_STANCE_CONFIG } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Placeholder pattern for cite commands */
export const CITE_PLACEHOLDER_PATTERN = /__CITE_\d+_[^_]+__/g;

// ─────────────────────────────────────────────────────────────────────────────
// Tokenization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tokenize text with placeholder protection (R5.6)
 * Placeholders are preserved as single tokens
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const placeholderPattern = /__CITE_\d+_[^_]+__/g;

  let lastIndex = 0;
  let match;
  while ((match = placeholderPattern.exec(text)) !== null) {
    // Process text before placeholder
    if (match.index > lastIndex) {
      tokens.push(...tokenizeNormal(text.slice(lastIndex, match.index)));
    }
    // Placeholder as single token
    tokens.push(match[0]);
    lastIndex = match.index + match[0].length;
  }
  // Process remaining text
  if (lastIndex < text.length) {
    tokens.push(...tokenizeNormal(text.slice(lastIndex)));
  }
  return tokens;
}

/**
 * Normal tokenization (without placeholder handling)
 */
function tokenizeNormal(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+|[0-9]+(?:\.[0-9]+)?|σ|%|[^\s]/g) || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Negation Scope Detection
// ─────────────────────────────────────────────────────────────────────────────

export interface NegationResult {
  negated: boolean;
  negationWord?: string;
}

/**
 * Check if pattern is in negation scope
 */
export function isInNegationScope(
  tokens: string[],
  patternStartIndex: number,
  windowSize: number = DEFAULT_STANCE_CONFIG.negationWindowSize
): NegationResult {
  const searchStart = Math.max(0, patternStartIndex - windowSize);

  for (let i = searchStart; i < patternStartIndex; i++) {
    const token = tokens[i];

    // Single word negation
    if (NEGATION_WORDS.includes(token)) {
      return { negated: true, negationWord: token };
    }

    // Multi-word negation phrases
    if (token === 'can' && tokens[i + 1] === 'not') {
      return { negated: true, negationWord: 'can not' };
    }
    if (token === 'lack' && tokens[i + 1] === 'of') {
      return { negated: true, negationWord: 'lack of' };
    }
    if (token === 'absence' && tokens[i + 1] === 'of') {
      return { negated: true, negationWord: 'absence of' };
    }
  }

  return { negated: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentence Splitting
// ─────────────────────────────────────────────────────────────────────────────

/** Common abbreviations to protect during sentence splitting */
const ABBREVIATIONS = /(?:e\.g\.|i\.e\.|et al\.|Fig\.|Eq\.|Ref\.|vs\.|etc\.|cf\.|Phys\.|Rev\.|Lett\.|Nucl\.)/gi;
const PLACEHOLDER = '<<<ABB>>>';

/**
 * Split text into sentences
 * Uses Intl.Segmenter if available, falls back to regex
 */
export function splitIntoSentences(text: string): string[] {
  // Try Intl.Segmenter (Node 18+)
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    try {
      const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
      const segments = segmenter.segment(text);
      return Array.from(segments, s => s.segment.trim()).filter(s => s.length > 0);
    } catch {
      // fallback
    }
  }

  // Fallback: regex splitting with abbreviation protection
  let processed = text.replace(ABBREVIATIONS, match =>
    match.replace(/\./g, PLACEHOLDER)
  );

  const sentences = processed
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map(s => s.replace(new RegExp(PLACEHOLDER, 'g'), '.').trim())
    .filter(s => s.length > 10);

  return sentences;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clause Splitting (R4.7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split sentence by clauses (enhanced version)
 * First by strong separators, then by contrast words
 */
export function splitByClauses(sentence: string): string[] {
  // 1. Split by strong separators
  const blocks = sentence.split(/\s*[;:—]\s*/);

  // 2. Split within blocks by contrast words
  const clauses: string[] = [];
  for (const block of blocks) {
    const subClauses = block.split(/\s*(?:,\s*)?(?:but|however|whereas|although|while)\s+/i);
    clauses.push(...subClauses);
  }

  return clauses.filter(c => c.trim().length > 0);
}

/**
 * Check if next sentence should be included (pronoun reference)
 */
export function shouldIncludeNextSentence(nextSentence: string): boolean {
  return /^(This|It|Such|However|But|Nevertheless|These|That)/i.test(nextSentence);
}
