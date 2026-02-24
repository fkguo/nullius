/**
 * Bibitem Parser
 *
 * Enhanced parsing of \bibitem entries from bbl files.
 * Supports two main formats:
 * 1. Simple: `Phys. Rev. A {\bf 43}, 492`
 * 2. RevTeX/natbib: `\bibinfo{journal}{...} \textbf{\bibinfo{volume}{...}}`
 */

import type { BibEntryIdentifiers } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Text Cleaning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clean bibitem text by extracting content from \bibinfo{} macros
 * Handles RevTeX format with optional spaces: \bibinfo {field} {value}
 */
function cleanBibitemText(text: string): string {
  let cleaned = text;

  // Extract content from \bibinfo{field}{value} or \bibinfo {field} {value} → value
  // Note: RevTeX often has spaces between \bibinfo and braces
  cleaned = cleaned.replace(/\\bibinfo\s*\{[^}]+\}\s*\{([^}]*)\}/g, '$1');

  // Extract content from \textbf{...} or \textbf {...} → ...
  cleaned = cleaned.replace(/\\textbf\s*\{([^}]*)\}/g, '$1');

  // Extract content from {\bf ...} → ...
  cleaned = cleaned.replace(/\{\\bf\s+([^}]*)\}/g, '$1');

  // Extract content from \emph{...} or \emph {...} → ...
  cleaned = cleaned.replace(/\\emph\s*\{([^}]*)\}/g, '$1');

  // Remove other common macros (with optional spaces)
  cleaned = cleaned.replace(/\\bibnamefont\s*\{([^}]*)\}/g, '$1');
  cleaned = cleaned.replace(/\\bibfnamefont\s*\{([^}]*)\}/g, '$1');
  cleaned = cleaned.replace(/\\citenamefont\s*\{([^}]*)\}/g, '$1');
  cleaned = cleaned.replace(/\\natexlab\s*\{[^}]*\}/g, '');

  // Remove \bibfield{...}{...} wrapper
  cleaned = cleaned.replace(/\\bibfield\s*\{[^}]+\}\s*\{([^}]*)\}/g, '$1');

  // Remove \href@noop{} and similar
  cleaned = cleaned.replace(/\\href@noop\s*\{[^}]*\}/g, '');

  // Clean up whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Journal Patterns
// ─────────────────────────────────────────────────────────────────────────────

/** Common journal patterns in bibitem text */
const JOURNAL_PATTERNS: Array<{ pattern: RegExp; journal: string }> = [
  // Physical Review family - with year in parens: "Phys. Rev. Lett. 40 (1978) 598"
  { pattern: /Phys\.?\s*Rev\.?\s*Lett\.?\s*(\d+)\s*\(\d{4}\)\s*(\d+)/i, journal: 'Phys.Rev.Lett.' },
  { pattern: /Phys\.?\s*Rev\.?\s*D\s*(\d+)\s*\(\d{4}\)\s*(\d+)/i, journal: 'Phys.Rev.D' },
  { pattern: /Phys\.?\s*Rev\.?\s*C\s*(\d+)\s*\(\d{4}\)\s*(\d+)/i, journal: 'Phys.Rev.C' },
  { pattern: /Phys\.?\s*Rev\.?\s*A\s*(\d+)\s*\(\d{4}\)\s*(\d+)/i, journal: 'Phys.Rev.A' },
  { pattern: /Phys\.?\s*Rev\.?\s*(\d+)\s*\(\d{4}\)\s*(\d+)/i, journal: 'Phys.Rev.' },
  // Physical Review family - compact format (D65, A43)
  { pattern: /Phys\.?\s*Rev\.?\s*Lett\.?\s*(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Phys.Rev.Lett.' },
  { pattern: /Phys\.?\s*Rev\.?\s*D(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Phys.Rev.D' },
  { pattern: /Phys\.?\s*Rev\.?\s*C(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Phys.Rev.C' },
  { pattern: /Phys\.?\s*Rev\.?\s*A(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Phys.Rev.A' },
  // Physical Review family - spaced format (D 65, A 43)
  { pattern: /Phys\.?\s*Rev\.?\s*D\s+(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Phys.Rev.D' },
  { pattern: /Phys\.?\s*Rev\.?\s*C\s+(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Phys.Rev.C' },
  { pattern: /Phys\.?\s*Rev\.?\s*A\s+(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Phys.Rev.A' },
  { pattern: /Phys\.?\s*Rev\.?\s*(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Phys.Rev.' },
  { pattern: /Rev\.?\s*Mod\.?\s*Phys\.?\s*(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Rev.Mod.Phys.' },

  // JHEP, JCAP
  { pattern: /JHEP\s*(\d{2})\s*\((\d{4})\)\s*(\d+)/i, journal: 'JHEP' },
  { pattern: /JCAP\s*(\d{2})\s*\((\d{4})\)\s*(\d+)/i, journal: 'JCAP' },

  // Nuclear Physics - with year in parens
  { pattern: /Nucl\.?\s*Phys\.?\s*A\s*(\d+)\s*\(\d{4}\)\s*(\d+)/i, journal: 'Nucl.Phys.A' },
  { pattern: /Nucl\.?\s*Phys\.?\s*B\s*(\d+)\s*\(\d{4}\)\s*(\d+)/i, journal: 'Nucl.Phys.B' },
  // Nuclear Physics - compact and spaced
  { pattern: /Nucl\.?\s*Phys\.?\s*B(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Nucl.Phys.B' },
  { pattern: /Nucl\.?\s*Phys\.?\s*B\s+(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Nucl.Phys.B' },
  { pattern: /Nucl\.?\s*Phys\.?\s*A(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Nucl.Phys.A' },
  { pattern: /Nucl\.?\s*Phys\.?\s*A\s+(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Nucl.Phys.A' },

  // Physics Letters - with year in parens
  { pattern: /Phys\.?\s*Lett\.?\s*B\s*(\d+)\s*\(\d{4}\)\s*(\d+)/i, journal: 'Phys.Lett.B' },
  { pattern: /Phys\.?\s*Lett\.?\s*A\s*(\d+)\s*\(\d{4}\)\s*(\d+)/i, journal: 'Phys.Lett.A' },
  // Physics Letters - compact and spaced
  { pattern: /Phys\.?\s*Lett\.?\s*B(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Phys.Lett.B' },
  { pattern: /Phys\.?\s*Lett\.?\s*B\s+(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Phys.Lett.B' },
  { pattern: /Phys\.?\s*Lett\.?\s*B?\s*(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Phys.Lett.B' },

  // European Physical Journal - with year in parens
  { pattern: /Eur\.?\s*Phys\.?\s*J\.?\s*C\s*(\d+)\s*\(\d{4}\)\s*(\d+)/i, journal: 'Eur.Phys.J.C' },
  { pattern: /Eur\.?\s*Phys\.?\s*J\.?\s*A\s*(\d+)\s*\(\d{4}\)\s*(\d+)/i, journal: 'Eur.Phys.J.A' },
  // European Physical Journal
  { pattern: /Eur\.?\s*Phys\.?\s*J\.?\s*C(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Eur.Phys.J.C' },
  { pattern: /Eur\.?\s*Phys\.?\s*J\.?\s*C\s+(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Eur.Phys.J.C' },
  { pattern: /Eur\.?\s*Phys\.?\s*J\.?\s*A(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Eur.Phys.J.A' },
  { pattern: /Eur\.?\s*Phys\.?\s*J\.?\s*D(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Eur.Phys.J.D' },

  // Chinese Physics
  { pattern: /Chin\.?\s*Phys\.?\s*C(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Chin.Phys.C' },
  { pattern: /Chin\.?\s*Phys\.?\s*C\s+(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Chin.Phys.C' },

  // Other common journals - with year in parens
  { pattern: /Z\.?\s*Phys\.?\s*C\s*(\d+)\s*\(\d{4}\)\s*(\d+)/i, journal: 'Z.Phys.C' },
  { pattern: /Prog\.?\s*Theo\.?\s*Phys\.?\s*(\d+)\s*\(\d{4}\)\s*(\d+)/i, journal: 'Prog.Theor.Phys.' },
  // Other common journals
  { pattern: /J\.?\s*Mod\.?\s*Opt\.?\s*(\d+)\s*[,\s]\s*(\d+)/i, journal: 'J.Mod.Opt.' },
  { pattern: /Found\.?\s*Phys\.?\s*(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Found.Phys.' },
  { pattern: /Opt\.?\s*Lett\.?\s*(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Opt.Lett.' },
  { pattern: /Nature\s*(?:\(London\))?\s*(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Nature' },
  { pattern: /Europhys\.?\s*Lett\.?\s*(\d+)\s*[,\s]\s*(\d+)/i, journal: 'Europhys.Lett.' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Identifier Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract identifiers from bibitem text
 */
export function extractIdentifiersFromBibitem(text: string): BibEntryIdentifiers {
  const result: BibEntryIdentifiers = { citekey: '' };

  // 1. Extract \eprint{} first (before cleaning)
  const eprintMatch = text.match(/\\eprint\{([^}]+)\}/);
  if (eprintMatch) {
    result.eprint = eprintMatch[1];
  }

  // 2. Clean the text for pattern matching
  const cleaned = cleanBibitemText(text);

  // 3. arXiv ID (multiple formats)
  if (!result.eprint) {
    const arxivMatch = cleaned.match(/(?:arXiv[:\s]*)?(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})/i);
    if (arxivMatch) {
      result.eprint = arxivMatch[1];
    }
  }

  // 4. DOI - exclude trailing punctuation and braces
  const doiMatch = cleaned.match(/(?:doi[:\s]*)?10\.\d{4,}\/[^\s,\]\}]+/i);
  if (doiMatch) {
    // Clean up: remove doi: prefix and any trailing punctuation
    let doi = doiMatch[0].replace(/^doi[:\s]*/i, '');
    doi = doi.replace(/[.,;}\]]+$/, ''); // Remove trailing punctuation
    result.doi = doi;
  }

  // 5. Journal + Volume + Page
  for (const { pattern, journal } of JOURNAL_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match) {
      result.journal = journal;
      if (journal === 'JHEP' || journal === 'JCAP') {
        // JHEP 12 (2024) 121 format
        result.volume = match[1];
        result.year = match[2];
        result.page = match[3];
      } else {
        // Standard format: Journal Vol, Page
        result.volume = match[1];
        result.page = match[2];
      }
      break;
    }
  }

  // 6. Year (fallback)
  if (!result.year) {
    const yearMatch = cleaned.match(/\(?(19|20)\d{2}\)?/);
    if (yearMatch) {
      result.year = yearMatch[0].replace(/[()]/g, '');
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bibitem Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if content looks like a bbl file (contains thebibliography)
 */
export function isBblContent(content: string): boolean {
  return /\\begin\{thebibliography\}/i.test(content);
}

/**
 * Extract bibitem entries from raw bbl content (regex fallback)
 */
export function extractBibitemsFromBbl(bblContent: string): Map<string, BibEntryIdentifiers> {
  const entries = new Map<string, BibEntryIdentifiers>();

  // Match \bibitem [optional]{key} followed by content until next \bibitem or \end
  // Note: \s* handles spaces/newlines between \bibitem and [
  const pattern = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}([\s\S]*?)(?=\\bibitem|\\end\{thebibliography\}|$)/g;

  let match;
  while ((match = pattern.exec(bblContent)) !== null) {
    const [, citekey, content] = match;
    const ids = extractIdentifiersFromBibitem(content);
    ids.citekey = citekey.trim();
    entries.set(citekey.trim(), ids);
  }

  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Bibliography Parser (R3 P0-3)
// ─────────────────────────────────────────────────────────────────────────────

/** Bibliography format type */
export type BibFormat = 'bbl' | 'bib' | 'unknown';

/** Bibliography parse result */
export interface BibliographyParseResult {
  entries: Map<string, BibEntryIdentifiers>;
  format: BibFormat;
  warnings: string[];
}

/**
 * Detect bibliography format from content
 * R3 P0-3: More reliable detection using \bibitem\b or \begin{thebibliography}
 */
export function detectBibFormat(content: string): BibFormat {
  // bbl strong signals
  if (/\\begin\{thebibliography\}/.test(content)) return 'bbl';
  if (/\\bibitem\b/.test(content)) return 'bbl';
  // bib signal
  if (/@\w+\s*\{/.test(content)) return 'bib';
  return 'unknown';
}

/**
 * Unified bibliography content parser
 * R2 P0-3: Single entry point for bib/bbl parsing
 */
export function parseBibliographyContent(content: string): BibliographyParseResult {
  const format = detectBibFormat(content);
  const warnings: string[] = [];

  if (format === 'bbl') {
    return { entries: extractBibitemsFromBbl(content), format, warnings };
  }

  if (format === 'bib') {
    // TODO: Add BibTeX parser in future phase
    warnings.push('BibTeX (.bib) format not yet supported, falling back to empty');
    return { entries: new Map(), format, warnings };
  }

  // Unknown format: try bbl parser as fallback
  const bblEntries = extractBibitemsFromBbl(content);
  if (bblEntries.size > 0) {
    warnings.push('Format unknown, tried bbl parser successfully');
    return { entries: bblEntries, format: 'bbl', warnings };
  }

  warnings.push('Could not detect bibliography format');
  return { entries: new Map(), format: 'unknown', warnings };
}
