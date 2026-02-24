/**
 * LaTeX Bibliography Extractor
 * Extracts bibliography entries from LaTeX AST and .bib files
 * Uses bibtexParser for proper BibTeX parsing
 */

import { latexParser, bibtexParser } from 'latex-utensils';
import type { LatexAst, LatexNode, Locator } from './parser.js';
import { extractText } from './sectionExtractor.js';
import { nodeToLocator } from './locator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BibEntry {
  /** Citation key */
  key: string;
  /** Entry type (article, book, inproceedings, etc.) */
  type: string;
  /** Title */
  title?: string;
  /** Authors */
  authors?: string[];
  /** Year */
  year?: string;
  /** Journal */
  journal?: string;
  /** Journal volume (if present in .bib) */
  volume?: string;
  /** Pages/article number (if present in .bib) */
  pages?: string;
  /** DOI */
  doi?: string;
  /** arXiv ID */
  arxiv_id?: string;
  /** INSPIRE recid (if resolvable) */
  inspire_recid?: string;
  /** Raw entry content */
  raw?: string;
  /** Source location (for \bibitem entries) */
  location?: Locator;
}

export interface ExtractBibliographyOptions {
  /** Resolve entries to INSPIRE (default: false) */
  resolve_to_inspire?: boolean;
  /** Parse .bib file content if available (default: true) */
  parse_bib_file?: boolean;
  /** Source file path for location info */
  file?: string;
}

/**
 * String registry for @string abbreviation expansion
 */
type StringRegistry = Map<string, string>;

/**
 * Common BibTeX month abbreviations
 */
const BUILTIN_STRINGS: StringRegistry = new Map([
  ['jan', 'January'],
  ['feb', 'February'],
  ['mar', 'March'],
  ['apr', 'April'],
  ['may', 'May'],
  ['jun', 'June'],
  ['jul', 'July'],
  ['aug', 'August'],
  ['sep', 'September'],
  ['oct', 'October'],
  ['nov', 'November'],
  ['dec', 'December'],
]);

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get command argument as text
 */
function getCommandArg(node: LatexNode, index = 0): string {
  if (!latexParser.isCommand(node)) return '';
  const arg = node.args[index];
  if (!arg || !latexParser.isGroup(arg)) return '';
  return extractText(arg.content);
}

/**
 * Parse authors string into array
 */
function parseAuthors(authorsStr: string): string[] {
  if (!authorsStr) return [];
  return authorsStr
    .split(/\s+and\s+/i)
    .map(a => a.trim())
    .filter(a => a.length > 0);
}

/**
 * Extract arXiv ID from eprint field
 */
function extractArxivId(entry: Record<string, string>): string | undefined {
  const eprint = entry.eprint || entry.arxiv;
  if (eprint) {
    // Match patterns like 2301.12345 or hep-th/0001234
    const match = eprint.match(/(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})/i);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Extract DOI from entry
 */
function extractDoi(entry: Record<string, string>): string | undefined {
  const doi = entry.doi;
  if (doi) {
    // Clean up DOI
    return doi.replace(/^https?:\/\/doi\.org\//i, '').trim();
  }
  return undefined;
}

/**
 * Regex fallback for BibTeX parsing when AST parsing fails
 */
function parseBibtexWithRegex(content: string): BibEntry[] {
  const entries: BibEntry[] = [];

  // Match @type{key, ... }
  const entryPattern = /@(\w+)\s*\{\s*([^,]+)\s*,([^@]*?)(?=\n\s*@|\n*$)/gs;
  let match;

  while ((match = entryPattern.exec(content))) {
    const [, type, key, body] = match;
    if (type.toLowerCase() === 'string' || type.toLowerCase() === 'preamble') {
      continue;
    }

    const fields: Record<string, string> = {};

    // Extract fields: name = {value} or name = "value"
    const fieldPattern = /(\w+)\s*=\s*(?:\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|"([^"]*)"|(\d+))/g;
    let fieldMatch;
    while ((fieldMatch = fieldPattern.exec(body))) {
      const [, name, braceVal, quoteVal, numVal] = fieldMatch;
      fields[name.toLowerCase()] = braceVal || quoteVal || numVal || '';
    }

    const entry: BibEntry = {
      key: key.trim(),
      type: type.toLowerCase(),
      title: fields.title,
      authors: parseAuthors(fields.author),
      year: fields.year,
      journal: fields.journal || fields.booktitle,
      volume: fields.volume,
      pages: fields.pages || fields.pagination || fields.artid || fields.article_number,
      doi: extractDoi(fields),
      arxiv_id: extractArxivId(fields),
    };

    entries.push(entry);
  }

  return entries;
}

/**
 * Parse BibTeX content with @string expansion
 */
function parseBibtex(content: string): BibEntry[] {
  const entries: BibEntry[] = [];

  // REVTEX may inject control-only entries like:
  //   @CONTROL{REVTEX41Control}
  // They are not real citations and should not pollute the citation graph.
  const sanitized = content.replace(/@CONTROL\\s*\\{[\\s\\S]*?\\}\\s*(?=@|$)/gi, '');

  try {
    const ast = bibtexParser.parse(sanitized);

    // First pass: collect @string definitions
    const strings: StringRegistry = new Map();
    for (const node of ast.content) {
      if (bibtexParser.isStringEntry(node)) {
        const value = extractFieldValue(node.value, strings);
        strings.set(node.abbreviation.toLowerCase(), value);
      }
    }

    // Second pass: extract entries with string expansion
    for (const node of ast.content) {
      if (bibtexParser.isEntry(node)) {
        const fields: Record<string, string> = {};

        for (const field of node.content) {
          const value = extractFieldValue(field.value, strings);
          fields[field.name.toLowerCase()] = value;
        }

        const entry: BibEntry = {
          key: node.internalKey || '',
          type: node.entryType.toLowerCase(),
          title: fields.title,
          authors: parseAuthors(fields.author),
          year: fields.year,
          journal: fields.journal || fields.booktitle,
          volume: fields.volume,
          pages: fields.pages || fields.pagination || fields.artid || fields.article_number,
          doi: extractDoi(fields),
          arxiv_id: extractArxivId(fields),
        };

        entries.push(entry);
      }
    }
  } catch (err) {
    // BibTeX parsing failed, try regex fallback
    console.warn(`BibTeX parsing failed: ${err instanceof Error ? err.message : String(err)}`);
    return parseBibtexWithRegex(sanitized);
  }

  return entries;
}

/**
 * Extract string value from FieldValue with @string expansion
 */
function extractFieldValue(
  value: bibtexParser.FieldValue,
  strings: StringRegistry
): string {
  if (bibtexParser.isTextStringValue(value)) {
    return value.content;
  }
  if (bibtexParser.isNumberValue(value)) {
    return value.content;
  }
  if (bibtexParser.isConcatValue(value)) {
    // Recursively expand each part of the concatenation
    return value.content
      .map((v) => extractFieldValue(v, strings))
      .join('');
  }
  if (bibtexParser.isAbbreviationValue(value)) {
    // Look up abbreviation in registry
    const abbr = value.content.toLowerCase();
    return strings.get(abbr) || BUILTIN_STRINGS.get(abbr) || value.content;
  }
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract bibliography from LaTeX AST
 */
export function extractBibliography(
  ast: LatexAst,
  bibContent?: string,
  options: ExtractBibliographyOptions = {}
): BibEntry[] {
  if (ast.kind !== 'ast.root') return [];

  const { parse_bib_file = true, file = 'unknown' } = options;
  const entries: BibEntry[] = [];

  // Parse .bib file if provided
  if (bibContent && parse_bib_file) {
    entries.push(...parseBibtex(bibContent));
  }

  // Extract \bibitem entries from thebibliography environment
  function traverse(nodes: LatexNode[]) {
    for (const node of nodes) {
      if (latexParser.isEnvironment(node) && node.name === 'thebibliography') {
        extractBibItems(node.content);
      } else if (latexParser.isEnvironment(node)) {
        traverse(node.content);
      }
    }
  }

  function extractBibItems(nodes: LatexNode[]) {
    let currentKey = '';
    let currentContent: LatexNode[] = [];
    let currentNode: LatexNode | null = null;

    for (const node of nodes) {
      if (latexParser.isCommand(node) && node.name === 'bibitem') {
        // Save previous entry
        if (currentKey) {
          const entry = parseBibItem(currentKey, currentContent, currentNode);
          if (entry) entries.push(entry);
        }
        // Start new entry
        currentKey = getCommandArg(node);
        currentContent = [];
        currentNode = node;
      } else {
        currentContent.push(node);
      }
    }

    // Save last entry
    if (currentKey) {
      const entry = parseBibItem(currentKey, currentContent, currentNode);
      if (entry) entries.push(entry);
    }
  }

  function parseBibItem(
    key: string,
    content: LatexNode[],
    bibitemNode: LatexNode | null
  ): BibEntry | null {
    const text = extractText(content).trim();
    if (!text) return null;

    const entry: BibEntry = {
      key,
      type: 'misc',
      raw: text,
    };

    // Add location if available
    if (bibitemNode) {
      entry.location = nodeToLocator(bibitemNode, file);
    }

    // Try to extract year
    const yearMatch = text.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) entry.year = yearMatch[0];

    // Try to extract arXiv ID
    const arxivMatch = text.match(/arXiv:(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})/i);
    if (arxivMatch) entry.arxiv_id = arxivMatch[1];

    // Try to extract DOI
    const doiMatch = text.match(/10\.\d{4,}\/[^\s,]+/);
    if (doiMatch) entry.doi = doiMatch[0];

    return entry;
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
  return entries;
}
