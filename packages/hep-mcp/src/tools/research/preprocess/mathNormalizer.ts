/**
 * Math Environment Normalizer
 * Normalizes various LaTeX math environments to a consistent format
 */

import type { NormalizedMath, MathEnvType } from './types.js';
import { getLineAtPosition } from './utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Math environment type mappings
 */
const ENV_TYPE_MAP: Record<string, MathEnvType> = {
  // Display math
  'equation': 'display',
  'equation*': 'display',
  'displaymath': 'display',
  // Align environments
  'align': 'align',
  'align*': 'align',
  'eqnarray': 'align',
  'eqnarray*': 'align',
  'alignat': 'align',
  'alignat*': 'align',
  'flalign': 'align',
  'flalign*': 'align',
  // Gather environments
  'gather': 'gather',
  'gather*': 'gather',
  // Multline
  'multline': 'multline',
  'multline*': 'multline',
  // Split (usually inside other envs)
  'split': 'split',
  // Cases
  'cases': 'cases',
  // Array/matrix
  'array': 'array',
  'matrix': 'array',
  'pmatrix': 'array',
  'bmatrix': 'array',
  'vmatrix': 'array',
  'Vmatrix': 'array',
  'smallmatrix': 'array',
  // Subequations wrapper
  'subequations': 'subequations',
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract label from math content
 */
function extractLabel(content: string): string | undefined {
  const match = content.match(/\\label\{([^}]+)\}/);
  return match ? match[1] : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline Math Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract inline math ($...$)
 */
function extractInlineMath(content: string): NormalizedMath[] {
  const results: NormalizedMath[] = [];

  // Match $...$ but not $$...$$ (use [\s\S] to match newlines)
  const regex = /(?<!\$)\$(?!\$)([\s\S]+?)\$(?!\$)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const startLine = getLineAtPosition(content, match.index);
    const endLine = getLineAtPosition(content, match.index + match[0].length);

    results.push({
      type: 'inline',
      content: match[1],
      lineRange: [startLine, endLine],
      originalEnv: '$...$',
    });
  }

  // Also match \(...\) - use balanced matching for nested parens
  const parenRegex = /\\\(([\s\S]*?)\\\)/g;
  while ((match = parenRegex.exec(content)) !== null) {
    const startLine = getLineAtPosition(content, match.index);
    const endLine = getLineAtPosition(content, match.index + match[0].length);

    results.push({
      type: 'inline',
      content: match[1],
      lineRange: [startLine, endLine],
      originalEnv: '\\(...\\)',
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Display Math Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract display math ($$...$$ and \[...\])
 */
function extractDisplayMath(content: string): NormalizedMath[] {
  const results: NormalizedMath[] = [];

  // Match $$...$$
  const doubleDollarRegex = /\$\$([\s\S]*?)\$\$/g;
  let match;

  while ((match = doubleDollarRegex.exec(content)) !== null) {
    const startLine = getLineAtPosition(content, match.index);
    const endLine = getLineAtPosition(content, match.index + match[0].length);

    results.push({
      type: 'display',
      content: match[1].trim(),
      label: extractLabel(match[1]),
      lineRange: [startLine, endLine],
      originalEnv: '$$...$$',
    });
  }

  // Match \[...\]
  const bracketRegex = /\\\[([\s\S]*?)\\\]/g;
  while ((match = bracketRegex.exec(content)) !== null) {
    const startLine = getLineAtPosition(content, match.index);
    const endLine = getLineAtPosition(content, match.index + match[0].length);

    results.push({
      type: 'display',
      content: match[1].trim(),
      label: extractLabel(match[1]),
      lineRange: [startLine, endLine],
      originalEnv: '\\[...\\]',
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment Math Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract math from \begin{env}...\end{env}
 */
function extractEnvMath(content: string): NormalizedMath[] {
  const results: NormalizedMath[] = [];
  const envNames = Object.keys(ENV_TYPE_MAP).join('|');
  const regex = new RegExp(
    `\\\\begin\\{(${envNames})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`,
    'g'
  );

  let match;
  while ((match = regex.exec(content)) !== null) {
    const envName = match[1];
    const envContent = match[2];
    const startLine = getLineAtPosition(content, match.index);
    const endLine = getLineAtPosition(content, match.index + match[0].length);

    results.push({
      type: ENV_TYPE_MAP[envName] || 'display',
      content: envContent.trim(),
      label: extractLabel(envContent),
      lineRange: [startLine, endLine],
      originalEnv: envName,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Export Functions
// ─────────────────────────────────────────────────────────────────────────────

export interface NormalizeMathOptions {
  /** Include inline math (default: false for performance) */
  includeInline?: boolean;
}

/**
 * Extract and normalize all math environments from content
 */
export function extractMathBlocks(
  content: string,
  options: NormalizeMathOptions = {}
): NormalizedMath[] {
  const { includeInline = false } = options;

  const results: NormalizedMath[] = [];

  // Extract environment-based math first (most common in papers)
  results.push(...extractEnvMath(content));

  // Extract display math ($$...$$ and \[...\])
  results.push(...extractDisplayMath(content));

  // Optionally extract inline math
  if (includeInline) {
    results.push(...extractInlineMath(content));
  }

  // Sort by line number
  results.sort((a, b) => a.lineRange[0] - b.lineRange[0]);

  return results;
}

/**
 * Normalize math delimiters in content
 * Converts $$...$$ to \[...\] for consistency
 */
export function normalizeMathDelimiters(content: string): string {
  let result = content;

  // Convert $$...$$ to \[...\]
  result = result.replace(/\$\$([\s\S]*?)\$\$/g, '\\[$1\\]');

  return result;
}
