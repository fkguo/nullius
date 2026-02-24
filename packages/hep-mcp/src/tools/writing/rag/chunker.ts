/**
 * LaTeX Chunker
 *
 * Parses LaTeX documents and produces EvidenceChunks with:
 * - Precise source locators
 * - Reference relationships (for Sticky Retrieval)
 * - Navigation links (prev/next)
 * - Semantic descriptions for non-text content
 *
 * Key features:
 * - Section hierarchy tracking
 * - Context chunk generation
 * - Citation extraction
 * - Label/ref relationship indexing
 *
 * @module rag/chunker
 */

import * as crypto from 'crypto';
import { latexParser } from 'latex-utensils';
import type * as LU from 'latex-utensils';
import type {
  EvidenceChunk,
  ChunkType,
  ChunkLocator,
  ChunkMetadata,
  ChunkerOptions,
} from './types.js';
import {
  tokenizeHEP,
  stripLatexPreserveHEP,
  estimateTokens,
} from './hepTokenizer.js';
import {
  preprocessDualText,
  removeComments,
  findContentStart,
} from './preprocessor.js';
import { safeParseLatex } from '../../research/latex/parserHarness.js';
import { stringifyLatexNodes } from '../../research/latex/astStringify.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_COMMANDS = [
  'chapter',
  'section',
  'subsection',
  'subsubsection',
];

const EQUATION_ENVIRONMENTS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'eqnarray',
  'eqnarray*',
  'subequations',
  'displaymath',
  'flalign',
  'flalign*',
]);

const THEOREM_ENVIRONMENTS = new Set([
  'theorem',
  'lemma',
  'proposition',
  'corollary',
  'definition',
  'remark',
  'example',
  'proof',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type LatexNode = LU.latexParser.Node;
type LatexAst = LU.latexParser.LatexAst;

interface SectionContext {
  path: string[];
  level: number;
}

interface ChunkCandidate {
  type: ChunkType;
  latex: string;
  start: number;
  end: number;
  label?: string;
  refs: {
    outgoing: string[];
    outgoing_cites: string[];
    incoming: string[];
  };
  envType?: string;
  sectionPath: string[];
}

interface RefIndex {
  labelToRefs: Map<string, string[]>;
  citekeyToRefs: Map<string, string[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex');
}

function generateChunkId(
  paperId: string,
  filePath: string,
  start: number,
  end: number,
  type: ChunkType
): string {
  return md5(`${paperId}:${filePath}:${start}:${end}:${type}`).slice(0, 16);
}

function generateContentHash(content: string): string {
  return md5(content).slice(0, 12);
}

function countLinesUntilOffset(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference Extraction
// ─────────────────────────────────────────────────────────────────────────────

function extractRefs(latex: string): { labels: string[]; refs: string[]; cites: string[] } {
  const labels: string[] = [];
  const refs: string[] = [];
  const cites: string[] = [];

  // Extract labels
  const labelPattern = /\\label\{([^}]+)\}/g;
  let match;
  while ((match = labelPattern.exec(latex)) !== null) {
    labels.push(match[1]);
  }

  // Extract refs
  const refPattern = /\\(?:ref|eqref|autoref|cref|Cref)\{([^}]+)\}/g;
  while ((match = refPattern.exec(latex)) !== null) {
    const targets = match[1].split(',').map((t) => t.trim());
    refs.push(...targets);
  }

  // Extract citations
  const citePattern = /\\cite(?:p|t|alp|alt|author|year)?\{([^}]+)\}/g;
  while ((match = citePattern.exec(latex)) !== null) {
    const keys = match[1].split(',').map((k) => k.trim());
    cites.push(...keys);
  }

  return { labels, refs, cites };
}

// ─────────────────────────────────────────────────────────────────────────────
// AST Traversal
// ─────────────────────────────────────────────────────────────────────────────

function stringifyContent(content: LatexNode[]): string {
  return stringifyLatexNodes(content);
}

function getLocation(node: LatexNode): { start: number; end: number } | null {
  const loc = (node as { location?: LU.latexParser.Location }).location;
  if (!loc) return null;
  return { start: loc.start.offset, end: loc.end.offset };
}

function extractSectionTitle(cmd: LU.latexParser.Command): string {
  for (const arg of cmd.args || []) {
    if (latexParser.isGroup(arg)) {
      return stringifyContent(arg.content).replace(/[{}]/g, '').trim();
    }
  }
  return 'Untitled';
}

// ─────────────────────────────────────────────────────────────────────────────
// Paragraph Extraction
// ─────────────────────────────────────────────────────────────────────────────

function extractParagraphs(
  normTex: string,
  sectionContext: SectionContext
): ChunkCandidate[] {
  const candidates: ChunkCandidate[] = [];

  // Split by double newlines (paragraph breaks)
  const paragraphPattern = /(?:^|\n\n)((?:(?!\n\n).)+)/gs;
  let match;
  while ((match = paragraphPattern.exec(normTex)) !== null) {
    const text = match[1].trim();

    // Skip short or empty paragraphs
    if (text.length < 50) continue;

    // Skip paragraphs that are just environments
    if (/^\\begin\{/.test(text) && /\\end\{[^}]+\}$/.test(text)) continue;

    // Skip frontmatter (author lists, affiliations)
    if (/^\\author|^\\affiliation|^\\email|^\\thanks/i.test(text)) continue;

    const start = match.index + (match[0].startsWith('\n\n') ? 2 : 0);
    const { labels, refs, cites } = extractRefs(text);

    candidates.push({
      type: 'paragraph',
      latex: text,
      start,
      end: start + text.length,
      label: labels[0],
      refs: {
        outgoing: refs,
        outgoing_cites: cites,
        incoming: [],
      },
      sectionPath: [...sectionContext.path],
    });
  }

  return candidates;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Chunker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of chunking a paper
 */
export interface ChunkResult {
  chunks: EvidenceChunk[];
  refIndex: RefIndex;
  stats: {
    paragraphs: number;
    equations: number;
    figures: number;
    tables: number;
    definitions: number;
    total: number;
  };
}

/**
 * Chunk a LaTeX paper into evidence chunks
 *
 * @param rawTex - Raw LaTeX content
 * @param paperId - INSPIRE record ID
 * @param filePath - Source file path
 * @param options - Chunker options
 * @returns ChunkResult with all chunks and reference index
 */
export function chunkPaper(
  rawTex: string,
  paperId: string,
  filePath: string,
  options: Partial<ChunkerOptions> = {}
): ChunkResult {
  const opts: ChunkerOptions = { ...DEFAULT_CHUNKER_OPTIONS_IMPL, ...options };

  // 1. Preprocess: remove comments, expand macros
  const cleanTex = removeComments(rawTex);
  const { normTex, offsetMap: _offsetMap } = preprocessDualText(cleanTex);

  // 2. Find content start (skip frontmatter)
  const contentStart = opts.skip_frontmatter ? findContentStart(normTex) : 0;
  const bodyTex = normTex.slice(contentStart);

  // 3. Parse (fail-fast; no regex/truncation fallbacks)
  const parseResult = safeParseLatex(bodyTex, {
    timeout: 10000,
    file: filePath,
  });

  // 4. Extract chunks based on parse result
  const candidates: ChunkCandidate[] = [];
  const sectionContext: SectionContext = { path: [], level: 0 };

  // AST-based extraction
  extractFromAst(parseResult.ast, candidates, sectionContext, bodyTex, contentStart, opts);

  // 5. Build reference index (using proper chunk IDs)
  const refIndex = buildRefIndex(candidates, paperId, filePath);

  // 6. Add incoming refs
  for (const candidate of candidates) {
    if (candidate.label) {
      const refs = refIndex.labelToRefs.get(candidate.label) || [];
      candidate.refs.incoming = refs;
    }
  }

  // 7. Convert to EvidenceChunks
  const chunks = candidates.map((c, idx) =>
    candidateToChunk(c, paperId, filePath, rawTex, opts, idx, candidates)
  );

  // 8. Calculate stats
  const stats = {
    paragraphs: chunks.filter((c) => c.type === 'paragraph').length,
    equations: chunks.filter((c) =>
      c.type === 'equation' || c.type === 'equation_context'
    ).length,
    figures: chunks.filter((c) =>
      c.type === 'figure' || c.type === 'figure_context'
    ).length,
    tables: chunks.filter((c) =>
      c.type === 'table' || c.type === 'table_context'
    ).length,
    definitions: chunks.filter((c) => c.type === 'definition').length,
    total: chunks.length,
  };

  return { chunks, refIndex, stats };
}

// ─────────────────────────────────────────────────────────────────────────────
// AST Extraction
// ─────────────────────────────────────────────────────────────────────────────

function extractFromAst(
  ast: LatexAst,
  candidates: ChunkCandidate[],
  sectionContext: SectionContext,
  normTex: string,
  contentOffset: number,
  opts: ChunkerOptions
): void {
  // Use latexParser.findAll for efficient traversal
  const { findAll } = latexParser;

  // Extract sections for context tracking
  const sectionNodes = findAll(ast.content, (n) =>
    latexParser.isCommand(n) && SECTION_COMMANDS.includes(n.name)
  );

  // Extract environments
  const envNodes = findAll(ast.content, (n) => latexParser.isEnvironment(n));

  // Process sections to build hierarchy
  const sections: { title: string; level: number; offset: number }[] = [];
  for (const { node } of sectionNodes) {
    const cmd = node as LU.latexParser.Command;
    const loc = getLocation(node);
    if (loc) {
      sections.push({
        title: extractSectionTitle(cmd),
        level: SECTION_COMMANDS.indexOf(cmd.name),
        offset: loc.start + contentOffset,
      });
    }
  }

  // Process environments
  for (const { node } of envNodes) {
    const env = node as LU.latexParser.Environment;
    const loc = getLocation(node);
    if (!loc) continue;

    const latex = normTex.slice(loc.start, loc.end);
    const { labels, refs, cites } = extractRefs(latex);

    // Update section context
    const currentSection = findCurrentSection(
      sections,
      loc.start + contentOffset
    );
    if (currentSection) {
      sectionContext.path = [currentSection.title];
    }

    if (opts.include_equations && EQUATION_ENVIRONMENTS.has(env.name)) {
      // Equation chunk
      candidates.push({
        type: 'equation',
        latex,
        start: loc.start + contentOffset,
        end: loc.end + contentOffset,
        label: labels[0],
        refs: { outgoing: refs, outgoing_cites: cites, incoming: [] },
        envType: env.name,
        sectionPath: [...sectionContext.path],
      });
    } else if (opts.include_figures && env.name.startsWith('figure')) {
      // Figure chunk
      candidates.push({
        type: 'figure',
        latex,
        start: loc.start + contentOffset,
        end: loc.end + contentOffset,
        label: labels[0],
        refs: { outgoing: refs, outgoing_cites: cites, incoming: [] },
        sectionPath: [...sectionContext.path],
      });
    } else if (opts.include_tables && env.name.startsWith('table')) {
      // Table chunk
      candidates.push({
        type: 'table',
        latex,
        start: loc.start + contentOffset,
        end: loc.end + contentOffset,
        label: labels[0],
        refs: { outgoing: refs, outgoing_cites: cites, incoming: [] },
        sectionPath: [...sectionContext.path],
      });
    } else if (THEOREM_ENVIRONMENTS.has(env.name)) {
      // Definition/theorem chunk
      candidates.push({
        type: 'definition',
        latex,
        start: loc.start + contentOffset,
        end: loc.end + contentOffset,
        label: labels[0],
        refs: { outgoing: refs, outgoing_cites: cites, incoming: [] },
        sectionPath: [...sectionContext.path],
      });
    }
  }

  // Extract paragraphs from remaining text
  const paragraphs = extractParagraphs(normTex, sectionContext);
  candidates.push(...paragraphs);
}

function findCurrentSection(
  sections: { title: string; level: number; offset: number }[],
  offset: number
): { title: string; level: number } | null {
  let current: { title: string; level: number } | null = null;
  for (const s of sections) {
    if (s.offset <= offset) {
      current = { title: s.title, level: s.level };
    } else {
      break;
    }
  }
  return current;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference Index
// ─────────────────────────────────────────────────────────────────────────────

function buildRefIndex(
  candidates: ChunkCandidate[],
  paperId: string,
  filePath: string
): RefIndex {
  const labelToRefs = new Map<string, string[]>();
  const citekeyToRefs = new Map<string, string[]>();

  for (const c of candidates) {
    // Use same ID generation as candidateToChunk for consistency
    const chunkId = generateChunkId(paperId, filePath, c.start, c.end, c.type);

    for (const ref of c.refs.outgoing) {
      const existing = labelToRefs.get(ref) || [];
      existing.push(chunkId);
      labelToRefs.set(ref, existing);
    }

    for (const cite of c.refs.outgoing_cites) {
      const existing = citekeyToRefs.get(cite) || [];
      existing.push(chunkId);
      citekeyToRefs.set(cite, existing);
    }
  }

  return { labelToRefs, citekeyToRefs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunk Conversion
// ─────────────────────────────────────────────────────────────────────────────

function candidateToChunk(
  candidate: ChunkCandidate,
  paperId: string,
  filePath: string,
  rawTex: string,
  _opts: ChunkerOptions,
  idx: number,
  allCandidates: ChunkCandidate[]
): EvidenceChunk {
  const id = generateChunkId(
    paperId,
    filePath,
    candidate.start,
    candidate.end,
    candidate.type
  );

  const { index_tokens: _tokens, display_text: _display_text } = tokenizeHEP(candidate.latex);
  const text = stripLatexPreserveHEP(candidate.latex);

  const locator: ChunkLocator = {
    paper_id: paperId,
    file_path: filePath,
    section_path: candidate.sectionPath,
    label: candidate.label,
    byte_start: candidate.start,
    byte_end: candidate.end,
    line_start: countLinesUntilOffset(rawTex, candidate.start),
    line_end: countLinesUntilOffset(rawTex, candidate.end),
  };

  const metadata: ChunkMetadata = {
    has_math: /\$|\\\[|\\begin\{(equation|align)/.test(candidate.latex),
    has_citation: /\\cite/.test(candidate.latex),
    word_count: text.split(/\s+/).filter((w) => w.length > 0).length,
    token_estimate: estimateTokens(candidate.latex),
    env_type: candidate.envType,
  };

  // Determine prev/next IDs
  const navigation = {
    prev_id:
      idx > 0
        ? generateChunkId(
            paperId,
            filePath,
            allCandidates[idx - 1].start,
            allCandidates[idx - 1].end,
            allCandidates[idx - 1].type
          )
        : undefined,
    next_id:
      idx < allCandidates.length - 1
        ? generateChunkId(
            paperId,
            filePath,
            allCandidates[idx + 1].start,
            allCandidates[idx + 1].end,
            allCandidates[idx + 1].type
          )
        : undefined,
  };

  // Generate semantic description for non-text chunks
  let semanticDescription: string | undefined;
  if (candidate.type === 'equation') {
    semanticDescription = generateEquationDescription(candidate.latex);
  } else if (candidate.type === 'table') {
    semanticDescription = generateTableDescription(candidate.latex);
  } else if (candidate.type === 'figure') {
    semanticDescription = generateFigureDescription(candidate.latex);
  }

  return {
    id,
    content_hash: generateContentHash(candidate.latex),
    type: candidate.type,
    content_latex: candidate.latex,
    text,
    semantic_description: semanticDescription,
    locator,
    refs: candidate.refs,
    navigation,
    metadata,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Semantic Description Generation
// ─────────────────────────────────────────────────────────────────────────────

function generateEquationDescription(latex: string): string {
  const parts: string[] = [];

  // Check for common equation types
  if (/\\frac\{d/.test(latex) || /\\partial/.test(latex)) {
    parts.push('differential equation');
  }
  if (/\\int/.test(latex)) {
    parts.push('integral');
  }
  if (/\\sum/.test(latex)) {
    parts.push('summation');
  }
  if (/\\chi\^2|\\chi_/.test(latex)) {
    parts.push('chi-squared');
  }
  if (/\\sqrt/.test(latex)) {
    parts.push('square root');
  }
  if (/\\Gamma/.test(latex)) {
    parts.push('decay width');
  }
  if (/\\sigma/.test(latex) || /\\cross/.test(latex)) {
    parts.push('cross section');
  }
  if (/\\pm|\\mp/.test(latex)) {
    parts.push('with uncertainties');
  }

  // Extract label hint
  const labelMatch = latex.match(/\\label\{([^}]+)\}/);
  if (labelMatch) {
    const label = labelMatch[1];
    if (label.includes('mass')) parts.push('mass formula');
    if (label.includes('width')) parts.push('width formula');
    if (label.includes('decay')) parts.push('decay formula');
    if (label.includes('fit')) parts.push('fit function');
  }

  return parts.length > 0
    ? `Equation: ${parts.join(', ')}`
    : 'Mathematical equation';
}

function generateTableDescription(latex: string): string {
  const parts: string[] = ['Data table'];

  // Extract caption
  const captionMatch = latex.match(/\\caption\{([^}]+)\}/);
  if (captionMatch) {
    const caption = captionMatch[1].slice(0, 100);
    parts.push(`: ${caption}`);
  }

  // Check for common table content
  if (/GeV|TeV|MeV/.test(latex)) {
    parts.push('with energy values');
  }
  if (/\\pm|\\mp/.test(latex)) {
    parts.push('with uncertainties');
  }
  if (/systematic|statistical/.test(latex)) {
    parts.push('systematic/statistical errors');
  }

  return parts.join(' ');
}

function generateFigureDescription(latex: string): string {
  const parts: string[] = ['Figure'];

  // Extract caption
  const captionMatch = latex.match(/\\caption\{([^}]+)\}/);
  if (captionMatch) {
    const caption = captionMatch[1].slice(0, 100);
    parts.push(`: ${caption}`);
  }

  // Check for plot type indicators
  if (/fit|fitting/.test(latex)) {
    parts.push('showing fit results');
  }
  if (/spectrum|distribution/.test(latex)) {
    parts.push('showing spectrum/distribution');
  }
  if (/signal|background/.test(latex)) {
    parts.push('showing signal/background');
  }

  return parts.join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Chunk Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate context chunks for non-text elements
 * (equation_context, table_context, figure_context)
 *
 * Takes the surrounding paragraphs that reference the element.
 */
export function generateContextChunks(
  chunks: EvidenceChunk[],
  windowSize: number = 2
): EvidenceChunk[] {
  const result: EvidenceChunk[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    result.push(chunk);

    // Only generate context for equations, tables, figures
    if (!['equation', 'table', 'figure'].includes(chunk.type)) {
      continue;
    }

    // Gather surrounding paragraphs
    const contextParagraphs: string[] = [];

    // Look backward
    for (let j = i - 1; j >= Math.max(0, i - windowSize); j--) {
      if (chunks[j].type === 'paragraph') {
        contextParagraphs.unshift(chunks[j].text);
      }
    }

    // Look forward
    for (let j = i + 1; j <= Math.min(chunks.length - 1, i + windowSize); j++) {
      if (chunks[j].type === 'paragraph') {
        contextParagraphs.push(chunks[j].text);
      }
    }

    if (contextParagraphs.length > 0) {
      const contextType = `${chunk.type}_context` as ChunkType;
      const contextChunk: EvidenceChunk = {
        ...chunk,
        id: `${chunk.id}_ctx`,
        type: contextType,
        text: contextParagraphs.join('\n\n'),
        content_latex: contextParagraphs.join('\n\n'),
        metadata: {
          ...chunk.metadata,
          is_pruned: false,
        },
      };
      result.push(contextChunk);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Options (implementation)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CHUNKER_OPTIONS_IMPL: ChunkerOptions = {
  max_paragraph_length: 2000,
  include_equations: true,
  include_tables: true,
  include_figures: true,
  table_prune_threshold: 20,
  context_window: 2,
  skip_frontmatter: true,
  max_paragraph_tokens: 500,
};
