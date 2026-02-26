/**
 * Extract Bibliography Tool
 * Extracts bibliography entries from LaTeX papers
 */

import * as fs from 'fs';
import * as path from 'path';
import { getPaperContent } from './paperContent.js';
import {
  parseTexFile,
  resolveAllIncludes,
} from './latex/index.js';
import {
  extractBibliography as extractBib,
  type BibEntry,
} from './latex/bibliographyExtractor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractBibliographyParams {
  /** Paper identifier: recid, arXiv ID, or DOI */
  identifier: string;
  /** Resolve entries to INSPIRE (default: false) */
  resolve_to_inspire?: boolean;
}

export interface ExtractBibliographyResult {
  /** Bibliography entries */
  entries: BibEntry[];
  /** Total count */
  total: number;
  /** Entries with DOI */
  with_doi: number;
  /** Entries with arXiv ID */
  with_arxiv: number;
  /** Source file path */
  source_file: string;
  /** arXiv ID */
  arxiv_id: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function extractBibliography(
  params: ExtractBibliographyParams
): Promise<ExtractBibliographyResult> {
  const { identifier } = params;

  // Download LaTeX source
  const content = await getPaperContent({
    identifier,
    prefer: 'latex',
    extract: true,
  });

  if (!content.success || content.source_type !== 'latex') {
    throw new Error('LaTeX source not available for this paper');
  }

  if (!content.main_tex) {
    throw new Error('Could not identify main .tex file');
  }

  // Parse LaTeX
  const doc = parseTexFile(content.main_tex);
  const resolved = resolveAllIncludes(doc);

  // Try to find .bib file
  let bibContent: string | undefined;
  const texDir = path.dirname(content.main_tex);
  try {
    const bibFiles = fs.readdirSync(texDir).filter(f => f.endsWith('.bib')).sort();
    if (bibFiles.length > 0) {
      bibContent = bibFiles
        .map(f => fs.readFileSync(path.join(texDir, f), 'utf-8'))
        .join('\n');
    }
  } catch (error) {
    // Log at debug level for troubleshooting
    console.debug(`[hep-mcp] extractBibliography - .bib file read failed: ${error instanceof Error ? error.message : String(error)}`);
    // .bib file not accessible, continue without it
  }

  // Extract bibliography
  const entries = extractBib(resolved.ast, bibContent);

  // Count statistics
  const withDoi = entries.filter(e => e.doi).length;
  const withArxiv = entries.filter(e => e.arxiv_id).length;

  return {
    entries,
    total: entries.length,
    with_doi: withDoi,
    with_arxiv: withArxiv,
    source_file: content.main_tex,
    arxiv_id: content.arxiv_id,
  };
}
