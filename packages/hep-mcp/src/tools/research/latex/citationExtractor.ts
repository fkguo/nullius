/**
 * LaTeX Citation Extractor
 * Extracts citation commands and their context from LaTeX AST
 */

import { latexParser } from 'latex-utensils';
import type { LatexAst, LatexNode, Locator } from './parser.js';
import { extractText } from './sectionExtractor.js';
import { nodeToLocator } from './locator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type CitationCommandType =
  | 'cite'
  | 'citep'
  | 'citet'
  | 'citeauthor'
  | 'citeyear'
  | 'parencite'
  | 'textcite'
  | 'autocite'
  | 'ref'
  | 'eqref'
  | 'autoref';

export interface Citation {
  /** Citation command type */
  type: CitationCommandType;
  /** Citation keys (e.g., ["smith2020", "jones2021"]) */
  keys: string[];
  /** Context around the citation */
  context: string;
  /** Section where citation appears */
  section?: string;
  /** Optional argument (e.g., "p.~10" in \cite[p.~10]{key}) */
  optional_arg?: string;
  /** Source location */
  location?: Locator;
}

export interface ExtractCitationsOptions {
  /** Citation types to include (default: all) */
  include_types?: CitationCommandType[];
  /** Context window size in characters (default: 200) */
  context_window?: number;
  /** Include cross-references like \ref, \eqref (default: false) */
  include_cross_refs?: boolean;
  /** Source file path for location info */
  file?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CITATION_COMMANDS = new Set([
  'cite', 'citep', 'citet', 'citeauthor', 'citeyear',
  'Cite', 'Citep', 'Citet', 'Citeauthor', 'Citeyear',
  'parencite', 'textcite', 'autocite', 'footcite',
  'Parencite', 'Textcite', 'Autocite',
]);

const CROSS_REF_COMMANDS = new Set([
  'ref', 'eqref', 'autoref', 'pageref',
  'Ref', 'Autoref',
]);

const SECTION_COMMANDS = new Set([
  'part', 'chapter', 'section', 'subsection', 'subsubsection',
  'paragraph', 'subparagraph',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize citation command type
 */
function normalizeCommandType(name: string): CitationCommandType {
  const lower = name.toLowerCase();
  if (lower === 'parencite') return 'citep';
  if (lower === 'textcite') return 'citet';
  if (lower === 'autocite') return 'cite';
  if (lower === 'footcite') return 'cite';
  return lower as CitationCommandType;
}

/**
 * Check if command is a section command
 */
function isSectionCommand(name: string): boolean {
  return SECTION_COMMANDS.has(name.toLowerCase());
}

/**
 * Get command argument as text
 */
function getCommandArg(node: LatexNode, argIndex = 0): string {
  if (!latexParser.isCommand(node)) return '';
  const arg = node.args[argIndex];
  if (!arg || !latexParser.isGroup(arg)) return '';
  return extractText(arg.content);
}

/**
 * Extract citation keys from command
 */
function extractCitationKeys(node: LatexNode): string[] {
  if (!latexParser.isCommand(node)) return [];

  // Find the required argument (Group)
  for (const arg of node.args) {
    if (latexParser.isGroup(arg)) {
      const text = extractText(arg.content);
      // Split multiple keys: \cite{key1, key2, key3}
      return text.split(',').map(k => k.trim()).filter(k => k.length > 0);
    }
  }
  return [];
}

/**
 * Extract optional argument from command
 */
function extractOptionalArg(node: LatexNode): string | undefined {
  if (!latexParser.isCommand(node)) return undefined;

  for (const arg of node.args) {
    if (latexParser.isOptionalArg(arg)) {
      return extractText(arg.content);
    }
  }
  return undefined;
}

/**
 * Extract context around a position in the content
 */
function extractContext(
  content: string,
  position: number,
  windowSize: number
): string {
  const start = Math.max(0, position - windowSize);
  const end = Math.min(content.length, position + windowSize);

  let context = content.slice(start, end);

  // Try to extend to complete sentences
  if (start > 0) {
    const sentenceStart = context.indexOf('. ');
    if (sentenceStart > 0 && sentenceStart < windowSize / 2) {
      context = context.slice(sentenceStart + 2);
    }
  }

  if (end < content.length) {
    const sentenceEnd = context.lastIndexOf('. ');
    if (sentenceEnd > windowSize && sentenceEnd < context.length - 1) {
      context = context.slice(0, sentenceEnd + 1);
    }
  }

  return context.replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract citations from LaTeX AST
 */
export function extractCitations(
  ast: LatexAst,
  content: string,
  options: ExtractCitationsOptions = {}
): Citation[] {
  if (ast.kind !== 'ast.root') return [];

  const {
    include_types,
    context_window = 200,
    include_cross_refs = false,
    file = 'unknown',
  } = options;

  const citations: Citation[] = [];
  let currentSection: string | undefined;
  let currentPosition = 0;

  function traverse(nodes: LatexNode[]) {
    for (const node of nodes) {
      // Update current section
      if (latexParser.isCommand(node) && isSectionCommand(node.name)) {
        currentSection = getCommandArg(node);
      }

      // Detect citation commands
      if (latexParser.isCommand(node)) {
        const cmdName = node.name;
        const isCitation = CITATION_COMMANDS.has(cmdName);
        const isCrossRef = CROSS_REF_COMMANDS.has(cmdName);

        if (isCitation || (include_cross_refs && isCrossRef)) {
          const type = normalizeCommandType(cmdName);

          // Filter by type if specified
          if (include_types && !include_types.includes(type)) {
            continue;
          }

          // Extract citation keys
          const keys = extractCitationKeys(node);
          if (keys.length === 0) continue;

          const location = nodeToLocator(node, file);
          const position = location.unknown ? currentPosition : location.offset;

          // Extract context
          const context = extractContext(content, position, context_window);

          // Extract optional argument
          const optionalArg = extractOptionalArg(node);

          citations.push({
            type,
            keys,
            context,
            section: currentSection,
            optional_arg: optionalArg,
            location,
          });
        }
      }

      // Update position estimate (rough approximation)
      if (latexParser.isTextString(node)) {
        currentPosition += node.content.length;
      }

      // Recurse into environments and groups
      if (latexParser.isEnvironment(node)) {
        traverse(node.content);
      } else if (latexParser.isGroup(node)) {
        traverse(node.content);
      }
    }
  }

  // Find document environment
  let docContent = ast.content;
  for (const node of ast.content) {
    if (latexParser.isEnvironment(node) && node.name === 'document') {
      docContent = node.content;
      break;
    }
  }

  traverse(docContent);
  return citations;
}
