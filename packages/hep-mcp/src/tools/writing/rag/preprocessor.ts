/**
 * Dual Text Preprocessor
 *
 * Handles macro expansion while preserving byte offset mapping.
 * Critical for accurate Locator tracking after normalization.
 *
 * Key features:
 * - Streaming replacement with offset tracking
 * - Binary search for offset mapping
 * - Entity macro extraction for retrieval enhancement
 *
 * @module rag/preprocessor
 */

import type {
  DualTextResult,
  MappingEntry,
  MacroRegistry,
  OffsetMapping,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Built-in environment macros (common in HEP papers)
 */
const BUILTIN_ENV_MACROS: Record<string, string> = {
  '\\be': '\\begin{equation}',
  '\\ee': '\\end{equation}',
  '\\bea': '\\begin{eqnarray}',
  '\\eea': '\\end{eqnarray}',
  '\\ba': '\\begin{align}',
  '\\ea': '\\end{align}',
  '\\beq': '\\begin{equation}',
  '\\eeq': '\\end{equation}',
};

// ─────────────────────────────────────────────────────────────────────────────
// Macro Registry Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract macro registry from LaTeX content
 *
 * Recognized patterns:
 * - \newcommand{\x}{X(3872)}
 * - \def\x{X(3872)}
 * - \renewcommand{\x}{X(3872)}
 */
export function extractMacroRegistry(content: string): MacroRegistry {
  const simple = new Map<string, string>();
  const entityExpansions: string[] = [];

  // 1. Add built-in environment macros
  for (const [k, v] of Object.entries(BUILTIN_ENV_MACROS)) {
    simple.set(k, v);
  }

  // 2. \newcommand{\x}{X(3872)} - entity macros (critical for BESIII papers)
  // Matches: \newcommand{\cmd}{...} and \newcommand*{\cmd}{...}
  const ncPattern = /\\(?:new|renew)command\*?\{(\\[a-zA-Z]+)\}(?:\[\d+\])?\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  let match;
  while ((match = ncPattern.exec(content)) !== null) {
    const [, macro, expansion] = match;
    // Only add simple macros (no arguments)
    if (!match[0].includes('[')) {
      simple.set(macro, expansion);
      // Record entity expansions for retrieval enhancement
      // Skip environment macros (they start with \begin)
      if (!expansion.startsWith('\\begin')) {
        entityExpansions.push(expansion);
      }
    }
  }

  // 3. \def\x{...}
  const defPattern = /\\def(\\[a-zA-Z]+)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  while ((match = defPattern.exec(content)) !== null) {
    const [, macro, expansion] = match;
    simple.set(macro, expansion);
    if (!expansion.startsWith('\\begin')) {
      entityExpansions.push(expansion);
    }
  }

  // 4. Common HEP unit macros (if not already defined)
  const commonUnits: Record<string, string> = {
    '\\eV': '\\mathrm{eV}',
    '\\GeV': '\\mathrm{GeV}',
    '\\TeV': '\\mathrm{TeV}',
    '\\MeV': '\\mathrm{MeV}',
    '\\keV': '\\mathrm{keV}',
    '\\barn': '\\mathrm{barn}',
    '\\mb': '\\mathrm{mb}',
    '\\ub': '\\mathrm{ub}',
    '\\mub': '\\mathrm{\\mu b}',
    '\\nb': '\\mathrm{nb}',
    '\\fb': '\\mathrm{fb}^{-1}',
    '\\pb': '\\mathrm{pb}^{-1}',
    '\\ab': '\\mathrm{ab}^{-1}',
    '\\EE': 'e^+e^-',
  };
  for (const [k, v] of Object.entries(commonUnits)) {
    if (!simple.has(k)) {
      simple.set(k, v);
    }
  }

  return { simple, entityExpansions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming Expansion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Streaming macro expansion with offset tracking
 *
 * Key features:
 * - Single pass expansion
 * - Precise offset mapping construction
 * - Macros sorted by length (avoid short macro matching long macro prefix)
 */
function streamingExpand(
  rawTex: string,
  macros: Map<string, string>
): { normTex: string; mappings: MappingEntry[] } {
  if (macros.size === 0) {
    return { normTex: rawTex, mappings: [] };
  }

  // Sort macros by length descending (avoid short macro matching long macro prefix)
  const sortedMacros = [...macros.entries()].sort(
    (a, b) => b[0].length - a[0].length
  );

  // Build macro pattern (escape backslashes, require word boundary)
  const escapedMacros = sortedMacros.map(([k]) =>
    k.replace(/\\/g, '\\\\')
  );
  const macroPattern = new RegExp(
    escapedMacros.join('|') + '(?![a-zA-Z])',
    'g'
  );

  const mappings: MappingEntry[] = [];
  const normParts: string[] = [];
  let lastRawEnd = 0;
  let normOffset = 0;

  let match;
  while ((match = macroPattern.exec(rawTex)) !== null) {
    const rawStart = match.index;
    const macroText = match[0];
    const expansion = macros.get(macroText) || macroText;

    // Add text before this macro
    if (rawStart > lastRawEnd) {
      const textBefore = rawTex.slice(lastRawEnd, rawStart);
      normParts.push(textBefore);
      normOffset += textBefore.length;
    }

    // Record mapping
    mappings.push({
      rawStart,
      rawEnd: rawStart + macroText.length,
      normStart: normOffset,
      normEnd: normOffset + expansion.length,
    });

    // Add expanded text
    normParts.push(expansion);
    normOffset += expansion.length;
    lastRawEnd = rawStart + macroText.length;
  }

  // Add remaining text
  if (lastRawEnd < rawTex.length) {
    normParts.push(rawTex.slice(lastRawEnd));
  }

  return { normTex: normParts.join(''), mappings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Offset Mapping (Binary Search Optimized)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build offset mapping with binary search support
 */
function buildOffsetMap(mappings: MappingEntry[]): OffsetMapping {
  // Sort by normStart for toRaw lookup
  const sortedByNorm = [...mappings].sort((a, b) => a.normStart - b.normStart);
  // Sort by rawStart for toNorm lookup
  const sortedByRaw = [...mappings].sort((a, b) => a.rawStart - b.rawStart);

  // Pre-compute cumulative adjustments for binary search
  const normAdjustments: { offset: number; adjustment: number }[] = [];
  let cumulativeAdj = 0;
  for (const m of sortedByNorm) {
    cumulativeAdj += (m.rawEnd - m.rawStart) - (m.normEnd - m.normStart);
    normAdjustments.push({ offset: m.normEnd, adjustment: cumulativeAdj });
  }

  const rawAdjustments: { offset: number; adjustment: number }[] = [];
  cumulativeAdj = 0;
  for (const m of sortedByRaw) {
    cumulativeAdj += (m.normEnd - m.normStart) - (m.rawEnd - m.rawStart);
    rawAdjustments.push({ offset: m.rawEnd, adjustment: cumulativeAdj });
  }

  return {
    toRaw(normOffset: number): number {
      // Binary search for the mapping that contains this offset
      for (const m of sortedByNorm) {
        if (normOffset < m.normStart) {
          // Before any mapping - use cumulative adjustment
          const adj = findAdjustment(normAdjustments, normOffset);
          return normOffset + adj;
        }
        if (normOffset >= m.normStart && normOffset < m.normEnd) {
          // Inside a mapping - map to macro start
          return m.rawStart;
        }
      }
      // After all mappings
      const adj = normAdjustments.length > 0
        ? normAdjustments[normAdjustments.length - 1].adjustment
        : 0;
      return normOffset + adj;
    },

    toNorm(rawOffset: number): number {
      for (const m of sortedByRaw) {
        if (rawOffset < m.rawStart) {
          const adj = findAdjustment(rawAdjustments, rawOffset);
          return rawOffset + adj;
        }
        if (rawOffset >= m.rawStart && rawOffset < m.rawEnd) {
          return m.normStart;
        }
      }
      const adj = rawAdjustments.length > 0
        ? rawAdjustments[rawAdjustments.length - 1].adjustment
        : 0;
      return rawOffset + adj;
    },
  };
}

/**
 * Binary search for cumulative adjustment at offset
 */
function findAdjustment(
  adjustments: { offset: number; adjustment: number }[],
  offset: number
): number {
  let lo = 0;
  let hi = adjustments.length - 1;
  let result = 0;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (adjustments[mid].offset <= offset) {
      result = adjustments[mid].adjustment;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Preprocess LaTeX content with dual text strategy
 *
 * - Extracts and expands macros
 * - Builds offset mapping for locator tracking
 * - Returns both raw and normalized text
 *
 * @param content - Raw LaTeX content
 * @returns DualTextResult with rawTex, normTex, and offsetMap
 */
export function preprocessDualText(content: string): DualTextResult {
  const rawTex = content;
  const macroRegistry = extractMacroRegistry(content);

  // Streaming expand with mapping
  const { normTex, mappings } = streamingExpand(rawTex, macroRegistry.simple);

  // Build offset map
  const offsetMap = buildOffsetMap(mappings);

  return { rawTex, normTex, offsetMap, macroRegistry };
}

// ─────────────────────────────────────────────────────────────────────────────
// LaTeX Project Utilities (borrowed from arxiv-to-prompt)
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';

/**
 * Common main file names (priority order)
 */
const COMMON_MAIN_NAMES = [
  'main.tex',
  'paper.tex',
  'index.tex',
  'ms.tex',
  'article.tex',
];

/**
 * Find main tex file in a directory
 *
 * Strategy:
 * 1. Check common names
 * 2. Find longest file with \documentclass
 */
export function findMainTex(directory: string): string | null {
  if (!fs.existsSync(directory)) {
    return null;
  }

  const files = fs.readdirSync(directory);

  // 1. Check common names
  for (const name of COMMON_MAIN_NAMES) {
    const filePath = path.join(directory, name);
    if (fs.existsSync(filePath) && hasDocumentclass(filePath)) {
      return name;
    }
  }

  // 2. Find longest file with \documentclass
  let mainFile: string | null = null;
  let maxLineCount = 0;

  for (const file of files) {
    if (!file.endsWith('.tex')) continue;
    const filePath = path.join(directory, file);
    if (hasDocumentclass(filePath)) {
      const lineCount = countLines(filePath);
      if (lineCount > maxLineCount) {
        mainFile = file;
        maxLineCount = lineCount;
      }
    }
  }

  return mainFile;
}

/**
 * Check if file contains \documentclass
 */
function hasDocumentclass(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return /\\documentclass/.test(content);
  } catch {
    return false;
  }
}

/**
 * Count lines in a file
 */
function countLines(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * Remove appendix section from content
 */
export function removeAppendix(content: string): string {
  const match = content.match(/\\appendix\b/);
  return match ? content.slice(0, match.index).trimEnd() : content;
}

/**
 * Remove comments from LaTeX content
 *
 * Handles:
 * - Pure comment lines (% at start)
 * - Inline comments (unescaped %)
 * - Escaped percent signs (\%)
 */
export function removeComments(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    // Skip pure comment lines
    if (line.trimStart().startsWith('%')) continue;

    // Handle inline comments
    let cleaned = '';
    let i = 0;
    while (i < line.length) {
      if (line[i] === '%') {
        // Check if escaped (odd number of preceding backslashes)
        let backslashCount = 0;
        let j = i - 1;
        while (j >= 0 && line[j] === '\\') {
          backslashCount++;
          j--;
        }
        if (backslashCount % 2 === 1) {
          // Escaped %, keep it
          cleaned += line[i];
          i++;
        } else {
          // Unescaped %, rest is comment
          break;
        }
      } else {
        cleaned += line[i];
        i++;
      }
    }
    result.push(cleaned);
  }

  return result.join('\n');
}

/**
 * Check if content has frontmatter to skip
 *
 * Frontmatter includes:
 * - Author lists
 * - Affiliations
 * - Email addresses
 */
export function findContentStart(normTex: string): number {
  // Look for end of abstract or maketitle
  const patterns = [
    /\\end\{abstract\}/,
    /\\maketitle/,
    /\\section\{/,
  ];

  for (const p of patterns) {
    const match = p.exec(normTex);
    if (match) {
      return match.index + match[0].length;
    }
  }

  return 0;
}
