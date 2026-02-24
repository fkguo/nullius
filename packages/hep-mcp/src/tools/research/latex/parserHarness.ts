/**
 * Parser Harness - Robust LaTeX parsing entry point
 *
 * Provides:
 * 1. UserMacroRegistry - Custom macro registry (semantic patches)
 * 2. shouldSkipNode() - Comment filtering
 * 3. safeParseLatex() - Strict parse (fail-fast)
 *
 * @module parserHarness
 */

import { invalidParams } from '@autoresearch/shared';
import { latexParser } from 'latex-utensils';
import type * as LU from 'latex-utensils';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type LatexNode = LU.latexParser.Node;
export type LatexAst = LU.latexParser.LatexAst;

/**
 * Custom macro registry (semantic patches)
 * Used to identify user-defined environments and commands in preamble
 */
export interface UserMacroRegistry {
  /** Environment macro mapping: \be -> equation, \ba -> align */
  environmentMacros: Map<string, string>;
  /** Begin-environment macro mapping: \be -> equation */
  environmentBeginMacros: Map<string, string>;
  /** End-environment macro mapping: \ee -> equation */
  environmentEndMacros: Map<string, string>;
  /** Command macro mapping: \GeV -> \mathrm{GeV} */
  commandMacros: Map<string, string>;
  /** Raw macro definitions (for debugging) */
  rawDefinitions: Array<{
    name: string;
    definition: string;
    line?: number;
  }>;
}

/**
 * Safe parse result
 */
export interface SafeParseResult {
  ast: LatexAst;
  recovered: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Comment environment names */
const COMMENT_ENVS = new Set(['comment', 'Comment', 'COMMENT']);

/** Common HEP paper custom environment macros */
const COMMON_HEP_ENV_MACROS: Record<string, string> = {
  be: 'equation',
  ee: 'equation',
  ba: 'align',
  ea: 'align',
  bea: 'eqnarray',
  eea: 'eqnarray',
  beq: 'equation',
  eeq: 'equation',
};

/** Common HEP paper unit/symbol commands */
const COMMON_HEP_COMMANDS: Record<string, string> = {
  GeV: '\\mathrm{GeV}',
  MeV: '\\mathrm{MeV}',
  TeV: '\\mathrm{TeV}',
  keV: '\\mathrm{keV}',
  eV: '\\mathrm{eV}',
  fb: '\\mathrm{fb}',
  pb: '\\mathrm{pb}',
  nb: '\\mathrm{nb}',
};

/** Default parse timeout in milliseconds */
const DEFAULT_PARSE_TIMEOUT = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// UserMacroRegistry Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an empty macro registry
 */
export function createEmptyRegistry(): UserMacroRegistry {
  return {
    environmentMacros: new Map(),
    environmentBeginMacros: new Map(),
    environmentEndMacros: new Map(),
    commandMacros: new Map(),
    rawDefinitions: [],
  };
}

/**
 * Scan preamble to identify custom macros
 *
 * Recognized patterns:
 * - \newcommand{\be}{\begin{equation}}
 * - \def\be{\begin{equation}}
 * - \renewcommand{\GeV}{\mathrm{GeV}}
 *
 * @param content - LaTeX document content
 * @returns Macro registry
 */
export function scanPreambleForMacros(content: string): UserMacroRegistry {
  const registry = createEmptyRegistry();

  // Extract preamble (between \documentclass and \begin{document})
  const preambleMatch = content.match(
    /\\documentclass[\s\S]*?(?=\\begin\{document\})/
  );
  const preamble = preambleMatch ? preambleMatch[0] : content.slice(0, 5000);

  // Pattern 1a: \newcommand{\xxx}{\begin{yyy}} or \renewcommand
  const envBeginMacroPattern =
    /\\(?:new|renew)command\*?\{\\(\w+)\}\s*\{\\begin\{([^}]+)\}/g;
  let match;
  while ((match = envBeginMacroPattern.exec(preamble))) {
    const [, macroName, envName] = match;
    registry.environmentMacros.set(macroName, envName);
    registry.environmentBeginMacros.set(macroName, envName);
    registry.rawDefinitions.push({
      name: macroName,
      definition: `\\begin{${envName}}`,
    });
  }

  // Pattern 1b: \newcommand{\xxx}{\end{yyy}} or \renewcommand
  const envEndMacroPattern =
    /\\(?:new|renew)command\*?\{\\(\w+)\}\s*\{\\end\{([^}]+)\}/g;
  while ((match = envEndMacroPattern.exec(preamble))) {
    const [, macroName, envName] = match;
    registry.environmentMacros.set(macroName, envName);
    registry.environmentEndMacros.set(macroName, envName);
    registry.rawDefinitions.push({
      name: macroName,
      definition: `\\end{${envName}}`,
    });
  }

  // Pattern 2a: \def\xxx{\begin{yyy}}
  const defBeginEnvPattern = /\\def\\(\w+)\s*\{\\begin\{([^}]+)\}/g;
  while ((match = defBeginEnvPattern.exec(preamble))) {
    const [, macroName, envName] = match;
    registry.environmentMacros.set(macroName, envName);
    registry.environmentBeginMacros.set(macroName, envName);
    registry.rawDefinitions.push({
      name: macroName,
      definition: `\\begin{${envName}}`,
    });
  }

  // Pattern 2b: \def\xxx{\end{yyy}}
  const defEndEnvPattern = /\\def\\(\w+)\s*\{\\end\{([^}]+)\}/g;
  while ((match = defEndEnvPattern.exec(preamble))) {
    const [, macroName, envName] = match;
    registry.environmentMacros.set(macroName, envName);
    registry.environmentEndMacros.set(macroName, envName);
    registry.rawDefinitions.push({
      name: macroName,
      definition: `\\end{${envName}}`,
    });
  }

  // Pattern 3: \newcommand{\xxx}[n]{...} regular commands (non-environment)
  // Find newcommand declarations and extract balanced brace content
  const cmdDeclPattern = /\\(?:new|renew)command\*?\{\\(\w+)\}(?:\[\d+\](?:\[[^\]]*\])?)?\s*\{/g;
  while ((match = cmdDeclPattern.exec(preamble))) {
    const macroName = match[1];
    const startIdx = match.index + match[0].length;
    
    // Extract balanced brace content
    let depth = 1;
    let endIdx = startIdx;
    while (depth > 0 && endIdx < preamble.length) {
      const ch = preamble[endIdx];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      endIdx++;
    }
    
    if (depth === 0) {
      const definition = preamble.slice(startIdx, endIdx - 1);
      // Exclude already identified environment macros
      if (!registry.environmentMacros.has(macroName)) {
        registry.commandMacros.set(macroName, definition);
        registry.rawDefinitions.push({ name: macroName, definition });
      }
    }
  }

  // Add common HEP macros (if not defined in preamble)
  for (const [name, env] of Object.entries(COMMON_HEP_ENV_MACROS)) {
    if (!registry.environmentMacros.has(name)) {
      registry.environmentMacros.set(name, env);
    }
    if (name.startsWith('b')) {
      if (!registry.environmentBeginMacros.has(name)) {
        registry.environmentBeginMacros.set(name, env);
      }
    } else if (name.startsWith('e')) {
      if (!registry.environmentEndMacros.has(name)) {
        registry.environmentEndMacros.set(name, env);
      }
    }
  }

  for (const [name, def] of Object.entries(COMMON_HEP_COMMANDS)) {
    if (!registry.commandMacros.has(name)) {
      registry.commandMacros.set(name, def);
    }
  }

  return registry;
}

/**
 * Check if a command is a custom environment macro
 */
export function isEnvironmentMacro(
  commandName: string,
  registry: UserMacroRegistry
): string | undefined {
  return registry.environmentMacros.get(commandName);
}

// ─────────────────────────────────────────────────────────────────────────────
// Comment Filtering (shouldSkipNode)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parent chain type for tracking node ancestry
 */
export interface ParentChain {
  node: LatexNode;
  parent?: ParentChain;
}

/**
 * Check if a node is inside a comment environment
 *
 * @param _node - Current node (unused, kept for API consistency)
 * @param parent - Parent chain
 * @returns Whether the node is inside a comment environment
 */
export function isInCommentEnv(
  _node: LatexNode,
  parent: ParentChain | undefined
): boolean {
  let current = parent;
  while (current) {
    const n = current.node;
    if (latexParser.isEnvironment(n) && COMMENT_ENVS.has(n.name)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Determine if a node should be skipped (comment filtering)
 *
 * Skip conditions:
 * 1. Comment nodes (kind === 'comment')
 * 2. Nodes inside comment environments
 *
 * @param node - Current node
 * @param parent - Parent chain
 * @returns Whether the node should be skipped
 */
export function shouldSkipNode(
  node: LatexNode,
  parent?: ParentChain
): boolean {
  // Skip Comment nodes
  if ((node as { kind?: string }).kind === 'comment') {
    return true;
  }
  // Skip nodes inside comment environments
  if (isInCommentEnv(node, parent)) {
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Brace Balancing Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Balance unclosed braces by adding closing braces at the end.
 * This handles common issues like TM{$_{010}$ (unmatched {) in arXiv sources.
 * LaTeX compiles these fine but the parser needs balanced braces.
 */
function balanceBraces(content: string): string {
  let braceCount = 0;
  let inComment = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const prev = i > 0 ? content[i - 1] : '';

    // Track comments (skip to end of line)
    if (ch === '%' && prev !== '\\') {
      inComment = true;
      continue;
    }
    if (ch === '\n') {
      inComment = false;
      continue;
    }
    if (inComment) continue;

    // Skip escaped braces
    if (prev === '\\') continue;

    if (ch === '{') braceCount++;
    if (ch === '}') braceCount--;
  }

  // Add closing braces if needed (before \end{document} if present)
  if (braceCount > 0) {
    const closingBraces = '}'.repeat(braceCount);
    const endDocMatch = content.match(/\\end\s*\{\s*document\s*\}/);
    if (endDocMatch && endDocMatch.index !== undefined) {
      return (
        content.slice(0, endDocMatch.index) +
        closingBraces +
        content.slice(endDocMatch.index)
      );
    }
    return content + closingBraces;
  }

  return content;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe Parse (Fail-fast)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse options for safeParseLatex
 */
export interface SafeParseOptions {
  /** Parse timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** File path for error messages */
  file?: string;
}

/**
 * Safely parse LaTeX content (fail-fast; no truncated/regex fallbacks).
 *
 * @param content - LaTeX content to parse
 * @param options - Parse options
 * @returns Safe parse result
 */
export function safeParseLatex(
  content: string,
  options?: SafeParseOptions
): SafeParseResult {
  const {
    timeout = DEFAULT_PARSE_TIMEOUT,
    file = 'unknown',
  } = options || {};

  // Truncate content after \end{document} - anything after is not part of the document
  const endDocMatch = content.match(/\\end\s*\{\s*document\s*\}/);
  if (endDocMatch && endDocMatch.index !== undefined) {
    content = content.slice(0, endDocMatch.index + endDocMatch[0].length);
  }

  // Full parse
  try {
    const ast = latexParser.parse(content, {
      enableComment: true,
      timeout,
    });
    return { ast, recovered: false };
  } catch (e1) {
    const error1 = e1 instanceof Error ? e1.message : String(e1);
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    const lineCount = content.split('\n').length;

    // Recovery attempt: brace balancing (handles TM{$_{010}$ style issues)
    try {
      const braceBalanced = balanceBraces(content);
      const ast = latexParser.parse(braceBalanced, {
        enableComment: true,
        timeout,
      });
      return { ast, recovered: true };
    } catch (e2) {
      const error2 = e2 instanceof Error ? e2.message : String(e2);
      throw invalidParams(`LaTeX parse failed (fail-fast): ${file}`, {
        file,
        timeout_ms: timeout,
        size_bytes: sizeBytes,
        line_count: lineCount,
        attempts: [
          { strategy: 'full', error: error1 },
          { strategy: 'brace_balanced', error: error2 },
        ],
        next_actions: [
          {
            suggestion: 'Ensure the LaTeX source is complete (no truncation) and compiles; then retry.',
          },
          {
            suggestion: 'If this comes from arXiv source, verify you used the correct main .tex file and merged includes.',
          },
          {
            suggestion: 'Try increasing the parse timeout (options.timeout) if the document is very large.',
          },
        ],
      });
    }
  }
}
