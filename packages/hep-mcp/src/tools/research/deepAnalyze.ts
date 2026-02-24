/**
 * Deep Analyze Tool
 * Analyzes paper content by downloading LaTeX source and extracting
 * equations, theorems, methodology, and conclusions.
 */

import { getPaperContent } from './paperContent.js';
import { resolveArxivId } from './arxivSource.js';
import * as api from '../../api/client.js';
import {
  parseTexFile,
  resolveAllIncludes,
  extractEquations as extractEqs,
  extractTheorems as extractThms,
  extractSectionsWithContent,
  extractDocumentStructure,
  identifyKeyEquations,
  type Section,
} from './latex/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DeepAnalyzeParams {
  /** Paper identifiers: recid, arXiv ID, or DOI */
  identifiers: string[];
  /** Analysis options */
  options?: DeepAnalyzeOptions;
}

export interface DeepAnalyzeOptions {
  /** Extract equations (default: true) */
  extract_equations?: boolean;
  /** Extract theorems (default: true) */
  extract_theorems?: boolean;
  /** Extract methodology sections (default: true) */
  extract_methodology?: boolean;
  /** Extract conclusions sections (default: true) */
  extract_conclusions?: boolean;
  /** Include inline math (default: false) */
  include_inline_math?: boolean;
  /** Max content length for sections (default: 5000) */
  max_section_length?: number;
}

export interface DeepAnalyzeResult {
  papers: DeepPaperAnalysis[];
  summary: {
    total_papers: number;
    successful: number;
    failed: number;
    total_equations: number;
    total_theorems: number;
  };
}

export interface DeepPaperAnalysis {
  recid: string;
  arxiv_id?: string;
  title: string;
  success: boolean;
  error?: string;

  /** Document structure */
  structure?: {
    title: string;
    authors: string[];
    abstract: string;
    sections: Array<{ level: number; title: string }>;
  };

  /** Equations */
  equations?: Array<{
    type: 'display' | 'align' | 'gather' | 'inline' | 'eqnarray' | 'multline';
    latex: string;
    label?: string;
    /** Whether this equation is referenced elsewhere in the text */
    referenced?: boolean;
  }>;

  /** Theorems */
  theorems?: Array<{
    type: string;
    env_name: string;
    title?: string;
    label?: string;
    content_text: string;
    has_proof: boolean;
  }>;

  /** Methodology section content */
  methodology?: string;

  /** Conclusions section content */
  conclusions?: string;

  /** Introduction section content */
  introduction?: string;

  /** Results section content */
  results?: string;

  /** Discussion section content */
  discussion?: string;

  /** Key equations with importance scores */
  key_equations?: Array<{
    latex: string;
    label?: string;
    importance_score: number;
    reference_count: number;
    section?: string;
    context_text?: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<DeepAnalyzeOptions> = {
  extract_equations: true,
  extract_theorems: true,
  extract_methodology: true,
  extract_conclusions: true,
  include_inline_math: false,
  max_section_length: 5000,
};

// Keywords for finding methodology sections
const METHODOLOGY_KEYWORDS = [
  'methodology', 'methods', 'method', 'approach', 'technique',
  'framework', 'formalism', 'theoretical framework', 'setup',
  'model', 'calculation', 'computational',
];

// Keywords for finding conclusion sections
const CONCLUSION_KEYWORDS = [
  'conclusion', 'conclusions', 'summary', 'discussion',
  'outlook', 'future', 'remarks', 'summary and outlook',
];

// Keywords for finding introduction sections
const INTRODUCTION_KEYWORDS = [
  'introduction', 'motivation', 'background', 'overview',
];

// Keywords for finding results sections
const RESULTS_KEYWORDS = [
  'results', 'findings', 'analysis', 'numerical results',
  'main results', 'experimental results', 'theoretical results',
];

// Keywords for finding discussion sections
const DISCUSSION_KEYWORDS = [
  'discussion', 'interpretation', 'implications', 'comparison',
];

// Batch size for parallel processing
const BATCH_SIZE = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find sections matching keywords
 */
function findSectionsByKeywords(
  sections: Section[],
  keywords: string[],
  maxLength: number
): string {
  const results: string[] = [];

  function searchSections(sectionList: Section[]) {
    for (const section of sectionList) {
      const titleLower = section.title.toLowerCase();
      const matches = keywords.some(kw => titleLower.includes(kw));

      if (matches && section.content) {
        let content = section.content;
        if (maxLength > 0 && content.length > maxLength) {
          content = content.slice(0, maxLength) + '...';
        }
        results.push(`## ${section.title}\n\n${content}`);
      }

      // Search children
      if (section.children.length > 0) {
        searchSections(section.children);
      }
    }
  }

  searchSections(sections);
  return results.join('\n\n');
}

/**
 * Flatten sections to simple list
 */
function flattenSections(sections: Section[]): Array<{ level: number; title: string }> {
  const result: Array<{ level: number; title: string }> = [];

  function traverse(sectionList: Section[]) {
    for (const section of sectionList) {
      result.push({ level: section.level, title: section.title });
      if (section.children.length > 0) {
        traverse(section.children);
      }
    }
  }

  traverse(sections);
  return result;
}

/**
 * Find all equation labels that are referenced in the text
 * Looks for \ref{label}, \eqref{label}, (\ref{label}), Eq.~\ref{label}, etc.
 */
function findReferencedLabels(texContent: string): Set<string> {
  const referencedLabels = new Set<string>();

  // Match \ref{...}, \eqref{...}, \cref{...}, \autoref{...}
  const refPatterns = [
    /\\ref\{([^}]+)\}/g,
    /\\eqref\{([^}]+)\}/g,
    /\\cref\{([^}]+)\}/g,
    /\\autoref\{([^}]+)\}/g,
    /\\Cref\{([^}]+)\}/g,
  ];

  for (const pattern of refPatterns) {
    let match;
    while ((match = pattern.exec(texContent)) !== null) {
      // Handle multiple labels like \ref{eq1,eq2}
      const labels = match[1].split(',').map(l => l.trim());
      for (const label of labels) {
        referencedLabels.add(label);
      }
    }
  }

  return referencedLabels;
}

/**
 * Check if an equation is referenced and prioritize referenced equations
 */
function validateAndPrioritizeEquations(
  equations: Array<{
    type: 'display' | 'align' | 'gather' | 'inline' | 'eqnarray' | 'multline';
    latex: string;
    label?: string;
  }>,
  referencedLabels: Set<string>
): Array<{
  type: 'display' | 'align' | 'gather' | 'inline' | 'eqnarray' | 'multline';
  latex: string;
  label?: string;
  referenced?: boolean;
}> {
  // Mark equations as referenced or not
  const markedEquations = equations.map(eq => ({
    ...eq,
    referenced: eq.label ? referencedLabels.has(eq.label) : false,
  }));

  // Separate referenced and unreferenced
  const referenced = markedEquations.filter(eq => eq.referenced);
  const unreferenced = markedEquations.filter(eq => !eq.referenced);

  // Prioritize referenced equations
  // Also prioritize labeled equations (even if not referenced) over unlabeled ones
  const labeledUnreferenced = unreferenced.filter(eq => eq.label);
  const unlabeled = unreferenced.filter(eq => !eq.label);

  // Return all equations: referenced first, then labeled, then unlabeled
  return [...referenced, ...labeledUnreferenced, ...unlabeled];
}

/**
 * Analyze a single paper
 */
async function analyzeSinglePaper(
  identifier: string,
  options: Required<DeepAnalyzeOptions>
): Promise<DeepPaperAnalysis> {
  // Step 1: Resolve identifier and get paper metadata
  let recid = '';
  let arxivId: string | null = null;
  let title = 'Unknown';

  try {
    // Try to get paper info from INSPIRE
    const inspireMatch = identifier.match(/^inspire:(\d+)$/);
    if (inspireMatch) {
      // Explicit INSPIRE ID
      recid = inspireMatch[1];
      const paper = await api.getPaper(recid);
      title = paper.title;
      arxivId = paper.arxiv_id ?? null;
    } else if (/^\d+$/.test(identifier)) {
      // It's a raw recid
      recid = identifier;
      const paper = await api.getPaper(recid);
      title = paper.title;
      arxivId = paper.arxiv_id ?? null;
    } else {
      // Try to resolve as arXiv ID or DOI
      arxivId = await resolveArxivId(identifier);
      if (arxivId) {
        // Get paper info from INSPIRE via arXiv ID
        const result = await api.search(`arxiv:${arxivId}`, { size: 1 });
        if (result.papers.length > 0) {
          recid = result.papers[0].recid || '';
          title = result.papers[0].title;
        }
      }
    }

    if (!arxivId) {
      return {
        recid,
        title,
        success: false,
        error: 'Could not resolve arXiv ID',
      };
    }

    // Step 2: Download LaTeX source
    const content = await getPaperContent({
      identifier: arxivId,
      prefer: 'latex',
      extract: true,
    });

    if (!content.success || content.source_type !== 'latex') {
      return {
        recid,
        arxiv_id: arxivId,
        title,
        success: false,
        error: content.fallback_reason || 'LaTeX source not available',
      };
    }

    if (!content.main_tex) {
      return {
        recid,
        arxiv_id: arxivId,
        title,
        success: false,
        error: 'Could not identify main .tex file',
      };
    }

    // Step 3: Parse LaTeX
    const doc = parseTexFile(content.main_tex);
    const resolved = resolveAllIncludes(doc);
    const ast = resolved.ast;

    // Step 4: Extract document structure
    const docStructure = extractDocumentStructure(ast);

    // Step 5: Extract equations (if enabled)
    let equations: DeepPaperAnalysis['equations'] = undefined;
    if (options.extract_equations) {
      let eqs = extractEqs(ast);

      // Filter inline if not requested
      if (!options.include_inline_math) {
        eqs = eqs.filter(eq => eq.type !== 'inline');
      }

      // Find referenced labels for cross-reference validation
      const referencedLabels = findReferencedLabels(content.main_tex);

      // Validate and prioritize equations (referenced ones first, no limit)
      equations = validateAndPrioritizeEquations(
        eqs.map(eq => ({
          type: eq.type,
          latex: eq.latex,
          label: eq.label,
        })),
        referencedLabels
      );
    }

    // Step 6: Extract theorems (if enabled)
    let theorems: DeepPaperAnalysis['theorems'] = undefined;
    if (options.extract_theorems) {
      const thms = extractThms(ast, {
        include_proofs: true,
        max_content_length: options.max_section_length,
      });

      theorems = thms.map(thm => ({
        type: thm.type,
        env_name: thm.env_name,
        title: thm.title,
        label: thm.label,
        content_text: thm.content_text,
        has_proof: !!thm.proof,
      }));
    }

    // Step 7: Extract sections with content for methodology/conclusions
    const sectionsWithContent = extractSectionsWithContent(ast, {
      includeContent: true,
      maxContentLength: options.max_section_length,
    });

    // Step 8: Find methodology sections
    let methodology: string | undefined;
    if (options.extract_methodology) {
      methodology = findSectionsByKeywords(
        sectionsWithContent,
        METHODOLOGY_KEYWORDS,
        options.max_section_length
      ) || undefined;
    }

    // Step 9: Find conclusion sections
    let conclusions: string | undefined;
    if (options.extract_conclusions) {
      conclusions = findSectionsByKeywords(
        sectionsWithContent,
        CONCLUSION_KEYWORDS,
        options.max_section_length
      ) || undefined;
    }

    // Step 9a: Find introduction sections
    const introduction = findSectionsByKeywords(
      sectionsWithContent,
      INTRODUCTION_KEYWORDS,
      options.max_section_length
    ) || undefined;

    // Step 9b: Find results sections
    const results = findSectionsByKeywords(
      sectionsWithContent,
      RESULTS_KEYWORDS,
      options.max_section_length
    ) || undefined;

    // Step 9c: Find discussion sections
    const discussion = findSectionsByKeywords(
      sectionsWithContent,
      DISCUSSION_KEYWORDS,
      options.max_section_length
    ) || undefined;

    // Step 10: Identify key equations with importance scoring (no limit)
    let keyEquations: DeepPaperAnalysis['key_equations'] = undefined;
    if (options.extract_equations) {
      const keyEqs = identifyKeyEquations(ast, content.main_tex, {
        min_score: 15,
        include_inline: options.include_inline_math,
        context_window: 200,
      });

      if (keyEqs.length > 0) {
        keyEquations = keyEqs.map(eq => ({
          latex: eq.latex,
          label: eq.label,
          importance_score: eq.importance_score,
          reference_count: eq.reference_count,
          section: eq.section,
          context_text: eq.context_text,
        }));
      }
    }

    return {
      recid,
      arxiv_id: arxivId,
      title: docStructure.title || title,
      success: true,
      structure: {
        title: docStructure.title || title,
        authors: docStructure.authors,
        abstract: docStructure.abstract,
        sections: flattenSections(docStructure.sections),
      },
      equations,
      theorems,
      methodology,
      conclusions,
      introduction,
      results,
      discussion,
      key_equations: keyEquations,
    };

  } catch (error) {
    return {
      recid,
      arxiv_id: arxivId ?? undefined,
      title,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deep analyze papers by extracting content from LaTeX sources
 */
export async function deepAnalyze(
  params: DeepAnalyzeParams
): Promise<DeepAnalyzeResult> {
  const { identifiers } = params;
  const options: Required<DeepAnalyzeOptions> = {
    ...DEFAULT_OPTIONS,
    ...params.options,
  };

  // Analyze papers in batches for better performance
  const papers: DeepPaperAnalysis[] = [];
  for (let i = 0; i < identifiers.length; i += BATCH_SIZE) {
    const batch = identifiers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(id => analyzeSinglePaper(id, options))
    );
    papers.push(...results);
  }

  // Build summary
  const successful = papers.filter(p => p.success).length;
  const failed = papers.length - successful;
  const totalEquations = papers.reduce(
    (sum, p) => sum + (p.equations?.length || 0),
    0
  );
  const totalTheorems = papers.reduce(
    (sum, p) => sum + (p.theorems?.length || 0),
    0
  );

  return {
    papers,
    summary: {
      total_papers: papers.length,
      successful,
      failed,
      total_equations: totalEquations,
      total_theorems: totalTheorems,
    },
  };
}
