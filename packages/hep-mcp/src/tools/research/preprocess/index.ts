/**
 * LaTeX Preprocessing Module
 * Combines flattening, macro expansion, and math normalization
 */

// Re-export types
export * from './types.js';

// Re-export utilities
export { getLineAtPosition, countLines, stripComments } from './utils.js';

// Re-export individual modules
export {
  flattenLatexProject,
  lookupSourceLocation,
  formatSourceLocation,
  type FlattenResult,
} from './flattener.js';

export {
  buildMacroRegistry,
  expandMacros,
} from './macroExpander.js';

export {
  extractMathBlocks,
  normalizeMathDelimiters,
  type NormalizeMathOptions,
} from './mathNormalizer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Unified Preprocess Function
// ─────────────────────────────────────────────────────────────────────────────

import { flattenLatexProject } from './flattener.js';
import { buildMacroRegistry, expandMacros } from './macroExpander.js';
import { extractMathBlocks, normalizeMathDelimiters } from './mathNormalizer.js';
import type { PreprocessResult, PreprocessOptions } from './types.js';

/**
 * Preprocess a LaTeX project
 *
 * Performs:
 * 1. File flattening (merge \input/\include)
 * 2. Macro extraction and expansion
 * 3. Math environment normalization
 *
 * @param mainFilePath - Path to main .tex file
 * @param options - Preprocessing options
 * @returns Preprocessed content with source map and metadata
 */
export function preprocessLatex(
  mainFilePath: string,
  options: PreprocessOptions = {}
): PreprocessResult {
  const startTime = Date.now();
  const {
    maxDepth = 10,
    expandMacros: shouldExpand = true,
    safeExpansionOnly = true,
    normalizeMath = true,
  } = options;

  // Step 1: Flatten files
  const flatResult = flattenLatexProject(mainFilePath, { maxDepth });
  let content = flatResult.content;

  // Step 2: Extract and expand macros
  const macros = buildMacroRegistry(content, mainFilePath);
  let macrosExpanded = 0;

  if (shouldExpand) {
    const expandResult = expandMacros(content, macros, {
      safeOnly: safeExpansionOnly,
    });
    content = expandResult.content;
    macrosExpanded = expandResult.expandedCount;
  }

  // Step 3: Normalize math (optional)
  if (normalizeMath) {
    content = normalizeMathDelimiters(content);
  }

  // Step 4: Extract math blocks
  const mathBlocks = extractMathBlocks(content);

  return {
    content,
    sourceMap: flatResult.sourceMap,
    macros,
    mathBlocks,
    stats: {
      filesMerged: flatResult.filesMerged,
      macrosFound: macros.macros.size,
      macrosExpanded,
      mathEnvsNormalized: mathBlocks.length,
      processingTimeMs: Date.now() - startTime,
    },
  };
}
