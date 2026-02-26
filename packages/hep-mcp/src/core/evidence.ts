import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { latexParser } from 'latex-utensils';
import { invalidParams, notFound } from '@autoresearch/shared';
import pLimit from 'p-limit';
import { resolvePathWithinParent } from '../data/pathGuard.js';
import { getProject, updateProjectUpdatedAt } from './projects.js';
import {
  getProjectPaperEvidenceCatalogPath,
  getProjectPaperJsonPath,
  getProjectPaperLatexDir,
  getProjectPaperLatexExtractedDir,
} from './paths.js';
import { getPaper, listPapers, upsertPaper, type HepPaper } from './papers.js';
import {
  extractCitations,
  extractEnhancedEquations,
  extractFigures,
  extractTables,
  extractTheorems,
  extractText,
  analyzeProjectStructure,
  buildMacroWrappedEnvironmentPairsFromContent,
  matchMacroWrappedEnvironmentAt,
  mapLocatorToSource,
  mergeProjectContentWithSourceMap,
  nodeToLocator,
  parseLatex,
  playbackLocator,
  type FileContentProvider,
  type LatexAst,
  type LatexNode,
  type Locator,
  type SourceMap,
} from '../tools/research/latex/index.js';
import { ensureDir } from '../data/dataDir.js';
import { BudgetTrackerV1, writeProjectDiagnosticsArtifact } from './diagnostics.js';
import { normalizeTextPreserveUnits } from '../utils/textNormalization.js';

// NEW-R05: Import generated types from evidence schema SSOT (via shared barrel)
// The generated types come from meta/schemas/evidence_catalog_item_v1.schema.json
import type {
  EvidenceType,
  LatexLocatorV1,
  PdfLocatorV1,
  EvidenceCatalogItemV1,
} from '@autoresearch/shared';

// Re-export for consumers that import from this module
export type { EvidenceType, LatexLocatorV1, PdfLocatorV1, EvidenceCatalogItemV1 };

// Narrow type for this module: evidence.ts only produces/queries LaTeX evidence.
// Items produced here always have LatexLocatorV1 locators.
type LatexEvidenceItem = EvidenceCatalogItemV1 & { locator: LatexLocatorV1 };

export interface BuildEvidenceResult {
  project_id: string;
  paper_id: string;
  paper_uri: string;
  catalog_uri: string;
  diagnostics_uri: string;
  summary: {
    total: number;
    by_type: Record<string, number>;
    copied_files: number;
    main_tex: string;
    warnings_total: number;
    warnings: string[];
  };
}

export interface QueryEvidenceHit {
  evidence_id: string;
  project_id: string;
  paper_id: string;
  type: EvidenceType;
  score: number;
  text_preview: string;
  locator: LatexLocatorV1 | PdfLocatorV1;
}

export interface QueryEvidenceResult {
  project_id: string;
  query: string;
  total_hits: number;
  hits: QueryEvidenceHit[];
  /** Optional diagnostics artifact (project-level) */
  diagnostics_uri?: string;
  warnings_total?: number;
  warnings?: string[];
}

export interface EvidenceSnippetResult {
  project_id: string;
  paper_id: string;
  evidence_id: string;
  locator: LatexLocatorV1 | PdfLocatorV1;
  playback: {
    file: string;
    line: number;
    column: number;
    snippet: string;
  };
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeText(text: string): string {
  return normalizeTextPreserveUnits(text);
}

function normalizePathForCatalog(relPath: string): string {
  const normalized = relPath.split(path.sep).join('/');
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function makePaperId(params: { paper_id?: string; identifier?: string; main_tex_path?: string }): string {
  if (params.paper_id) return params.paper_id;

  const identifier = params.identifier?.trim();
  if (identifier) {
    if (/^\d+$/.test(identifier)) return `recid_${identifier}`;

    const arxivLike = identifier
      .replace(/^arxiv:/i, '')
      .replace(/^https?:\/\/arxiv\.org\/abs\//i, '')
      .trim();
    if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(arxivLike) || /^[a-z-]+\/\d{7}(v\d+)?$/i.test(arxivLike)) {
      return `arxiv_${arxivLike.replace(/[\/.]/g, '_')}`;
    }

    return `paper_${sha256Hex(identifier).slice(0, 16)}`;
  }

  const mainTexPath = params.main_tex_path ? path.resolve(params.main_tex_path) : '';
  if (mainTexPath) {
    try {
      const content = fs.readFileSync(mainTexPath, 'utf-8');
      return `local_${sha256Hex(content).slice(0, 16)}`;
    } catch {
      return `local_${sha256Hex(mainTexPath).slice(0, 16)}`;
    }
  }

  throw invalidParams('Either identifier or main_tex_path must be provided');
}

function buildEvidenceId(paperId: string, type: EvidenceType, locator: LatexLocatorV1, text: string): string {
  const material = JSON.stringify({
    paper_id: paperId,
    type,
    locator: {
      file: locator.file,
      offset: locator.offset,
      endOffset: locator.endOffset,
      anchor: locator.anchor,
    },
    text_preview: text.slice(0, 200),
  });
  const hash = sha256Hex(material).slice(0, 16);
  return `ev_${paperId}_${type}_${hash}`;
}

function getDocumentContent(ast: LatexAst): LatexNode[] {
  if (ast.kind !== 'ast.root') return [];
  for (const node of ast.content) {
    if (latexParser.isEnvironment(node) && node.name === 'document') {
      return node.content;
    }
  }
  return ast.content;
}

function findFirstCommandRecursive(nodes: LatexNode[], name: string): LatexNode | null {
  for (const node of nodes) {
    if (latexParser.isCommand(node) && node.name === name) return node;
    if (latexParser.isEnvironment(node)) {
      const found = findFirstCommandRecursive(node.content, name);
      if (found) return found;
    }
    if (latexParser.isGroup(node)) {
      const found = findFirstCommandRecursive(node.content, name);
      if (found) return found;
    }
  }
  return null;
}

function findFirstEnvironmentRecursive(nodes: LatexNode[], name: string): LatexNode | null {
  for (const node of nodes) {
    if (latexParser.isEnvironment(node) && node.name === name) return node;
    if (latexParser.isEnvironment(node)) {
      const found = findFirstEnvironmentRecursive(node.content, name);
      if (found) return found;
    }
    if (latexParser.isGroup(node)) {
      const found = findFirstEnvironmentRecursive(node.content, name);
      if (found) return found;
    }
  }
  return null;
}

function hasLocation(node: LatexNode): boolean {
  return Boolean((node as { location?: { start?: { offset?: number } } }).location?.start?.offset !== undefined);
}

function firstLocated(nodes: LatexNode[]): LatexNode | null {
  for (const node of nodes) {
    if (hasLocation(node)) return node;
  }
  return null;
}

function lastLocated(nodes: LatexNode[]): LatexNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node && hasLocation(node)) return node;
  }
  return null;
}

function mergeSpanLocator(start: Locator, end: Locator): Locator {
  const endOffset = end.endOffset ?? end.offset;
  const endLine = end.endLine ?? end.line;
  const endColumn = end.endColumn ?? end.column;
  return {
    ...start,
    endOffset,
    endLine,
    endColumn,
  };
}

function mapLocatorToCatalogLocator(
  locator: Locator,
  sourceMap: SourceMap,
  getFileContent: FileContentProvider,
  latexExtractedDir: string
): LatexLocatorV1 {
  const mapped = mapLocatorToSource(locator, sourceMap, getFileContent);
  const rel = path.relative(latexExtractedDir, mapped.file);
  if (rel.startsWith('..')) {
    throw new Error(`Mapped locator points outside extracted LaTeX dir: ${mapped.file}`);
  }
  return {
    kind: 'latex',
    file: normalizePathForCatalog(rel),
    offset: mapped.offset,
    line: mapped.line,
    column: mapped.column,
    endOffset: mapped.endOffset,
    endLine: mapped.endLine,
    endColumn: mapped.endColumn,
    anchor: mapped.anchor,
  };
}

function getEvidenceCatalogUri(projectId: string, paperId: string): string {
  return `hep://projects/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(paperId)}/evidence/catalog`;
}

function getPaperUri(projectId: string, paperId: string): string {
  return `hep://projects/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(paperId)}`;
}

function copyProjectFiles(params: {
  sourceMainTexPath: string;
  destExtractedDir: string;
}): { destMainTexPath: string; copied: number; warnings: string[]; mainTexRel: string } {
  const warnings: string[] = [];
  const sourceMainTexPath = path.resolve(params.sourceMainTexPath);
  const destExtractedDir = params.destExtractedDir;
  ensureDir(destExtractedDir);

  let structure: ReturnType<typeof analyzeProjectStructure> | null = null;
  try {
    structure = analyzeProjectStructure(sourceMainTexPath);
  } catch (err) {
    warnings.push(`analyzeProjectStructure failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const baseDir = structure?.baseDir ?? path.dirname(sourceMainTexPath);
  const files = structure?.files ?? [{ path: sourceMainTexPath, role: 'main' as const }];

  let copied = 0;
  let mainTexRel = path.relative(baseDir, sourceMainTexPath);
  if (mainTexRel.startsWith('..')) {
    mainTexRel = path.basename(sourceMainTexPath);
    warnings.push('main_tex_path is outside inferred baseDir; flattening to basename');
  }

  for (const file of files) {
    const rel = path.relative(baseDir, file.path);
    if (rel.startsWith('..')) {
      warnings.push(`skipped file outside baseDir: ${file.path}`);
      continue;
    }

    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(file.path);
    } catch {
      warnings.push(`skipped unreadable file: ${file.path}`);
      continue;
    }
    if (lst.isSymbolicLink()) {
      warnings.push(`skipped symlink file (unsafe): ${file.path}`);
      continue;
    }
    if (!lst.isFile()) {
      warnings.push(`skipped non-file path: ${file.path}`);
      continue;
    }

    const destPath = resolvePathWithinParent(destExtractedDir, path.join(destExtractedDir, rel), 'latex_file_copy');
    ensureDir(path.dirname(destPath));
    fs.copyFileSync(file.path, destPath);
    copied += 1;
  }

  const destMainTexPath = resolvePathWithinParent(destExtractedDir, path.join(destExtractedDir, mainTexRel), 'latex_main_tex');
  if (!fs.existsSync(destMainTexPath)) {
    throw new Error(`Copied main tex not found at expected path: ${destMainTexPath}`);
  }

  return { destMainTexPath, copied, warnings, mainTexRel: normalizePathForCatalog(mainTexRel) };
}

function ensurePaperBaseDirs(projectId: string, paperId: string): { latexDir: string; latexExtractedDir: string } {
  const latexDir = getProjectPaperLatexDir(projectId, paperId);
  const latexExtractedDir = getProjectPaperLatexExtractedDir(projectId, paperId);
  return { latexDir, latexExtractedDir };
}

export async function buildProjectEvidenceCatalog(params: {
  project_id: string;
  identifier?: string;
  main_tex_path?: string;
  paper_id?: string;
  include_inline_math?: boolean;
  include_cross_refs?: boolean;
  max_paragraph_length?: number;
  budget_hints?: {
    max_paragraph_length_provided?: boolean;
  };
}): Promise<BuildEvidenceResult> {
  const paperId = makePaperId({ paper_id: params.paper_id, identifier: params.identifier, main_tex_path: params.main_tex_path });
  const projectId = params.project_id;
  getProject(projectId);

  const sourceMainTexPath = await (async () => {
    if (params.main_tex_path) return path.resolve(params.main_tex_path);
    if (!params.identifier) throw invalidParams('Either identifier or main_tex_path must be provided');
    const { getPaperContent } = await import('../tools/research/paperContent.js');
    const res = await getPaperContent({ identifier: params.identifier, prefer: 'latex', extract: true });
    if (!res.success || res.source_type !== 'latex' || !res.main_tex) {
      throw new Error(res.error || res.fallback_reason || 'LaTeX source not available');
    }
    return res.main_tex;
  })();

  const { latexDir, latexExtractedDir } = ensurePaperBaseDirs(projectId, paperId);

  const copyResult = copyProjectFiles({
    sourceMainTexPath,
    destExtractedDir: latexExtractedDir,
  });

  const { merged, sourceMap } = mergeProjectContentWithSourceMap(copyResult.destMainTexPath);

  const mergedPath = resolvePathWithinParent(latexDir, path.join(latexDir, 'merged.tex'), 'paper_latex_merged');
  fs.writeFileSync(mergedPath, merged, 'utf-8');

  const sourceMapPath = resolvePathWithinParent(latexDir, path.join(latexDir, 'sourceMap.json'), 'paper_latex_sourcemap');
  fs.writeFileSync(sourceMapPath, JSON.stringify(sourceMap, null, 2), 'utf-8');

  const ast = parseLatex(merged);
  const fileContentProvider: FileContentProvider = (file: string) => fs.readFileSync(file, 'utf-8');

  const sectionCmdLevels: Record<string, number> = {
    part: 0,
    chapter: 1,
    section: 1,
    subsection: 2,
    subsubsection: 3,
    paragraph: 4,
    subparagraph: 5,
  };

  const sectionCmds = new Set(Object.keys(sectionCmdLevels));
  const majorEnvNames = new Set<string>([
    'equation', 'equation*',
    'align', 'align*',
    'gather', 'gather*',
    'multline', 'multline*',
    'eqnarray', 'eqnarray*',
    'flalign', 'flalign*',
    'figure', 'figure*',
    'table', 'table*',
    'theorem', 'lemma', 'proposition', 'corollary',
    'definition', 'remark', 'example', 'proof',
    'conjecture', 'claim',
  ]);

  const items: LatexEvidenceItem[] = [];

  const macroWrappedMathPairs = buildMacroWrappedEnvironmentPairsFromContent(merged, {
    allowedEnvNames: new Set(
      [
        'equation', 'equation*',
        'align', 'align*',
        'gather', 'gather*',
        'multline', 'multline*',
        'eqnarray', 'eqnarray*',
        'flalign', 'flalign*',
      ].map((n) => n.toLowerCase())
    ),
  });
  const warnings = [...copyResult.warnings];
  const budget = new BudgetTrackerV1();

  for (const w of copyResult.warnings) {
    budget.warn({ severity: 'warning', code: 'project_copy_warning', message: w });
  }

  const maxParagraphLength = budget.resolveInt({
    key: 'evidence.max_paragraph_length',
    dimension: 'depth',
    unit: 'chars',
    arg_path: 'max_paragraph_length',
    tool_value: params.max_paragraph_length,
    tool_value_present: params.budget_hints?.max_paragraph_length_provided ?? true,
    env_var: 'HEP_BUDGET_EVIDENCE_MAX_PARAGRAPH_LENGTH',
    default_value: params.max_paragraph_length ?? 0,
    min: 0,
  });
  let paragraphsTruncated = 0;
  let maxParagraphOriginalLength = 0;

  // Title
  const titleCmd = findFirstCommandRecursive(ast.kind === 'ast.root' ? ast.content : [], 'title');
  if (titleCmd && latexParser.isCommand(titleCmd)) {
    const titleText = extractText(titleCmd.args.flatMap(arg => (latexParser.isGroup(arg) ? arg.content : [])));
    if (titleText) {
      const titleLoc = mapLocatorToCatalogLocator(
        nodeToLocator(titleCmd, copyResult.destMainTexPath),
        sourceMap,
        fileContentProvider,
        latexExtractedDir
      );
      items.push({
        version: 1,
        evidence_id: buildEvidenceId(paperId, 'title', titleLoc, titleText),
        project_id: projectId,
        paper_id: paperId,
        type: 'title',
        locator: titleLoc,
        text: titleText,
        normalized_text: normalizeText(titleText),
      });
    }
  }

  // Abstract
  let abstractAdded = false;
  const abstractEnv = findFirstEnvironmentRecursive(ast.kind === 'ast.root' ? ast.content : [], 'abstract');
  if (abstractEnv && latexParser.isEnvironment(abstractEnv)) {
    const abstractText = extractText(abstractEnv.content);
    if (abstractText) {
      const absLoc = mapLocatorToCatalogLocator(
        nodeToLocator(abstractEnv, copyResult.destMainTexPath),
        sourceMap,
        fileContentProvider,
        latexExtractedDir
      );
      items.push({
        version: 1,
        evidence_id: buildEvidenceId(paperId, 'abstract', absLoc, abstractText),
        project_id: projectId,
        paper_id: paperId,
        type: 'abstract',
        locator: absLoc,
        text: abstractText,
        normalized_text: normalizeText(abstractText),
      });
      abstractAdded = true;
    }
  }

  if (!abstractAdded) {
    const abstractCmd = findFirstCommandRecursive(ast.kind === 'ast.root' ? ast.content : [], 'abstract');
    if (abstractCmd && latexParser.isCommand(abstractCmd)) {
      const abstractText = extractText(abstractCmd.args.flatMap(arg => (latexParser.isGroup(arg) ? arg.content : [])));
      if (abstractText) {
        const absLoc = mapLocatorToCatalogLocator(
          nodeToLocator(abstractCmd, copyResult.destMainTexPath),
          sourceMap,
          fileContentProvider,
          latexExtractedDir
        );
        items.push({
          version: 1,
          evidence_id: buildEvidenceId(paperId, 'abstract', absLoc, abstractText),
          project_id: projectId,
          paper_id: paperId,
          type: 'abstract',
          locator: absLoc,
          text: abstractText,
          normalized_text: normalizeText(abstractText),
        });
      }
    }
  }

  // Sections + paragraphs (single pass over document content)
  const docContent = getDocumentContent(ast);
  const sectionStack: Array<{ level: number; title: string }> = [];

  let paraNodes: LatexNode[] = [];

  const flushParagraph = () => {
    if (paraNodes.length === 0) return;
    const text = extractText(paraNodes);
    const trimmed = text.trim();
    if (!trimmed) {
      paraNodes = [];
      return;
    }

    const paragraphText = (() => {
      if (!(maxParagraphLength > 0 && trimmed.length > maxParagraphLength)) return trimmed;
      paragraphsTruncated += 1;
      maxParagraphOriginalLength = Math.max(maxParagraphOriginalLength, trimmed.length);
      return `${trimmed.slice(0, maxParagraphLength)}...`;
    })();

    const startNode = firstLocated(paraNodes);
    const endNode = lastLocated(paraNodes);
    if (!startNode || !endNode) {
      warnings.push('skipped paragraph with no locatable nodes');
      paraNodes = [];
      return;
    }

    const startLoc = nodeToLocator(startNode, copyResult.destMainTexPath);
    const endLoc = nodeToLocator(endNode, copyResult.destMainTexPath);

    const spanLoc = mergeSpanLocator(startLoc, endLoc);
    const mapped = mapLocatorToCatalogLocator(spanLoc, sourceMap, fileContentProvider, latexExtractedDir);

    items.push({
      version: 1,
      evidence_id: buildEvidenceId(paperId, 'paragraph', mapped, paragraphText),
      project_id: projectId,
      paper_id: paperId,
      type: 'paragraph',
      locator: mapped,
      text: paragraphText,
      normalized_text: normalizeText(paragraphText),
      meta: sectionStack.length
        ? {
            section_path: sectionStack.map(s => s.title),
          }
        : undefined,
    });

    paraNodes = [];
  };

  for (let nodeIndex = 0; nodeIndex < docContent.length; nodeIndex++) {
    const node = docContent[nodeIndex];
    const wrapped = matchMacroWrappedEnvironmentAt(docContent, nodeIndex, macroWrappedMathPairs);
    if (wrapped) {
      flushParagraph();
      nodeIndex = wrapped.endIndex;
      continue;
    }
    if (latexParser.isParbreak(node)) {
      flushParagraph();
      continue;
    }

    if (latexParser.isCommand(node) && sectionCmds.has(node.name)) {
      flushParagraph();

      const level = sectionCmdLevels[node.name];
      const title = extractText(node.args.flatMap(arg => (latexParser.isGroup(arg) ? arg.content : []))) || '';

      while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1]!.level >= level) {
        sectionStack.pop();
      }
      sectionStack.push({ level, title });

      const secLoc = mapLocatorToCatalogLocator(
        nodeToLocator(node, copyResult.destMainTexPath),
        sourceMap,
        fileContentProvider,
        latexExtractedDir
      );

      items.push({
        version: 1,
        evidence_id: buildEvidenceId(paperId, 'section', secLoc, title),
        project_id: projectId,
        paper_id: paperId,
        type: 'section',
        locator: secLoc,
        text: title,
        normalized_text: normalizeText(title),
        meta: {
          level,
          section_path: sectionStack.map(s => s.title),
          command: node.name,
        },
      });

      continue;
    }

    if (latexParser.isEnvironment(node) && majorEnvNames.has(node.name.toLowerCase())) {
      flushParagraph();
      continue;
    }

    paraNodes.push(node);
  }

  flushParagraph();

  if (maxParagraphLength > 0 && paragraphsTruncated > 0) {
    const msg = `Paragraph text truncated at max_paragraph_length=${maxParagraphLength} (truncated_paragraphs=${paragraphsTruncated}).`;
    warnings.push(msg);
    budget.recordHit({
      key: 'evidence.max_paragraph_length',
      dimension: 'depth',
      unit: 'chars',
      limit: maxParagraphLength,
      observed: maxParagraphOriginalLength,
      action: 'truncate',
      message: msg,
      data: { truncated_paragraphs: paragraphsTruncated, max_original_length: maxParagraphOriginalLength },
    });
  }

  // Equations (with enhanced physics classification)
  const equations = extractEnhancedEquations(ast, {
    file: copyResult.destMainTexPath,
    includeInline: params.include_inline_math ?? false,
    content: merged,
    documentContent: merged,
    contextWindow: 500,
  });
  for (const eq of equations) {
    if (!eq.location) continue;
    const loc = mapLocatorToCatalogLocator(eq.location, sourceMap, fileContentProvider, latexExtractedDir);
    const text = eq.latex;
    // Build meta with enhanced equation classification fields
    const meta: Record<string, unknown> = {
      equation_type: eq.type,
      env_name: eq.envName,
      label: eq.label,
    };
    // Add physics-based equation types if available (from equationTypeSignals.ts)
    if (eq.equation_types && eq.equation_types.length > 0) {
      meta.physics_types = eq.equation_types;
    }
    // Add famous equation name if recognized
    if (eq.equation_name) {
      meta.equation_name = eq.equation_name;
    }
    // Add physical quantities if extracted
    if (eq.physical_quantities && eq.physical_quantities.length > 0) {
      meta.physical_quantities = eq.physical_quantities;
    }
    // Add key equation flag
    if (eq.is_key_equation) {
      meta.is_key_equation = eq.is_key_equation;
    }
    items.push({
      version: 1,
      evidence_id: buildEvidenceId(paperId, 'equation', loc, text),
      project_id: projectId,
      paper_id: paperId,
      type: 'equation',
      locator: loc,
      text,
      meta,
    });
  }

  // Figures
  const figures = extractFigures(ast, { file: copyResult.destMainTexPath });
  for (const fig of figures) {
    if (!fig.location) continue;
    const loc = mapLocatorToCatalogLocator(fig.location, sourceMap, fileContentProvider, latexExtractedDir);
    const text = fig.caption ?? '';
    items.push({
      version: 1,
      evidence_id: buildEvidenceId(paperId, 'figure', loc, text),
      project_id: projectId,
      paper_id: paperId,
      type: 'figure',
      locator: loc,
      text,
      normalized_text: text ? normalizeText(text) : undefined,
      meta: {
        label: fig.label,
        placement: fig.placement,
        image_paths: fig.image_paths,
        is_subfigure: fig.is_subfigure,
        section: fig.section,
      },
    });
  }

  // Tables
  const tables = extractTables(ast, { file: copyResult.destMainTexPath, parse_data: false });
  for (const table of tables) {
    if (!table.location) continue;
    const loc = mapLocatorToCatalogLocator(table.location, sourceMap, fileContentProvider, latexExtractedDir);
    const text = table.caption ?? '';
    items.push({
      version: 1,
      evidence_id: buildEvidenceId(paperId, 'table', loc, text),
      project_id: projectId,
      paper_id: paperId,
      type: 'table',
      locator: loc,
      text,
      normalized_text: text ? normalizeText(text) : undefined,
      meta: {
        label: table.label,
        column_spec: table.column_spec,
        row_count: table.row_count,
        column_count: table.column_count,
        section: table.section,
      },
    });
  }

  // Theorems
  const theorems = extractTheorems(ast, { file: copyResult.destMainTexPath });
  for (const thm of theorems) {
    if (!thm.location) continue;
    const loc = mapLocatorToCatalogLocator(thm.location, sourceMap, fileContentProvider, latexExtractedDir);
    const text = thm.content_text;
    items.push({
      version: 1,
      evidence_id: buildEvidenceId(paperId, 'theorem', loc, text),
      project_id: projectId,
      paper_id: paperId,
      type: 'theorem',
      locator: loc,
      text,
      normalized_text: text ? normalizeText(text) : undefined,
      meta: {
        theorem_type: thm.type,
        env_name: thm.env_name,
        label: thm.label,
        title: thm.title,
        section: thm.section,
      },
    });
  }

  // Citation contexts
  const citations = extractCitations(ast, merged, {
    file: copyResult.destMainTexPath,
    include_cross_refs: params.include_cross_refs ?? false,
  });
  for (const cit of citations) {
    if (!cit.location) continue;
    const loc = mapLocatorToCatalogLocator(cit.location, sourceMap, fileContentProvider, latexExtractedDir);
    const text = cit.context;
    items.push({
      version: 1,
      evidence_id: buildEvidenceId(paperId, 'citation_context', loc, text),
      project_id: projectId,
      paper_id: paperId,
      type: 'citation_context',
      locator: loc,
      text,
      normalized_text: text ? normalizeText(text) : undefined,
      citations: cit.keys,
      meta: {
        command_type: cit.type,
        section: cit.section,
        optional_arg: cit.optional_arg,
      },
    });
  }

  // Stable ordering
  items.sort((a, b) => {
    const fileCmp = a.locator.file.localeCompare(b.locator.file);
    if (fileCmp !== 0) return fileCmp;
    const offCmp = a.locator.offset - b.locator.offset;
    if (offCmp !== 0) return offCmp;
    return a.evidence_id.localeCompare(b.evidence_id);
  });

  const byType: Record<string, number> = {};
  for (const item of items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
  }

  const catalogPath = getProjectPaperEvidenceCatalogPath(projectId, paperId);
  ensureDir(path.dirname(catalogPath));
  const out = fs.createWriteStream(catalogPath, { encoding: 'utf-8' });
  for (const item of items) {
    out.write(`${JSON.stringify(item)}\n`);
  }
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.on('finish', resolve);
    out.end();
  });

  const now = new Date().toISOString();

  let existing: HepPaper | null = null;
  try {
    existing = getPaper(projectId, paperId);
  } catch {
    // New paper
  }

  const paper: HepPaper = {
    version: 1,
    project_id: projectId,
    paper_id: paperId,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    source: {
      kind: 'latex',
      identifier: params.identifier,
      main_tex: normalizePathForCatalog(copyResult.mainTexRel),
    },
    artifacts: {
      evidence_catalog: {
        uri: getEvidenceCatalogUri(projectId, paperId),
        generated_at: now,
      },
    },
    notes: warnings.length > 0 ? warnings.slice(0, 20) : undefined,
  };

  // Ensure paper.json is written
  ensureDir(path.dirname(getProjectPaperJsonPath(projectId, paperId)));
  upsertPaper(paper);
  updateProjectUpdatedAt(projectId);

  const diag = writeProjectDiagnosticsArtifact({
    project_id: projectId,
    operation: 'project_build_evidence',
    artifact_name: `evidence_catalog_${paperId}_diagnostics.json`,
    ...budget.snapshot(),
    meta: {
      paper_id: paperId,
      main_tex: paper.source.main_tex,
      copied_files: copyResult.copied,
      total_items: items.length,
    },
  });

  return {
    project_id: projectId,
    paper_id: paperId,
    paper_uri: getPaperUri(projectId, paperId),
    catalog_uri: getEvidenceCatalogUri(projectId, paperId),
    diagnostics_uri: diag.project.uri,
    summary: {
      total: items.length,
      by_type: byType,
      copied_files: copyResult.copied,
      main_tex: paper.source.main_tex,
      warnings_total: warnings.length,
      warnings: warnings.slice(0, 20),
    },
  };
}

function scoreMatch(normalized: string, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (normalized.includes(term)) score += 1;
  }
  return score;
}

async function queryCatalogFile(params: {
  catalogPath: string;
  query: string;
  limit: number;
  types?: Set<EvidenceType>;
}): Promise<QueryEvidenceHit[]> {
  const q = params.query.trim();
  if (!q) return [];

  const terms = normalizeText(q).split(' ').filter(Boolean);

  type HitWithOrder = QueryEvidenceHit & { _order: number };
  const hits: HitWithOrder[] = [];
  let orderCounter = 0;
  const input = fs.createReadStream(params.catalogPath, { encoding: 'utf-8' });
  let buffer = '';

  const pushHit = (hit: QueryEvidenceHit) => {
    hits.push({ ...hit, _order: orderCounter++ });
    hits.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return a._order - b._order;
    });
    if (hits.length > params.limit) hits.length = params.limit;
  };

  for await (const chunk of input) {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let item: EvidenceCatalogItemV1;
      try {
        item = JSON.parse(line) as EvidenceCatalogItemV1;
      } catch {
        continue;
      }
      if (params.types && !params.types.has(item.type)) continue;

      const normalized = item.normalized_text ?? (item.text ? normalizeText(item.text) : '');
      const score = scoreMatch(normalized, terms);
      if (score <= 0) continue;

      pushHit({
        evidence_id: item.evidence_id,
        project_id: item.project_id,
        paper_id: item.paper_id,
        type: item.type,
        score,
        text_preview: item.text.slice(0, 240),
        locator: item.locator,
      });
    }
  }

  return hits.map(({ _order: _ignored, ...rest }) => rest);
}

export async function queryProjectEvidence(params: {
  project_id: string;
  query: string;
  paper_id?: string;
  types?: EvidenceType[];
  limit?: number;
  concurrency?: number;
  budget_hints?: {
    concurrency_provided?: boolean;
  };
}): Promise<QueryEvidenceResult> {
  getProject(params.project_id);
  const limit = Math.max(1, Math.min(params.limit ?? 10, 150));
  const typeSet = params.types && params.types.length > 0 ? new Set(params.types) : undefined;

  const budget = new BudgetTrackerV1();

  const catalogs: Array<{ paper_id: string; catalogPath: string }> = [];

  if (params.paper_id) {
    const catalogPath = getProjectPaperEvidenceCatalogPath(params.project_id, params.paper_id);
    if (!fs.existsSync(catalogPath)) {
      throw notFound('Evidence catalog not found', {
        project_id: params.project_id,
        paper_id: params.paper_id,
      });
    }
    catalogs.push({ paper_id: params.paper_id, catalogPath });
  } else {
    for (const paper of listPapers(params.project_id)) {
      const catalogPath = getProjectPaperEvidenceCatalogPath(params.project_id, paper.paper_id);
      if (fs.existsSync(catalogPath)) catalogs.push({ paper_id: paper.paper_id, catalogPath });
    }
  }

  const concurrency = budget.resolveInt({
    key: 'budget.concurrency',
    dimension: 'budget',
    unit: 'tasks',
    arg_path: 'concurrency',
    tool_value: params.concurrency,
    tool_value_present: params.budget_hints?.concurrency_provided ?? params.concurrency !== undefined,
    env_var: 'HEP_BUDGET_CONCURRENCY',
    default_value: 4,
    min: 1,
    max: 16,
  });
  budget.warn({
    severity: 'info',
    code: 'concurrency',
    message: `Evidence query parallelism: concurrency=${concurrency}.`,
    data: { concurrency, catalogs_total: catalogs.length },
  });

  const limiter = pLimit(concurrency);
  const perCatalog = await Promise.all(
    catalogs.map(c =>
      limiter(async () => ({
        paper_id: c.paper_id,
        hits: await queryCatalogFile({
          catalogPath: c.catalogPath,
          query: params.query,
          limit,
          types: typeSet,
        }),
      }))
    )
  );

  const allHits: QueryEvidenceHit[] = [];
  for (const entry of perCatalog) {
    for (const hit of entry.hits) allHits.push(hit);
  }

  const decorated = allHits.map((hit, idx) => ({ hit, idx }));
  decorated.sort((a, b) => {
    const scoreDiff = b.hit.score - a.hit.score;
    if (scoreDiff !== 0) return scoreDiff;
    return a.idx - b.idx;
  });
  const hits = decorated.slice(0, limit).map(d => d.hit);

  const snap = budget.snapshot();
  const diag = writeProjectDiagnosticsArtifact({
    project_id: params.project_id,
    operation: 'project_query_evidence',
    artifact_name: `project_query_evidence_${sha256Hex(
      JSON.stringify({
        project_id: params.project_id,
        paper_id: params.paper_id ?? null,
        query: params.query,
        types: params.types ?? null,
        limit,
        concurrency,
      })
    ).slice(0, 16)}_diagnostics.json`,
    budgets: snap.budgets,
    hits: snap.hits,
    warnings: snap.warnings,
    meta: {
      query: params.query,
      paper_id: params.paper_id ?? null,
      types: params.types ?? null,
      limit,
      concurrency,
      catalogs_total: catalogs.length,
    },
  });

  return {
    project_id: params.project_id,
    query: params.query,
    total_hits: allHits.length,
    hits,
    diagnostics_uri: diag.project.uri,
    warnings_total: snap.warnings.length,
    warnings: snap.warnings.map(w => w.message).slice(0, 20),
  };
}

async function findEvidenceInCatalog(catalogPath: string, evidenceId: string): Promise<EvidenceCatalogItemV1 | null> {
  const input = fs.createReadStream(catalogPath, { encoding: 'utf-8' });
  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let item: EvidenceCatalogItemV1;
      try {
        item = JSON.parse(line) as EvidenceCatalogItemV1;
      } catch {
        continue;
      }
      if (item.evidence_id === evidenceId) return item;
    }
  }
  return null;
}

export async function playbackProjectEvidence(params: {
  project_id: string;
  paper_id: string;
  evidence_id: string;
  before_chars?: number;
  after_chars?: number;
}): Promise<EvidenceSnippetResult> {
  getProject(params.project_id);
  const catalogPath = getProjectPaperEvidenceCatalogPath(params.project_id, params.paper_id);
  if (!fs.existsSync(catalogPath)) {
    throw notFound('Evidence catalog not found', { project_id: params.project_id, paper_id: params.paper_id });
  }

  const item = await findEvidenceInCatalog(catalogPath, params.evidence_id);
  if (!item) {
    throw notFound('Evidence not found', {
      project_id: params.project_id,
      paper_id: params.paper_id,
      evidence_id: params.evidence_id,
    });
  }

  if (item.locator.kind !== 'latex') {
    throw invalidParams('Playback is only supported for LaTeX evidence', {
      evidence_id: params.evidence_id,
      locator_kind: item.locator.kind,
    });
  }
  const latexLocator = item.locator;

  const latexExtractedDir = getProjectPaperLatexExtractedDir(params.project_id, params.paper_id);
  const absFile = resolvePathWithinParent(
    latexExtractedDir,
    path.join(latexExtractedDir, latexLocator.file),
    'evidence_locator_file'
  );
  if (!fs.existsSync(absFile)) {
    throw notFound('Locator source file not found', {
      project_id: params.project_id,
      paper_id: params.paper_id,
      file: latexLocator.file,
    });
  }

  const locator: Locator = {
    file: absFile,
    offset: latexLocator.offset,
    line: latexLocator.line,
    column: latexLocator.column,
    endOffset: latexLocator.endOffset,
    endLine: latexLocator.endLine,
    endColumn: latexLocator.endColumn,
    anchor: latexLocator.anchor,
  };

  const playback = playbackLocator(locator, (file) => fs.readFileSync(file, 'utf-8'), {
    beforeChars: params.before_chars ?? 40,
    afterChars: params.after_chars ?? 120,
  });

  return {
    project_id: params.project_id,
    paper_id: params.paper_id,
    evidence_id: params.evidence_id,
    locator: item.locator,
    playback: {
      file: normalizePathForCatalog(latexLocator.file),
      line: playback.line,
      column: playback.column,
      snippet: playback.snippet,
    },
  };
}
