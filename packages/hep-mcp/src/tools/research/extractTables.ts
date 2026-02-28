/**
 * Extract Tables Tool
 * Extracts table environments from LaTeX papers
 */

import { getPaperContent } from '../../utils/arxivCompat.js';
import {
  parseTexFile,
  resolveIncludes,
} from './latex/index.js';
import {
  extractTables as extractTbls,
  type Table,
} from './latex/tableExtractor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractTablesParams {
  /** Paper identifier: recid, arXiv ID, or DOI */
  identifier: string;
  /** Include longtable environments (default: true) */
  include_longtable?: boolean;
  /** Parse table data into cells (default: true) */
  parse_data?: boolean;
  /** Max rows to parse (default: 100) */
  max_rows?: number;
}

export interface ExtractTablesResult {
  /** Tables list */
  tables: Table[];
  /** Total count */
  total: number;
  /** Source file path */
  source_file: string;
  /** arXiv ID */
  arxiv_id: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function extractTables(
  params: ExtractTablesParams
): Promise<ExtractTablesResult> {
  const {
    identifier,
    include_longtable = true,
    parse_data = true,
    max_rows = 100,
  } = params;

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
  const resolved = resolveIncludes(doc);

  // Extract tables
  const tables = extractTbls(resolved.ast, {
    include_longtable,
    parse_data,
    max_rows,
  });

  return {
    tables,
    total: tables.length,
    source_file: content.main_tex,
    arxiv_id: content.arxiv_id,
  };
}
