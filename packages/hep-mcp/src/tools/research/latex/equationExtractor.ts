/**
 * LaTeX Equation Extractor
 * Extracts equations from LaTeX AST using latex-utensils findAll/stringify
 * 
 * Enhanced with physics context classification (120+ equation types)
 */

import { latexParser } from 'latex-utensils';
import type { LatexAst, LatexNode, Locator } from './parser.js';
import { nodeToLocator } from './locator.js';
import { stringifyLatexNodes } from './astStringify.js';
import {
  buildMacroWrappedEnvironmentPairsFromContent,
  matchMacroWrappedEnvironmentAt,
} from './macroWrappedEnvironments.js';
import {
  classifyEquationType,
  identifyFamousEquation,
  extractPhysicalQuantities,
  isKeyEquation,
  type EquationType,
} from './equationTypeSignals.js';

// Use latexParser's find helper
const { find } = latexParser;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Equation {
  /** Equation type (LaTeX environment based) */
  type: 'display' | 'inline' | 'align' | 'gather' | 'eqnarray' | 'multline';
  /** LaTeX content */
  latex: string;
  /** Label if present */
  label?: string;
  /** Surrounding context */
  context?: string;
  /** Source location */
  location?: Locator;
  /** Environment name (e.g., 'equation', 'align') */
  envName?: string;
}

/**
 * Enhanced equation with physics context classification
 */
export interface EnhancedEquation extends Equation {
  /** Physics-based equation types (120+ types) */
  equation_types?: EquationType[];
  /** Famous equation name if recognized */
  equation_name?: string;
  /** Physical quantities mentioned in context */
  physical_quantities?: string[];
  /** Whether this is a key equation */
  is_key_equation?: boolean;
  /** Reason for key equation classification */
  key_equation_reason?: string;
  /** Canonical form (stripped of labels, tags, etc.) */
  canonical?: string;
  /** Extracted symbols */
  symbols?: string[];
  /** Extracted operators */
  operators?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

const MATH_ENV_NAMES = new Set([
  'equation', 'equation*',
  'align', 'align*',
  'gather', 'gather*',
  'eqnarray', 'eqnarray*',
  'multline', 'multline*',
]);

const WRAPPED_MATH_ENV_NAME_KEYS = new Set(Array.from(MATH_ENV_NAMES).map((n) => n.toLowerCase()));

const COMMENT_ENVS = new Set(['comment', 'Comment', 'COMMENT']);

const MACRO_DEFINITION_COMMANDS = new Set<string>([
  'newcommand',
  'renewcommand',
  'providecommand',
  'declarerobustcommand',
  'declaremathoperator',
  'def',
  'edef',
  'gdef',
  'xdef',
  'let',
  'futurelet',
  'newenvironment',
  'renewenvironment',
  'newtheorem',
  'newif',
  'usepackage',
  'requirepackage',
  'documentclass',
  'input',
  'include',
]);

const METADATA_COMMANDS = new Set<string>([
  'title',
  'author',
  'affiliation',
  'address',
  'institute',
  'email',
  'thanks',
  'preprint',
  'date',
  'maketitle',
]);

const TRAVERSE_HARD_BLOCK_COMMANDS = new Set<string>([
  'newcommand',
  'renewcommand',
  'def',
  'edef',
  'gdef',
  'xdef',
  'declaremathoperator',
  'newenvironment',
  'renewenvironment',
  'usepackage',
  'documentclass',
]);

function mergeSpanLocator(start: Locator, end: Locator): Locator {
  const endOffset = end.endOffset ?? end.offset;
  const endLine = end.endLine ?? end.line;
  const endColumn = end.endColumn ?? end.column;
  return { ...start, endOffset, endLine, endColumn };
}

function normalizeCommandName(name: string): string {
  // latex-utensils may encode starred commands as e.g. "section*".
  return name.replace(/\*+$/, '').toLowerCase();
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

function shouldSkipRecursingIntoCommand(name: string): boolean {
  const normalized = normalizeCommandName(name);
  return MACRO_DEFINITION_COMMANDS.has(normalized) || METADATA_COMMANDS.has(normalized);
}

/**
 * Extract label from nodes using find()
 * Falls back to regex on stringified content if AST search fails
 */
function extractLabel(nodes: LatexNode[]): string | undefined {
  // Try AST-based search first
  const result = find(nodes, latexParser.isLabelCommand);
  if (result?.node.label) {
    return result.node.label;
  }

  // Fallback: latex-utensils often parses \label{...} as kind "command.label" with a "label" field.
  // We avoid relying on stringify here to prevent label-key leakage.
  const stack: LatexNode[] = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if ((node as any).kind === 'command.label' && (node as any).name === 'label' && typeof (node as any).label === 'string') {
      return (node as any).label;
    }
    if (latexParser.isEnvironment(node)) stack.push(...node.content);
    if (latexParser.isGroup(node)) stack.push(...node.content);
    if (latexParser.isCommand(node)) {
      for (const arg of node.args ?? []) {
        if (latexParser.isGroup(arg)) stack.push(...arg.content);
      }
    }
  }

  return undefined;
}

/**
 * Get equation type from environment name
 */
function getEnvType(name: string): Equation['type'] {
  if (name.startsWith('align')) return 'align';
  if (name.startsWith('gather')) return 'gather';
  if (name.startsWith('eqnarray')) return 'eqnarray';
  if (name.startsWith('multline')) return 'multline';
  return 'display';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for equation extraction
 */
export interface ExtractEquationsOptions {
  /** Source file path for location info */
  file?: string;
  /** Include inline math */
  includeInline?: boolean;
  /** Original merged LaTeX content (for macro scanning) */
  content?: string;
}

/**
 * Extract all equations from AST using findAll
 */
export function extractEquations(
  ast: LatexAst,
  options?: ExtractEquationsOptions
): Equation[] {
  const { file = 'unknown', includeInline = true, content = '' } = options || {};
  const equations: Equation[] = [];

  const docContent = getDocumentContent(ast);
  const macroPairs = buildMacroWrappedEnvironmentPairsFromContent(content, {
    allowedEnvNames: WRAPPED_MATH_ENV_NAME_KEYS,
  });

  function traverse(nodes: LatexNode[]) {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];

      // Firewall: never recurse into macro/package/class definitions.
      if (latexParser.isCommand(node) && TRAVERSE_HARD_BLOCK_COMMANDS.has(normalizeCommandName(node.name))) {
        continue;
      }
      if (latexParser.isCommand(node) && shouldSkipRecursingIntoCommand(node.name)) {
        continue;
      }

      if (latexParser.isEnvironment(node) && COMMENT_ENVS.has(node.name)) {
        continue;
      }

      const wrapped = matchMacroWrappedEnvironmentAt(nodes, index, macroPairs);
      if (wrapped) {
        const innerNodes = nodes.slice(wrapped.beginIndex + 1, wrapped.endIndex);
        const startLoc = nodeToLocator(wrapped.beginNode, file, content);
        const endLoc = nodeToLocator(wrapped.endNode, file, content);
        equations.push({
          type: getEnvType(wrapped.envName),
          latex: stringifyLatexNodes(innerNodes),
          label: extractLabel(innerNodes),
          envName: wrapped.envName,
          location: mergeSpanLocator(startLoc, endLoc),
        });
        index = wrapped.endIndex;
        continue;
      }

      // Math environments
      if (
        latexParser.isMathEnv(node) ||
        (latexParser.isEnvironment(node) && MATH_ENV_NAMES.has(node.name))
      ) {
        const envNode = node as { name: string; content: LatexNode[] };
        equations.push({
          type: getEnvType(envNode.name),
          latex: stringifyLatexNodes(envNode.content),
          label: extractLabel(envNode.content),
          envName: envNode.name,
          location: nodeToLocator(node, file),
        });
        continue;
      }

      // Display math (\[ \] or $$ $$)
      if (latexParser.isDisplayMath(node)) {
        equations.push({
          type: 'display',
          latex: stringifyLatexNodes(node.content),
          label: extractLabel(node.content),
          location: nodeToLocator(node, file),
        });
        continue;
      }

      // Inline math ($ $) if requested
      if (includeInline && latexParser.isInlineMath(node)) {
        equations.push({
          type: 'inline',
          latex: stringifyLatexNodes(node.content),
          location: nodeToLocator(node, file),
        });
        continue;
      }

      if (latexParser.isEnvironment(node)) {
        traverse(node.content);
      } else if (latexParser.isGroup(node)) {
        traverse(node.content);
      }
    }
  }

  traverse(docContent);

  return equations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enhanced Equation Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonicalize equation LaTeX (remove labels, tags, etc.)
 */
function canonicalizeMath(latex: string): string {
  return latex
    .replace(/\\label\{[^}]*\}/g, '')
    .replace(/\\tag\*?\{[^}]*\}/g, '')
    .replace(/\\(nonumber|notag)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract math signals (symbols and operators) from canonical form
 */
function extractMathSignals(canonical: string): { symbols: string[]; operators: string[] } {
  const commands = canonical.match(/\\[A-Za-z]+/g) ?? [];
  const letters = canonical.match(/\b[A-Za-z]\b/g) ?? [];
  const rawSymbols = [...commands.map(s => s.slice(1)), ...letters];
  const blacklist = new Set<string>([
    'left', 'right', 'big', 'bigg', 'Big', 'Bigg',
    'text', 'mbox', 'mathrm', 'mathbf', 'mathcal', 'cal', 'it',
    'begin', 'end', 'label', 'nonumber', 'notag', 'tag',
    'vspace', 'hspace', 'quad', 'qquad', 'frac', 'over', 'sqrt',
  ]);

  const symbols = Array.from(new Set(rawSymbols))
    .filter((s) => !blacklist.has(s.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  const ops: string[] = [];
  const opPatterns: Array<[RegExp, string]> = [
    [/\\to\b/g, '->'],
    [/\\rightarrow\b/g, '->'],
    [/\\leftrightarrow\b/g, '<->'],
    [/\\approx\b/g, '~'],
    [/\\sim\b/g, '~'],
    [/\\pm\b/g, '±'],
    [/<=|>=|!=|===/g, 'cmp'],
    [/=+/g, '='],
    [/\+/g, '+'],
    [/-/g, '-'],
    [/</g, '<'],
    [/>/g, '>'],
    [/\\int\b/g, '∫'],
    [/\\sum\b/g, '∑'],
    [/\\prod\b/g, '∏'],
    [/\\partial\b/g, '∂'],
    [/\\nabla\b/g, '∇'],
  ];

  for (const [re, token] of opPatterns) {
    if (re.test(canonical)) ops.push(token);
  }

  const operators = Array.from(new Set(ops)).sort((a, b) => a.localeCompare(b));
  return { symbols, operators };
}

/**
 * Enhance a basic equation with physics context classification
 */
export function enhanceEquation(eq: Equation, contextText: string): EnhancedEquation {
  const enhanced: EnhancedEquation = { ...eq };
  
  // Canonicalize the LaTeX
  enhanced.canonical = canonicalizeMath(eq.latex);
  
  // Extract math signals
  const { symbols, operators } = extractMathSignals(enhanced.canonical);
  if (symbols.length > 0) enhanced.symbols = symbols;
  if (operators.length > 0) enhanced.operators = operators;
  
  // Classify equation types based on context and LaTeX content
  const types = classifyEquationType(contextText, eq.latex);
  if (types.length > 0) enhanced.equation_types = types;
  
  // Identify famous equations
  const famousName = identifyFamousEquation(contextText);
  if (famousName) enhanced.equation_name = famousName;
  
  // Extract physical quantities
  const quantities = extractPhysicalQuantities(contextText);
  if (quantities.length > 0) enhanced.physical_quantities = quantities;
  
  // Check if key equation
  const keyResult = isKeyEquation(contextText);
  if (keyResult.is_key) {
    enhanced.is_key_equation = true;
    enhanced.key_equation_reason = keyResult.reason;
  }
  
  return enhanced;
}

/**
 * Options for enhanced equation extraction
 */
export interface ExtractEnhancedEquationsOptions extends ExtractEquationsOptions {
  /** Context window size in characters (before and after equation) */
  contextWindow?: number;
  /** Full document content for context extraction */
  documentContent?: string;
}

/**
 * Extract enhanced equations with physics classification
 */
export function extractEnhancedEquations(
  ast: LatexAst,
  options?: ExtractEnhancedEquationsOptions
): EnhancedEquation[] {
  const { contextWindow = 500, documentContent = '', ...baseOptions } = options || {};
  
  // First extract basic equations
  const basicEquations = extractEquations(ast, baseOptions);
  
  // Enhance each equation with physics context
  return basicEquations.map(eq => {
    // Extract context from document content if available
    let contextText = eq.context || '';
    
    if (documentContent && eq.location) {
      const offset = eq.location.offset;
      const endOffset = eq.location.endOffset ?? offset + eq.latex.length;
      
      const beforeStart = Math.max(0, offset - contextWindow);
      const afterEnd = Math.min(documentContent.length, endOffset + contextWindow);
      
      contextText = documentContent.slice(beforeStart, afterEnd);
    }
    
    return enhanceEquation(eq, contextText);
  });
}

/**
 * Extract enhanced numbered equations with physics classification
 */
export function extractEnhancedNumberedEquations(
  ast: LatexAst,
  options?: ExtractEnhancedEquationsOptions
): EnhancedEquation[] {
  const { contextWindow = 500, documentContent = '', ...baseOptions } = options || {};
  
  // First extract basic numbered equations
  const basicEquations = extractNumberedEquations(ast, baseOptions);
  
  // Enhance each equation with physics context
  return basicEquations.map(eq => {
    // Extract context from document content if available
    let contextText = eq.context || '';
    
    if (documentContent && eq.location) {
      const offset = eq.location.offset;
      const endOffset = eq.location.endOffset ?? offset + eq.latex.length;
      
      const beforeStart = Math.max(0, offset - contextWindow);
      const afterEnd = Math.min(documentContent.length, endOffset + contextWindow);
      
      contextText = documentContent.slice(beforeStart, afterEnd);
    }
    
    return enhanceEquation(eq, contextText);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Numbered Equations Extractor
// ─────────────────────────────────────────────────────────────────────────────

/** Numbered math environment names (no starred versions) */
const NUMBERED_MATH_ENVS = new Set([
  'equation',
  'align',
  'gather',
  'eqnarray',
  'multline',
]);

/**
 * Extract all numbered equations from AST.
 * This returns ALL equations from numbered environments without any filtering.
 * Suitable for review papers and comprehensive extraction.
 */
export function extractNumberedEquations(
  ast: LatexAst,
  options?: ExtractEquationsOptions
): Equation[] {
  const { file = 'unknown', content = '' } = options || {};
  const equations: Equation[] = [];

  const docContent = getDocumentContent(ast);
  const macroPairs = buildMacroWrappedEnvironmentPairsFromContent(content, {
    allowedEnvNames: new Set(Array.from(NUMBERED_MATH_ENVS).map((n) => n.toLowerCase())),
  });

  function traverse(nodes: LatexNode[]) {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];

      // Firewall: never recurse into macro/package/class definitions.
      if (latexParser.isCommand(node) && TRAVERSE_HARD_BLOCK_COMMANDS.has(normalizeCommandName(node.name))) {
        continue;
      }
      if (latexParser.isCommand(node) && shouldSkipRecursingIntoCommand(node.name)) {
        continue;
      }

      if (latexParser.isEnvironment(node) && COMMENT_ENVS.has(node.name)) {
        continue;
      }

      const wrapped = matchMacroWrappedEnvironmentAt(nodes, index, macroPairs);
      if (wrapped) {
        if (wrapped.envName.endsWith('*') || !NUMBERED_MATH_ENVS.has(wrapped.envName)) {
          index = wrapped.endIndex;
          continue;
        }
        const innerNodes = nodes.slice(wrapped.beginIndex + 1, wrapped.endIndex);
        const startLoc = nodeToLocator(wrapped.beginNode, file, content);
        const endLoc = nodeToLocator(wrapped.endNode, file, content);
        equations.push({
          type: getEnvType(wrapped.envName),
          latex: stringifyLatexNodes(innerNodes),
          label: extractLabel(innerNodes),
          envName: wrapped.envName,
          location: mergeSpanLocator(startLoc, endLoc),
        });
        index = wrapped.endIndex;
        continue;
      }

      if (
        latexParser.isMathEnv(node) ||
        (latexParser.isEnvironment(node) && NUMBERED_MATH_ENVS.has(node.name))
      ) {
        const envNode = node as { name: string; content: LatexNode[] };
        const envName = envNode.name;

        // Skip starred (unnumbered) versions
        if (envName.endsWith('*')) continue;

        // Only include if it's a numbered environment
        if (!NUMBERED_MATH_ENVS.has(envName)) continue;

        equations.push({
          type: getEnvType(envName),
          latex: stringifyLatexNodes(envNode.content),
          label: extractLabel(envNode.content),
          envName,
          location: nodeToLocator(node, file),
        });
        continue;
      }

      if (latexParser.isEnvironment(node)) {
        traverse(node.content);
      } else if (latexParser.isGroup(node)) {
        traverse(node.content);
      }
    }
  }

  traverse(docContent);

  return equations;
}
