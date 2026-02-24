/**
 * LaTeX Parser Core Module
 * Wraps latex-utensils for parsing LaTeX documents
 */

import { latexParser } from 'latex-utensils';
import type * as LU from 'latex-utensils';
import * as fs from 'fs';
import * as path from 'path';
import {
  mergeProjectContent,
  analyzeProjectStructure,
  type ProjectStructure,
  type ResolveOptions,
} from './projectResolver.js';

// Re-export parserHarness utilities
export {
  safeParseLatex,
  scanPreambleForMacros,
  shouldSkipNode,
  isInCommentEnv,
  isEnvironmentMacro,
  createEmptyRegistry,
  type UserMacroRegistry,
  type ParentChain,
  type SafeParseResult,
  type SafeParseOptions,
} from './parserHarness.js';

// Re-export locator utilities
export {
  buildLocatorIndex,
  nodeToLocator,
  getSafeLocator,
  mapGlobalOffsetToSource,
  mapLocatorToSource,
  applySourceMapToLocatorIndex,
  findBlockContainer,
  createAnchor,
  inferLabelType,
  isRefCommand,
  extractRefTargets,
  validateLocatorIndex,
  validateLocatorPlayback,
  playbackLocator,
  validateLabelsHaveBlocks,
  validateRefsHaveTargets,
  type Locator,
  type LocatorPlayback,
  type Block,
  type BlockKind,
  type LabelEntry,
  type RefEntry,
  type RefType,
  type LocatorIndex,
  type SourceSpan,
  type SourceMap,
  type FileContentProvider,
} from './locator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type LatexNode = LU.latexParser.Node;
export type LatexAst = LU.latexParser.LatexAst;

export interface ParsedDocument {
  /** Parsed AST */
  ast: LatexAst;
  /** Raw content */
  content: string;
  /** Source file path */
  filePath: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preprocessing Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Preprocess LaTeX content to fix common issues that cause parse errors.
 *
 * Handles:
 * - Removes problematic verbatim-like environments that may contain unbalanced delimiters
 * - Removes picture/tikz environments that often have complex syntax
 * - Balances unclosed math delimiters (best effort)
 */
function preprocessLatex(content: string): string {
  let processed = content;

  // Remove picture environments (often contain special syntax)
  processed = processed.replace(
    /\\begin\{(picture|tikzpicture|pgfpicture)\}[\s\S]*?\\end\{\1\}/g,
    '% [removed $1 environment]'
  );

  // Remove filecontents environments (may contain arbitrary content)
  processed = processed.replace(
    /\\begin\{filecontents\*?\}[\s\S]*?\\end\{filecontents\*?\}/g,
    '% [removed filecontents environment]'
  );

  return processed;
}

/**
 * Try to balance unclosed math delimiters by adding closing delimiters.
 * This is a best-effort recovery mechanism.
 */
function balanceMathDelimiters(content: string): string {
  let processed = content;

  // Count $ signs (excluding escaped \$)
  const dollarMatches = processed.match(/(?<!\\)\$/g);
  if (dollarMatches && dollarMatches.length % 2 !== 0) {
    // Odd number of $, add one at the end
    processed += ' $';
  }

  // Count \[ and \]
  const openDisplay = (processed.match(/\\\[/g) || []).length;
  const closeDisplay = (processed.match(/\\\]/g) || []).length;
  if (openDisplay > closeDisplay) {
    processed += ' \\]'.repeat(openDisplay - closeDisplay);
  }

  return processed;
}

/**
 * Balance unclosed braces by adding closing braces at the end.
 * This handles common issues like TM{$_{010}$ (unmatched {) in arXiv sources.
 * LaTeX compiles these fine but the parser needs balanced braces.
 */
function balanceBraces(content: string): string {
  let braceCount = 0;
  let inComment = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const prev = i > 0 ? content[i - 1] : '';

    // Track comments (skip to end of line)
    if (ch === '%' && prev !== '\\') {
      inComment = true;
      continue;
    }
    if (ch === '\n') {
      inComment = false;
      continue;
    }
    if (inComment) continue;

    // Skip escaped braces
    if (prev === '\\') continue;

    if (ch === '{') braceCount++;
    if (ch === '}') braceCount--;
  }

  // Add closing braces if needed (before \end{document} if present)
  if (braceCount > 0) {
    const closingBraces = '}'.repeat(braceCount);
    const endDocMatch = content.match(/\\end\s*\{\s*document\s*\}/);
    if (endDocMatch && endDocMatch.index !== undefined) {
      return (
        content.slice(0, endDocMatch.index) +
        closingBraces +
        content.slice(endDocMatch.index)
      );
    }
    return content + closingBraces;
  }

  return content;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse LaTeX content string with preprocessing and error recovery.
 *
 * @param content - LaTeX content to parse
 * @param options - Parse options
 * @returns Parsed AST
 */
export function parseLatex(content: string, options?: { skipPreprocess?: boolean }): LatexAst {
  const { skipPreprocess = false } = options || {};

  // Truncate content after \end{document} - anything after is not part of the document
  const endDocMatch = content.match(/\\end\s*\{\s*document\s*\}/);
  if (endDocMatch && endDocMatch.index !== undefined) {
    content = content.slice(0, endDocMatch.index + endDocMatch[0].length);
  }

  // First attempt: parse as-is
  try {
    return latexParser.parse(content, { enableComment: true });
  } catch (firstError) {
    if (skipPreprocess) {
      throw new Error(`LaTeX parse error: ${firstError instanceof Error ? firstError.message : String(firstError)}`);
    }

    // Second attempt: with preprocessing
    try {
      const preprocessed = preprocessLatex(content);
      return latexParser.parse(preprocessed, { enableComment: true });
    } catch (secondError) {
      // Third attempt: with math delimiter balancing
      try {
        const balanced = balanceMathDelimiters(preprocessLatex(content));
        return latexParser.parse(balanced, { enableComment: true });
      } catch (thirdError) {
        // Fourth attempt: with brace balancing (for issues like TM{$_{010}$)
        try {
          const braceBalanced = balanceBraces(balanceMathDelimiters(preprocessLatex(content)));
          return latexParser.parse(braceBalanced, { enableComment: true });
        } catch (fourthError) {
          // All attempts failed, throw original error
          throw new Error(`LaTeX parse error: ${firstError instanceof Error ? firstError.message : String(firstError)}`);
        }
      }
    }
  }
}

/**
 * Detect file encoding and read content
 * Tries UTF-8 first, falls back to Latin-1 if invalid UTF-8 sequences found
 */
export function readFileWithEncoding(filePath: string): string {
  const buffer = fs.readFileSync(filePath);

  // Try UTF-8 first
  const utf8Content = buffer.toString('utf-8');

  // Check for replacement character (indicates invalid UTF-8)
  if (!utf8Content.includes('\uFFFD')) {
    return utf8Content;
  }

  // Fall back to Latin-1 (ISO-8859-1)
  return buffer.toString('latin1');
}

/**
 * Read and parse a .tex file
 */
export function parseTexFile(filePath: string): ParsedDocument {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const content = readFileWithEncoding(filePath);
  const ast = parseLatex(content);
  return { ast, content, filePath };
}

/**
 * Resolve \input and \include commands
 */
export function resolveIncludes(
  doc: ParsedDocument,
  maxDepth = 5
): ParsedDocument {
  if (maxDepth <= 0) return doc;

  const baseDir = path.dirname(doc.filePath);
  let newContent = doc.content;

  // Find \input{} and \include{} commands
  const includeRegex = /\\(input|include)\{([^}]+)\}/g;
  let match;

  while ((match = includeRegex.exec(doc.content)) !== null) {
    const [fullMatch, , includePath] = match;
    let resolvedPath = path.resolve(baseDir, includePath);

    // Add .tex extension if missing
    if (!resolvedPath.endsWith('.tex')) {
      resolvedPath += '.tex';
    }

    if (fs.existsSync(resolvedPath)) {
      const includedContent = readFileWithEncoding(resolvedPath);
      newContent = newContent.replace(fullMatch, includedContent);
    }
  }

  if (newContent !== doc.content) {
    const newAst = parseLatex(newContent);
    return resolveIncludes(
      { ast: newAst, content: newContent, filePath: doc.filePath },
      maxDepth - 1
    );
  }

  return doc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enhanced Multi-File Support (P2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve all includes including subfiles, standalone, and import packages.
 * This is an enhanced version that handles complex multi-file projects.
 */
export function resolveAllIncludes(
  doc: ParsedDocument,
  options?: ResolveOptions
): ParsedDocument {
  const mergedContent = mergeProjectContent(doc.filePath, options);

  if (mergedContent !== doc.content) {
    const newAst = parseLatex(mergedContent);
    return {
      ast: newAst,
      content: mergedContent,
      filePath: doc.filePath,
    };
  }

  return doc;
}

/**
 * Get project structure analysis
 */
export function getProjectStructure(
  mainFilePath: string,
  options?: ResolveOptions
): ProjectStructure {
  return analyzeProjectStructure(mainFilePath, options);
}

// Re-export types from projectResolver
export type { ProjectStructure, ProjectFile, ResolveOptions } from './projectResolver.js';
