/**
 * Citation Context Extractor
 *
 * Extracts citation contexts from LaTeX source code.
 * Implements R5.1 placeholder strategy and R4.1 span tracking.
 */

import type { CitationContext } from './types.js';
import { splitIntoSentences, shouldIncludeNextSentence } from './tokenizer.js';
import { getSectionWeight } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Placeholder prefix for cite commands */
export const CITE_PLACEHOLDER_PREFIX = '__CITE_';
export const CITE_PLACEHOLDER_SUFFIX = '__';

/** Cite command pattern (covers biblatex/natbib variants) */
export const CITE_PATTERN = /\\[a-zA-Z]*cite[a-zA-Z*]*\s*(?:\[[^\]]*\]){0,2}\s*\{([^}]+)\}/g;

// ─────────────────────────────────────────────────────────────────────────────
// Placeholder Replacement (R5.1)
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaceholderResult {
  /** Text with placeholders */
  result: string;
  /** Map from placeholder to citekey */
  placeholderToKey: Map<string, string>;
  /** Map from citekey to placeholder positions */
  keyToPlaceholders: Map<string, string[]>;
}

/**
 * Replace cite commands with placeholders (R5.1)
 * Each citekey gets its own placeholder: \cite{a,b,c} → __CITE_0_a__ __CITE_0_b__ __CITE_0_c__
 */
export function replaceCitesWithPlaceholders(latex: string): PlaceholderResult {
  let index = 0;
  const placeholderToKey = new Map<string, string>();
  const keyToPlaceholders = new Map<string, string[]>();

  const result = latex.replace(CITE_PATTERN, (_match, keys: string) => {
    const citekeys = keys.split(',').map((k: string) => k.trim());

    // Each citekey gets its own placeholder
    const placeholders = citekeys.map((key: string) => {
      const placeholder = `${CITE_PLACEHOLDER_PREFIX}${index}_${key}${CITE_PLACEHOLDER_SUFFIX}`;
      index++;

      placeholderToKey.set(placeholder, key);

      // Track all placeholders for each key
      const existing = keyToPlaceholders.get(key) || [];
      existing.push(placeholder);
      keyToPlaceholders.set(key, existing);

      return placeholder;
    });

    return placeholders.join(' ');
  });

  return { result, placeholderToKey, keyToPlaceholders };
}

// ─────────────────────────────────────────────────────────────────────────────
// LaTeX Cleaning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clean LaTeX commands while preserving placeholders
 */
export function cleanLatexPreservingPlaceholders(latex: string): string {
  let text = latex;

  // Remove comments
  text = text.replace(/%[^\n]*/g, '');

  // Remove common LaTeX commands (but not placeholders)
  text = text.replace(/\\(?:textbf|textit|emph|textrm|textsc)\{([^}]*)\}/g, '$1');
  text = text.replace(/\\(?:section|subsection|subsubsection)\*?\{[^}]*\}/g, '');
  text = text.replace(/\\(?:label|ref|eqref)\{[^}]*\}/g, '');
  text = text.replace(/\\(?:begin|end)\{[^}]*\}/g, '');

  // Remove math environments (simple)
  text = text.replace(/\$[^$]+\$/g, '[MATH]');
  text = text.replace(/\\\[[^\]]+\\\]/g, '[MATH]');

  // Remove remaining backslash commands (but preserve placeholders)
  text = text.replace(/\\[a-zA-Z]+(?:\[[^\]]*\])?(?:\{[^}]*\})?/g, (match) => {
    if (match.includes(CITE_PLACEHOLDER_PREFIX)) return match;
    return '';
  });

  // Clean up whitespace (preserve single spaces between placeholders)
  text = text.replace(/\s+/g, ' ');
  text = text.trim();

  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section Detection
// ─────────────────────────────────────────────────────────────────────────────

/** Section pattern */
const SECTION_PATTERN = /\\(?:section|subsection|subsubsection)\*?\{([^}]+)\}/g;

/**
 * Detect current section name at a given position
 */
export function detectSectionAtPosition(latex: string, position: number): string | undefined {
  let lastSection: string | undefined;
  let match;

  SECTION_PATTERN.lastIndex = 0;
  while ((match = SECTION_PATTERN.exec(latex)) !== null) {
    if (match.index > position) break;
    lastSection = match[1];
  }

  return lastSection;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Extraction (Regex Mode)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract citation contexts from LaTeX using regex
 */
export function extractCitationContextsFromRegex(
  latex: string,
  targetCitekeys: string[]
): CitationContext[] {
  const contexts: CitationContext[] = [];

  // Step 1: Replace cites with placeholders
  const { result: textWithPlaceholders, keyToPlaceholders } = replaceCitesWithPlaceholders(latex);

  // Step 2: Clean LaTeX while preserving placeholders
  const cleanText = cleanLatexPreservingPlaceholders(textWithPlaceholders);

  // Step 3: Split into sentences
  const sentences = splitIntoSentences(cleanText);

  // Step 4: Find sentences containing target citekeys
  for (const targetKey of targetCitekeys) {
    const placeholders = keyToPlaceholders.get(targetKey) || [];

    for (const placeholder of placeholders) {
      // Find sentence containing this placeholder
      for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i];
        if (!sentence.includes(placeholder)) continue;

        // Get extended context (prev + current + next)
        const prevSentence = i > 0 ? sentences[i - 1] : '';
        const nextSentence = i < sentences.length - 1 ? sentences[i + 1] : '';

        // Check if next sentence should be included
        const includeNext = nextSentence && shouldIncludeNextSentence(nextSentence);

        // Find other citekeys in same sentence
        const otherKeys = findOtherCitekeysInSentence(sentence, targetKey, keyToPlaceholders);

        // Detect section
        const originalPos = latex.indexOf(targetKey);
        const section = detectSectionAtPosition(latex, originalPos);

        contexts.push({
          sentence: cleanPlaceholdersFromText(sentence),
          extendedContext: cleanPlaceholdersFromText(
            [prevSentence, sentence, includeNext ? nextSentence : ''].filter(Boolean).join(' ')
          ),
          citekey: targetKey,
          rawLatex: extractRawLatexAround(latex, targetKey),
          section,
          sectionWeight: section ? getSectionWeight(section) : 1.0,
          otherCitekeysInSentence: otherKeys,
          isMultiCite: otherKeys.length > 0,
          extractionMode: 'regex',
        });
      }
    }
  }

  return contexts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/** Find other citekeys in the same sentence */
function findOtherCitekeysInSentence(
  sentence: string,
  targetKey: string,
  keyToPlaceholders: Map<string, string[]>
): string[] {
  const others: string[] = [];

  for (const [key, placeholders] of keyToPlaceholders) {
    if (key === targetKey) continue;
    if (placeholders.some(p => sentence.includes(p))) {
      others.push(key);
    }
  }

  return others;
}

/** Clean placeholders from text, replacing with [REF] */
function cleanPlaceholdersFromText(text: string): string {
  return text.replace(/__CITE_\d+_[^_]+__/g, '[REF]').trim();
}

/** Extract raw LaTeX around a citekey */
function extractRawLatexAround(latex: string, citekey: string, windowSize: number = 200): string {
  const idx = latex.indexOf(citekey);
  if (idx === -1) return '';

  const start = Math.max(0, idx - windowSize);
  const end = Math.min(latex.length, idx + citekey.length + windowSize);

  return latex.slice(start, end);
}
