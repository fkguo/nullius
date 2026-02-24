/**
 * Locator System - Precise source location tracking for LaTeX elements
 *
 * Provides:
 * 1. Locator type with anchor validation
 * 2. Block/Label/Ref tracking
 * 3. buildLocatorIndex() for single-pass index construction
 * 4. Gate validation functions
 *
 * @module locator
 */

import { latexParser } from 'latex-utensils';
import type * as LU from 'latex-utensils';
import type { ParentChain } from './parserHarness.js';

// Use latexParser's findAll
const { findAll } = latexParser;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type LatexNode = LU.latexParser.Node;
export type LatexAst = LU.latexParser.LatexAst;

/**
 * Locator - Precise source location with anchor validation
 * Uses offset as primary key (more stable than line/column)
 */
export interface Locator {
  /** Source file path */
  file: string;
  /** Character offset (primary key) */
  offset: number;
  /** Line number (for display) */
  line: number;
  /** Column number (for display) */
  column: number;
  /** End offset (optional) */
  endOffset?: number;
  /** End line (optional) */
  endLine?: number;
  /** End column (optional) */
  endColumn?: number;
  /** Anchor for validation (32 chars before/after) */
  anchor?: {
    before: string;
    after: string;
  };
  /** Associated label (if any) */
  label?: string;
  /** Inherited from parent (fallback) */
  inherited?: boolean;
  /** Unknown location (last resort) */
  unknown?: boolean;
}

/**
 * Block kinds supported by the locator system
 */
export type BlockKind = 'equation' | 'figure' | 'table' | 'theorem' | 'section';

/**
 * Block - A container that can have labels
 */
export interface Block {
  /** Unique identifier */
  id: string;
  /** Block type */
  kind: BlockKind;
  /** Source location */
  locator: Locator;
  /** Labels in this block */
  labels: string[];
  /** Stringified content (optional) */
  content?: string;
  /** Environment name (e.g., 'equation', 'align') */
  envName?: string;
}

/**
 * Label entry - Maps a label to its containing block
 */
export interface LabelEntry {
  /** The label string (e.g., 'eq:einstein') */
  label: string;
  /** ID of the containing block */
  blockId: string;
  /** Source location of the \label command */
  locator: Locator;
  /** Inferred type based on label prefix or block kind */
  type: BlockKind | 'other';
}

/**
 * Reference types supported
 */
export type RefType = 'ref' | 'eqref' | 'autoref' | 'pageref' | 'cref' | 'Cref' | 'subref';

/**
 * Reference entry - Tracks where labels are referenced
 */
export interface RefEntry {
  /** Reference command type */
  type: RefType;
  /** Target labels (supports multiple for cref) */
  targets: string[];
  /** Source location of the reference */
  locator: Locator;
}

/**
 * Source span for multi-file mapping
 */
export interface SourceSpan {
  /** Start offset in flattened content */
  globalStart: number;
  /** End offset in flattened content */
  globalEnd: number;
  /** Original file path */
  file: string;
  /** Start offset in original file */
  localStart: number;
}

/**
 * Source map for multi-file documents
 */
export type SourceMap = SourceSpan[];

export type FileContentProvider = (file: string) => string;

/**
 * Complete locator index for a document
 */
export interface LocatorIndex {
  /** All blocks in the document */
  blocks: Map<string, Block>;
  /** Label to LabelEntry mapping */
  labels: Map<string, LabelEntry>;
  /** Label to RefEntry[] mapping (which refs point to this label) */
  refs: Map<string, RefEntry[]>;
  /** All references in document order */
  allRefs: RefEntry[];
  /** Source map for multi-file documents */
  sourceMap?: SourceMap;
  /** File path */
  file: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Block container environment names by kind */
const BLOCK_CONTAINERS: Record<BlockKind, string[]> = {
  equation: [
    'equation', 'equation*',
    'align', 'align*',
    'gather', 'gather*',
    'multline', 'multline*',
    'eqnarray', 'eqnarray*',
    'flalign', 'flalign*',
  ],
  figure: ['figure', 'figure*'],
  table: ['table', 'table*'],
  theorem: [
    'theorem', 'lemma', 'proposition', 'corollary',
    'definition', 'remark', 'example', 'proof',
  ],
  section: [], // Handled separately via commands
};

/** Reference command names */
const REF_COMMANDS: Set<string> = new Set([
  'ref', 'eqref', 'autoref', 'pageref',
  'cref', 'Cref', 'subref',
]);

/** Anchor context size (characters before/after) */
const ANCHOR_SIZE = 32;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a block ID generator (closure-based for concurrency safety)
 */
export function createBlockIdGenerator(): (kind: BlockKind) => string {
  let counter = 0;
  return (kind: BlockKind) => `${kind}_${++counter}`;
}

/**
 * Create anchor from content at offset
 */
export function createAnchor(
  content: string,
  offset: number
): { before: string; after: string } {
  const before = content.slice(
    Math.max(0, offset - ANCHOR_SIZE),
    offset
  );
  const after = content.slice(
    offset,
    Math.min(content.length, offset + ANCHOR_SIZE)
  );
  return { before, after };
}

/**
 * Convert AST node location to Locator
 */
export function nodeToLocator(
  node: LatexNode,
  file: string,
  content?: string
): Locator {
  const loc = (node as { location?: LU.latexParser.Location }).location;

  if (!loc) {
    return {
      file,
      offset: 0,
      line: 0,
      column: 0,
      unknown: true,
    };
  }

  const locator: Locator = {
    file,
    offset: loc.start.offset,
    line: loc.start.line,
    column: loc.start.column,
    endOffset: loc.end.offset,
    endLine: loc.end.line,
    endColumn: loc.end.column,
  };

  // Add anchor if content provided
  if (content) {
    locator.anchor = createAnchor(content, loc.start.offset);
  }

  return locator;
}

function buildLineStartOffsets(content: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) starts.push(i + 1); // '\n'
  }
  return starts;
}

function offsetToLineColumn(
  lineStartOffsets: number[],
  offset: number
): { line: number; column: number } {
  const clampedOffset = Math.max(0, offset);
  let lo = 0;
  let hi = lineStartOffsets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStartOffsets[mid] <= clampedOffset) lo = mid + 1;
    else hi = mid - 1;
  }
  const lineIdx = Math.max(0, lo - 1);
  const lineStart = lineStartOffsets[lineIdx] ?? 0;
  return { line: lineIdx + 1, column: clampedOffset - lineStart + 1 };
}

function findSourceSpan(sourceMap: SourceMap, globalOffset: number): SourceSpan | null {
  let lo = 0;
  let hi = sourceMap.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = sourceMap[mid];
    if (globalOffset < span.globalStart) hi = mid - 1;
    else if (globalOffset >= span.globalEnd) lo = mid + 1;
    else return span;
  }
  return null;
}

export function mapGlobalOffsetToSource(
  sourceMap: SourceMap,
  globalOffset: number
): { file: string; localOffset: number } | null {
  const span = findSourceSpan(sourceMap, globalOffset);
  if (!span) return null;
  return {
    file: span.file,
    localOffset: span.localStart + (globalOffset - span.globalStart),
  };
}

export function mapLocatorToSource(
  locator: Locator,
  sourceMap: SourceMap,
  getFileContent: FileContentProvider
): Locator {
  if (locator.unknown) return locator;
  const mappedStart = mapGlobalOffsetToSource(sourceMap, locator.offset);
  if (!mappedStart) return locator;

  const content = getFileContent(mappedStart.file);
  const lineStarts = buildLineStartOffsets(content);
  const startLC = offsetToLineColumn(lineStarts, mappedStart.localOffset);

  const mapped: Locator = {
    ...locator,
    file: mappedStart.file,
    offset: mappedStart.localOffset,
    line: startLC.line,
    column: startLC.column,
    anchor: createAnchor(content, mappedStart.localOffset),
    unknown: false,
  };

  if (locator.endOffset !== undefined) {
    if (locator.endOffset <= locator.offset) {
      mapped.endOffset = mapped.offset;
      mapped.endLine = mapped.line;
      mapped.endColumn = mapped.column;
    } else {
      const endProbe = locator.endOffset - 1;
      const mappedEndProbe = mapGlobalOffsetToSource(sourceMap, endProbe);
      if (mappedEndProbe && mappedEndProbe.file === mapped.file) {
        const endLocal = mappedEndProbe.localOffset + 1;
        const endLC = offsetToLineColumn(lineStarts, endLocal);
        mapped.endOffset = endLocal;
        mapped.endLine = endLC.line;
        mapped.endColumn = endLC.column;
      } else {
        delete mapped.endOffset;
        delete mapped.endLine;
        delete mapped.endColumn;
      }
    }
  }

  return mapped;
}

export function applySourceMapToLocatorIndex(
  index: LocatorIndex,
  sourceMap: SourceMap,
  getFileContent: FileContentProvider
): LocatorIndex {
  const contentCache = new Map<string, string>();
  const lineStartCache = new Map<string, number[]>();

  const getContentCached = (file: string): string => {
    const existing = contentCache.get(file);
    if (existing !== undefined) return existing;
    const content = getFileContent(file);
    contentCache.set(file, content);
    return content;
  };

  const getLineStartsCached = (file: string): number[] => {
    const existing = lineStartCache.get(file);
    if (existing) return existing;
    const starts = buildLineStartOffsets(getContentCached(file));
    lineStartCache.set(file, starts);
    return starts;
  };

  const mapLocatorFast = (loc: Locator): Locator => {
    if (loc.unknown) return loc;
    const mappedStart = mapGlobalOffsetToSource(sourceMap, loc.offset);
    if (!mappedStart) return loc;

    const content = getContentCached(mappedStart.file);
    const lineStarts = getLineStartsCached(mappedStart.file);
    const startLC = offsetToLineColumn(lineStarts, mappedStart.localOffset);

    const mapped: Locator = {
      ...loc,
      file: mappedStart.file,
      offset: mappedStart.localOffset,
      line: startLC.line,
      column: startLC.column,
      anchor: createAnchor(content, mappedStart.localOffset),
      unknown: false,
    };

    if (loc.endOffset !== undefined) {
      if (loc.endOffset <= loc.offset) {
        mapped.endOffset = mapped.offset;
        mapped.endLine = mapped.line;
        mapped.endColumn = mapped.column;
      } else {
        const endProbe = loc.endOffset - 1;
        const mappedEndProbe = mapGlobalOffsetToSource(sourceMap, endProbe);
        if (mappedEndProbe && mappedEndProbe.file === mapped.file) {
          const endLocal = mappedEndProbe.localOffset + 1;
          const endLC = offsetToLineColumn(lineStarts, endLocal);
          mapped.endOffset = endLocal;
          mapped.endLine = endLC.line;
          mapped.endColumn = endLC.column;
        } else {
          delete mapped.endOffset;
          delete mapped.endLine;
          delete mapped.endColumn;
        }
      }
    }

    return mapped;
  };

  for (const entry of index.labels.values()) {
    entry.locator = mapLocatorFast(entry.locator);
  }

  for (const block of index.blocks.values()) {
    block.locator = mapLocatorFast(block.locator);
  }

  for (const ref of index.allRefs) {
    ref.locator = mapLocatorFast(ref.locator);
  }

  index.sourceMap = sourceMap;
  return index;
}

/**
 * Get safe locator with fallback to parent
 */
export function getSafeLocator(
  node: LatexNode,
  parent: ParentChain | undefined,
  file: string,
  content?: string
): Locator {
  // Try node's own location first
  const loc = (node as { location?: LU.latexParser.Location }).location;
  if (loc) {
    return nodeToLocator(node, file, content);
  }

  // Fallback to parent's location
  if (parent?.node) {
    const parentLoc = nodeToLocator(parent.node, file, content);
    return { ...parentLoc, inherited: true };
  }

  // Last resort: unknown location
  return { file, offset: 0, line: 0, column: 0, unknown: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Block Container Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the block container for a node by climbing the parent chain
 *
 * @param parent - Parent chain from findAll result
 * @returns Block container info or null
 */
export function findBlockContainer(
  parent: ParentChain | undefined
): { node: LatexNode; kind: BlockKind } | null {
  let current = parent;

  while (current) {
    const n = current.node;

    // Check MathEnv (equation, align, etc.)
    if (latexParser.isMathEnv(n)) {
      return { node: n, kind: 'equation' };
    }

    // Check Environment
    if (latexParser.isEnvironment(n)) {
      for (const [kind, envs] of Object.entries(BLOCK_CONTAINERS)) {
        // Use exact match or starred variant (e.g., 'equation' matches 'equation*')
        if (envs.some((e) => n.name === e || n.name === `${e}*`)) {
          return { node: n, kind: kind as BlockKind };
        }
      }
    }

    // Check sectioning commands
    if (latexParser.isCommand(n)) {
      const sectionCmds = ['chapter', 'section', 'subsection', 'subsubsection'];
      if (sectionCmds.includes(n.name)) {
        return { node: n, kind: 'section' };
      }
    }

    current = current.parent;
  }

  return null;
}

/**
 * Infer label type from prefix
 */
export function inferLabelType(label: string): BlockKind | 'other' {
  if (label.startsWith('eq:')) return 'equation';
  if (label.startsWith('fig:')) return 'figure';
  if (label.startsWith('tab:')) return 'table';
  if (label.startsWith('sec:')) return 'section';
  if (label.startsWith('thm:')) return 'theorem';
  return 'other';
}

/**
 * Check if a command is a reference command
 * Note: \ref, \eqref are parsed as LabelCommand (kind: 'command.label')
 *       \cref, \Cref are parsed as Command (kind: 'command')
 */
export function isRefCommand(node: LatexNode): boolean {
  const kind = (node as { kind?: string }).kind;
  const name = (node as { name?: string }).name;

  if (!name) return false;

  // LabelCommand type (ref, eqref, autoref, pageref)
  if (kind === 'command.label' && REF_COMMANDS.has(name)) {
    return true;
  }

  // Regular Command type (cref, Cref, subref)
  if (kind === 'command' && REF_COMMANDS.has(name)) {
    return true;
  }

  return false;
}

/**
 * Extract targets from a reference command
 * LabelCommand has 'label' property, Command has 'args' property
 */
export function extractRefTargets(node: LatexNode): string[] {
  const kind = (node as { kind?: string }).kind;

  // LabelCommand type - has 'label' property
  if (kind === 'command.label') {
    const label = (node as { label?: string }).label;
    if (!label) return [];
    return label.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  }

  // Regular Command type - extract from args
  if (kind === 'command') {
    const args = (node as { args?: LatexNode[] }).args || [];
    for (const arg of args) {
      if (latexParser.isGroup(arg)) {
        const textParts: string[] = [];
        for (const n of arg.content) {
          if ((n as { kind?: string }).kind === 'text.string') {
            textParts.push((n as { content?: string }).content || '');
          }
        }
        const text = textParts.join('');
        return text.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
      }
    }
  }

  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Locator Index
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a complete locator index from AST in a single pass
 *
 * @param ast - Parsed LaTeX AST
 * @param file - Source file path
 * @param content - Raw content (for anchors)
 * @returns Complete locator index
 */
export function buildLocatorIndex(
  ast: LatexAst,
  file: string,
  content?: string
): LocatorIndex {
  const index: LocatorIndex = {
    blocks: new Map(),
    labels: new Map(),
    refs: new Map(),
    allRefs: [],
    file,
  };

  // Create local ID generator (concurrency-safe)
  const genBlockId = createBlockIdGenerator();

  // Single pass: find all nodes
  const allNodes = findAll(ast.content, () => true);

  for (const { node, parent } of allNodes) {
    processNode(node, parent as ParentChain | undefined, index, file, content, genBlockId);
  }

  return index;
}

/**
 * Process a single node during index building
 */
function processNode(
  node: LatexNode,
  parent: ParentChain | undefined,
  index: LocatorIndex,
  file: string,
  content: string | undefined,
  genBlockId: (kind: BlockKind) => string
): void {
  // Process reference commands first (ref, eqref, etc.)
  // Note: isLabelCommand returns true for both \label and \ref
  if (isRefCommand(node)) {
    processRefNode(node, index, file, content);
    return;
  }

  // Process label commands (\label only)
  if (latexParser.isLabelCommand(node) && node.name === 'label') {
    processLabelNode(node, parent, index, file, content, genBlockId);
  }
}

/**
 * Process a label command node
 */
function processLabelNode(
  node: LU.latexParser.LabelCommand,
  parent: ParentChain | undefined,
  index: LocatorIndex,
  file: string,
  content: string | undefined,
  genBlockId: (kind: BlockKind) => string
): void {
  const label = node.label;
  const locator = nodeToLocator(node, file, content);

  // Find containing block
  const container = findBlockContainer(parent);

  let blockId: string;
  let blockKind: BlockKind | 'other';

  if (container) {
    blockKind = container.kind;
    // Check if block already exists
    const existingBlock = findExistingBlock(index, container.node);
    if (existingBlock) {
      blockId = existingBlock.id;
      existingBlock.labels.push(label);
    } else {
      blockId = genBlockId(container.kind);
      const block: Block = {
        id: blockId,
        kind: container.kind,
        locator: nodeToLocator(container.node, file, content),
        labels: [label],
        envName: getEnvName(container.node),
      };
      index.blocks.set(blockId, block);
    }
  } else {
    // No container found, create orphan block
    blockKind = inferLabelType(label);
    blockId = genBlockId(blockKind === 'other' ? 'equation' : blockKind);
  }

  // Create label entry
  const labelEntry: LabelEntry = {
    label,
    blockId,
    locator,
    type: blockKind,
  };
  index.labels.set(label, labelEntry);
}

/**
 * Find existing block by node location
 */
function findExistingBlock(
  index: LocatorIndex,
  node: LatexNode
): Block | undefined {
  const loc = (node as { location?: LU.latexParser.Location }).location;
  if (!loc) return undefined;

  for (const block of index.blocks.values()) {
    if (block.locator.offset === loc.start.offset) {
      return block;
    }
  }
  return undefined;
}

/**
 * Get environment name from node
 */
function getEnvName(node: LatexNode): string | undefined {
  if (latexParser.isEnvironment(node) || latexParser.isMathEnv(node)) {
    return (node as { name: string }).name;
  }
  if (latexParser.isCommand(node)) {
    return node.name;
  }
  return undefined;
}

/**
 * Process a reference command node
 */
function processRefNode(
  node: LatexNode,
  index: LocatorIndex,
  file: string,
  content?: string
): void {
  // Note: ref commands can be 'command.label' or 'command' type
  const kind = (node as { kind?: string }).kind;
  if (kind !== 'command.label' && kind !== 'command') return;

  const targets = extractRefTargets(node);
  if (targets.length === 0) return;

  const name = (node as { name?: string }).name || 'ref';
  const locator = nodeToLocator(node, file, content);
  const refEntry: RefEntry = {
    type: name as RefType,
    targets,
    locator,
  };

  // Add to allRefs
  index.allRefs.push(refEntry);

  // Add to refs map (by target)
  for (const target of targets) {
    const existing = index.refs.get(target) || [];
    existing.push(refEntry);
    index.refs.set(target, existing);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate Validation Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gate 3: Validate locator playback (range + anchor)
 */
export function validateLocatorPlayback(
  locator: Locator,
  content: string
): boolean {
  // Range check
  if (locator.offset < 0 || locator.offset >= content.length) {
    return false;
  }
  if (locator.endOffset && locator.endOffset > content.length) {
    return false;
  }

  // Anchor check (if present)
  if (locator.anchor) {
    const snippet = content.slice(
      Math.max(0, locator.offset - ANCHOR_SIZE),
      locator.offset + ANCHOR_SIZE
    ).replace(/\s+/g, '');

    const expectedBefore = locator.anchor.before.replace(/\s+/g, '');
    if (!snippet.includes(expectedBefore)) {
      return false;
    }
  }

  return true;
}

export interface LocatorPlayback {
  file: string;
  line: number;
  column: number;
  snippet: string;
}

export function playbackLocator(
  locator: Locator,
  getFileContent: FileContentProvider,
  options?: { beforeChars?: number; afterChars?: number }
): LocatorPlayback {
  const { beforeChars = 40, afterChars = 120 } = options || {};
  const content = getFileContent(locator.file);

  if (!validateLocatorPlayback(locator, content)) {
    throw new Error(`Locator playback failed for ${locator.file}:${locator.line}:${locator.column}`);
  }

  const start = Math.max(0, locator.offset - beforeChars);
  const endBase = locator.endOffset && locator.endOffset > locator.offset ? locator.endOffset : locator.offset;
  const end = Math.min(content.length, endBase + afterChars);

  return {
    file: locator.file,
    line: locator.line,
    column: locator.column,
    snippet: content.slice(start, end),
  };
}

/**
 * Gate 1: Validate that all labels have blockId
 */
export function validateLabelsHaveBlocks(
  index: LocatorIndex
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const [label, entry] of index.labels) {
    if (!entry.blockId) {
      errors.push(`Label "${label}" has no blockId`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Gate 2: Validate that all refs have targets
 */
export function validateRefsHaveTargets(
  index: LocatorIndex
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const ref of index.allRefs) {
    if (!ref.targets || ref.targets.length === 0) {
      errors.push(`Ref at offset ${ref.locator.offset} has no targets`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Comprehensive index validation
 */
export function validateLocatorIndex(
  index: LocatorIndex,
  content?: string
): { valid: boolean; errors: string[] } {
  const allErrors: string[] = [];

  // Gate 1: Labels have blocks
  const g1 = validateLabelsHaveBlocks(index);
  allErrors.push(...g1.errors);

  // Gate 2: Refs have targets
  const g2 = validateRefsHaveTargets(index);
  allErrors.push(...g2.errors);

  // Gate 3: Locator playback (if content provided)
  if (content) {
    for (const [label, entry] of index.labels) {
      if (!validateLocatorPlayback(entry.locator, content)) {
        allErrors.push(`Label "${label}" locator fails playback`);
      }
    }
  }

  return { valid: allErrors.length === 0, errors: allErrors };
}
