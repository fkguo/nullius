/**
 * Parse LaTeX Content Tool
 * Unified entry point for extracting multiple components from LaTeX papers
 * Consolidates 7 individual extract_* tools into one polymorphic tool
 */

import type {
  CreateMessageRequestParamsBase,
  CreateMessageResult,
} from '@modelcontextprotocol/sdk/types.js';
import { INSPIRE_PARSE_LATEX } from '@autoresearch/shared';
import { getPaperContent } from '../../utils/arxivCompat.js';
import {
  parseTexFile,
  resolveAllIncludes,
  extractSectionsWithContent,
  extractTitle,
  extractAuthors,
  extractAbstract,
  extractEquations as extractEqs,
  extractTheorems as extractThms,
  extractCitations as extractCites,
  extractFigures as extractFigs,
  extractTables as extractTbls,
  extractBibliography as extractBib,
  identifyKeyEquations,
  type Section,
  type Equation,
  type Theorem,
  type Citation,
  type Figure,
  type Table,
  type BibEntry,
} from './latex/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Component types that can be extracted */
export type ComponentType =
  | 'all'
  | 'sections'
  | 'equations'
  | 'theorems'
  | 'citations'
  | 'figures'
  | 'tables'
  | 'bibliography';

export interface ParseLatexContentParams {
  /** Paper identifier: recid, arXiv ID, or DOI */
  identifier: string;
  /** Components to extract (default: ['all']) */
  components?: ComponentType[];
  /** Options for extraction */
  options?: ParseLatexOptions;
  /** Internal MCP context (not part of tool schema) */
  _mcp?: {
    createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
  };
}

export interface ParseLatexOptions {
  /** Use key equation identification with importance scoring (default: true) */
  include_key_equations?: boolean;
  /** Include inline math (default: false) */
  include_inline_math?: boolean;
  /** Include section content (default: false) */
  include_section_content?: boolean;
  /** Max content length per section (default: 2000) */
  max_section_content?: number;
  /** Include theorem proofs (default: true) */
  include_proofs?: boolean;
  /** Citation context window size (default: 200) */
  citation_context_window?: number;
  /** Parse table data into cells (default: true) */
  parse_table_data?: boolean;
}

export interface ParseLatexContentResult {
  /** Paper metadata */
  metadata: {
    title: string;
    authors: string[];
    abstract: string;
    arxiv_id: string;
    source_file: string;
  };
  /** Extracted components (only requested ones) */
  sections?: Section[];
  equations?: Equation[];
  key_equations?: Array<{
    latex: string;
    label?: string;
    importance?: 'high' | 'medium' | 'low';
    selection_status: 'selected' | 'uncertain' | 'abstained' | 'unavailable';
    reason_code: string;
    selection_rationale?: string;
    provenance: {
      backend: 'mcp_sampling' | 'metadata' | 'diagnostic_fallback';
      status: 'applied' | 'metadata' | 'fallback' | 'abstained' | 'invalid' | 'unavailable';
      used_fallback: boolean;
      reason_code: string;
      prompt_version?: string;
      input_hash?: string;
      model?: string;
      signals?: string[];
    };
    reference_count: number;
    section?: string;
  }>;
  theorems?: Theorem[];
  citations?: Citation[];
  figures?: Figure[];
  tables?: Table[];
  bibliography?: BibEntry[];
  /** Summary statistics */
  summary: {
    components_extracted: ComponentType[];
    counts: Record<string, number>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<ParseLatexOptions> = {
  include_key_equations: true,
  include_inline_math: false,
  include_section_content: false,
  max_section_content: 2000,
  include_proofs: true,
  citation_context_window: 200,
  parse_table_data: true,
};

const ALL_COMPONENTS: ComponentType[] = [
  'sections', 'equations', 'theorems', 'citations',
  'figures', 'tables', 'bibliography',
];

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse LaTeX content and extract multiple components in one call
 */
export async function parseLatexContent(
  params: ParseLatexContentParams
): Promise<ParseLatexContentResult> {
  const { identifier, components = ['all'] } = params;
  const options: Required<ParseLatexOptions> = {
    ...DEFAULT_OPTIONS,
    ...params.options,
  };

  // Determine which components to extract
  const toExtract = new Set<ComponentType>(
    components.includes('all') ? ALL_COMPONENTS : components
  );

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
  const ast = resolved.ast;

  // Build result
  const result: ParseLatexContentResult = {
    metadata: {
      title: extractTitle(ast),
      authors: extractAuthors(ast),
      abstract: extractAbstract(ast),
      arxiv_id: content.arxiv_id,
      source_file: content.main_tex,
    },
    summary: {
      components_extracted: [],
      counts: {},
    },
  };

  // Extract requested components
  if (toExtract.has('sections')) {
    result.sections = extractSectionsWithContent(ast, {
      includeContent: options.include_section_content,
      maxContentLength: options.max_section_content,
    });
    result.summary.components_extracted.push('sections');
    result.summary.counts.sections = countSections(result.sections);
  }

  if (toExtract.has('equations')) {
    let eqs = extractEqs(ast);
    if (!options.include_inline_math) {
      eqs = eqs.filter(eq => eq.type !== 'inline');
    }
    result.equations = eqs;  // No limit - extract all
    result.summary.components_extracted.push('equations');
    result.summary.counts.equations = result.equations.length;

    // Key equations with importance scoring (no limit)
    if (options.include_key_equations) {
      const keyEqs = await identifyKeyEquations(ast, resolved.content, {
        min_score: 15,
        include_inline: options.include_inline_math,
        document_title: result.metadata.title,
        abstract: result.metadata.abstract,
        tool_name: INSPIRE_PARSE_LATEX,
        createMessage: params._mcp?.createMessage,
      });
      result.key_equations = keyEqs.map(eq => ({
        latex: eq.latex,
        label: eq.label,
        importance: eq.importance_band,
        selection_status: eq.selection_status,
        reason_code: eq.provenance.reason_code,
        selection_rationale: eq.selection_rationale,
        provenance: eq.provenance,
        reference_count: eq.reference_count,
        section: eq.section,
      }));
      result.summary.counts.key_equations = result.key_equations.length;
    }
  }

  if (toExtract.has('theorems')) {
    result.theorems = extractThms(ast, {
      include_proofs: options.include_proofs,
    });
    result.summary.components_extracted.push('theorems');
    result.summary.counts.theorems = result.theorems.length;
  }

  if (toExtract.has('citations')) {
    result.citations = extractCites(ast, resolved.content, {
      context_window: options.citation_context_window,
    });
    result.summary.components_extracted.push('citations');
    result.summary.counts.citations = result.citations.length;
  }

  if (toExtract.has('figures')) {
    result.figures = extractFigs(ast);
    result.summary.components_extracted.push('figures');
    result.summary.counts.figures = result.figures.length;
  }

  if (toExtract.has('tables')) {
    result.tables = extractTbls(ast, {
      parse_data: options.parse_table_data,
    });
    result.summary.components_extracted.push('tables');
    result.summary.counts.tables = result.tables.length;
  }

  if (toExtract.has('bibliography')) {
    result.bibliography = extractBib(ast);
    result.summary.components_extracted.push('bibliography');
    result.summary.counts.bibliography = result.bibliography.length;
  }

  return result;
}

/** Count sections recursively */
function countSections(sections: Section[]): number {
  let count = sections.length;
  for (const sec of sections) {
    count += countSections(sec.children);
  }
  return count;
}
