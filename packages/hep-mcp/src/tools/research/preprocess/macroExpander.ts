/**
 * LaTeX Macro Expander
 * Extracts and safely expands LaTeX macro definitions
 */

import type { MacroDefinition, MacroRegistry } from './types.js';
import { getLineAtPosition } from './utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Macros that should NOT be expanded (side effects, complex behavior)
 */
const UNSAFE_MACROS = new Set([
  // Control flow
  'if', 'else', 'fi', 'ifx', 'ifdefined', 'ifnum', 'ifdim',
  'loop', 'repeat', 'expandafter', 'noexpand',
  // Counters and registers
  'newcounter', 'setcounter', 'addtocounter', 'stepcounter',
  'newlength', 'setlength', 'addtolength',
  // References (need context)
  'ref', 'eqref', 'pageref', 'cite', 'label',
  // Document structure
  'chapter', 'section', 'subsection', 'paragraph',
  'begin', 'end', 'item',
  // Formatting that depends on context
  'textbf', 'textit', 'emph', 'underline',
  // Math operators (keep as-is for readability)
  'frac', 'sqrt', 'sum', 'prod', 'int', 'oint',
  'lim', 'sup', 'inf', 'max', 'min',
]);

/**
 * Common HEP physics macros that are safe to expand
 */
const COMMON_HEP_MACROS: MacroDefinition[] = [
  // Units
  { name: 'GeV', numArgs: 0, expansion: '\\mathrm{GeV}', isSafe: true, type: 'newcommand', location: { file: 'builtin', line: 0 } },
  { name: 'TeV', numArgs: 0, expansion: '\\mathrm{TeV}', isSafe: true, type: 'newcommand', location: { file: 'builtin', line: 0 } },
  { name: 'MeV', numArgs: 0, expansion: '\\mathrm{MeV}', isSafe: true, type: 'newcommand', location: { file: 'builtin', line: 0 } },
  { name: 'fb', numArgs: 0, expansion: '\\mathrm{fb}', isSafe: true, type: 'newcommand', location: { file: 'builtin', line: 0 } },
  { name: 'pb', numArgs: 0, expansion: '\\mathrm{pb}', isSafe: true, type: 'newcommand', location: { file: 'builtin', line: 0 } },
  // Particles
  { name: 'Pgamma', numArgs: 0, expansion: '\\gamma', isSafe: true, type: 'newcommand', location: { file: 'builtin', line: 0 } },
  { name: 'PZ', numArgs: 0, expansion: 'Z', isSafe: true, type: 'newcommand', location: { file: 'builtin', line: 0 } },
  { name: 'PW', numArgs: 0, expansion: 'W', isSafe: true, type: 'newcommand', location: { file: 'builtin', line: 0 } },
  { name: 'PH', numArgs: 0, expansion: 'H', isSafe: true, type: 'newcommand', location: { file: 'builtin', line: 0 } },
];

// ─────────────────────────────────────────────────────────────────────────────
// Macro Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract \newcommand and \renewcommand definitions
 */
function extractNewcommands(
  content: string,
  sourceFile: string
): MacroDefinition[] {
  const macros: MacroDefinition[] = [];

  // Pattern: \newcommand{\name}[numArgs][optArg]{expansion}
  // or: \newcommand*{\name}[numArgs]{expansion}
  const regex = /\\(new|renew)command\*?\s*\{\\([a-zA-Z@]+)\}\s*(?:\[(\d)\])?\s*(?:\[([^\]]*)\])?\s*\{/g;

  let match;
  while ((match = regex.exec(content)) !== null) {
    const type = match[1] === 'new' ? 'newcommand' : 'renewcommand';
    const name = match[2];
    const numArgs = match[3] ? parseInt(match[3], 10) : 0;
    const optionalArg = match[4];

    // Find matching closing brace
    const startIdx = match.index + match[0].length - 1;
    const expansion = extractBraceContent(content, startIdx);

    if (expansion !== null) {
      const isSafe = !UNSAFE_MACROS.has(name) && isSafeExpansion(expansion);
      macros.push({
        name,
        numArgs,
        optionalArg,
        expansion,
        location: { file: sourceFile, line: getLineAtPosition(content, match.index) },
        isSafe,
        type: type as 'newcommand' | 'renewcommand',
      });
    }
  }

  return macros;
}

/**
 * Extract content within matching braces
 * Handles escaped braces correctly (including \\{ which is NOT escaped)
 */
function extractBraceContent(content: string, startIdx: number): string | null {
  if (content[startIdx] !== '{') return null;

  let depth = 1;
  let i = startIdx + 1;

  while (i < content.length && depth > 0) {
    const char = content[i];
    // Count consecutive backslashes before this character
    let backslashCount = 0;
    let j = i - 1;
    while (j >= 0 && content[j] === '\\') {
      backslashCount++;
      j--;
    }
    // Character is escaped only if preceded by odd number of backslashes
    const isEscaped = backslashCount % 2 === 1;

    if (char === '{' && !isEscaped) {
      depth++;
    } else if (char === '}' && !isEscaped) {
      depth--;
    }
    i++;
  }

  if (depth !== 0) return null;
  return content.substring(startIdx + 1, i - 1);
}

/**
 * Check if expansion is safe (no side effects)
 */
function isSafeExpansion(expansion: string): boolean {
  // Unsafe patterns
  const unsafePatterns = [
    /\\(if|else|fi|loop|repeat)/,
    /\\(expandafter|noexpand)/,
    /\\(global|long|outer)/,
    /\\(def|edef|gdef|xdef)/,
    /\\(newcount|newdimen|newskip)/,
    /\\(advance|multiply|divide)/,
  ];

  return !unsafePatterns.some(p => p.test(expansion));
}

/**
 * Extract \def definitions
 */
function extractDefs(
  content: string,
  sourceFile: string
): MacroDefinition[] {
  const macros: MacroDefinition[] = [];

  // Pattern: \def\name{expansion} or \def\name#1#2{expansion}
  const regex = /\\def\\([a-zA-Z@]+)((?:#\d)*)\s*\{/g;

  let match;
  while ((match = regex.exec(content)) !== null) {
    const name = match[1];
    const argPattern = match[2];
    const numArgs = argPattern ? (argPattern.match(/#/g) || []).length : 0;

    const startIdx = match.index + match[0].length - 1;
    const expansion = extractBraceContent(content, startIdx);

    if (expansion !== null) {
      const isSafe = !UNSAFE_MACROS.has(name) && isSafeExpansion(expansion);
      macros.push({
        name,
        numArgs,
        expansion,
        location: { file: sourceFile, line: getLineAtPosition(content, match.index) },
        isSafe,
        type: 'def',
      });
    }
  }

  return macros;
}

/**
 * Extract \DeclareMathOperator definitions
 */
function extractMathOperators(
  content: string,
  sourceFile: string
): MacroDefinition[] {
  const macros: MacroDefinition[] = [];

  // Pattern: \DeclareMathOperator{\name}{text}
  const regex = /\\DeclareMathOperator\*?\s*\{\\([a-zA-Z@]+)\}\s*\{([^}]*)\}/g;

  let match;
  while ((match = regex.exec(content)) !== null) {
    macros.push({
      name: match[1],
      numArgs: 0,
      expansion: `\\operatorname{${match[2]}}`,
      location: { file: sourceFile, line: getLineAtPosition(content, match.index) },
      isSafe: true,
      type: 'DeclareMathOperator',
    });
  }

  return macros;
}

// ─────────────────────────────────────────────────────────────────────────────
// Macro Registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build macro registry from content
 */
export function buildMacroRegistry(
  content: string,
  sourceFile: string = 'main.tex',
  includeBuiltins: boolean = true
): MacroRegistry {
  const macros = new Map<string, MacroDefinition>();
  const skipped: string[] = [];

  // Add builtin HEP macros first
  if (includeBuiltins) {
    for (const macro of COMMON_HEP_MACROS) {
      macros.set(macro.name, macro);
    }
  }

  // Extract all macro types
  const newcommands = extractNewcommands(content, sourceFile);
  const defs = extractDefs(content, sourceFile);
  const mathOps = extractMathOperators(content, sourceFile);

  // Add to registry (later definitions override earlier)
  for (const macro of [...newcommands, ...defs, ...mathOps]) {
    if (macro.isSafe) {
      macros.set(macro.name, macro);
    } else {
      skipped.push(macro.name);
    }
  }

  return { macros, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Macro Expansion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expand a single macro invocation
 */
function expandMacroOnce(
  content: string,
  macro: MacroDefinition
): { result: string; expanded: boolean } {
  // Build pattern for macro with arguments
  let pattern: RegExp;
  if (macro.numArgs === 0) {
    // No arguments: \name followed by non-letter
    pattern = new RegExp(`\\\\${macro.name}(?![a-zA-Z])`, 'g');
  } else {
    // With arguments: \name{arg1}{arg2}...
    const argPattern = '\\{([^{}]*(?:\\{[^{}]*\\}[^{}]*)*)\\}'.repeat(macro.numArgs);
    pattern = new RegExp(`\\\\${macro.name}${argPattern}`, 'g');
  }

  let expanded = false;
  const result = content.replace(pattern, (...args) => {
    expanded = true;
    let expansion = macro.expansion;

    // Replace argument placeholders
    for (let i = 1; i <= macro.numArgs; i++) {
      const argValue = args[i] || '';
      expansion = expansion.replace(new RegExp(`#${i}`, 'g'), argValue);
    }

    return expansion;
  });

  return { result, expanded };
}

/**
 * Expand all macros in content
 */
export function expandMacros(
  content: string,
  registry: MacroRegistry,
  options: { maxIterations?: number; safeOnly?: boolean } = {}
): { content: string; expandedCount: number } {
  const { maxIterations = 10, safeOnly = true } = options;

  let result = content;
  let totalExpanded = 0;
  let iteration = 0;

  // Iterate until no more expansions or max iterations
  while (iteration < maxIterations) {
    let anyExpanded = false;

    for (const [, macro] of registry.macros) {
      if (safeOnly && !macro.isSafe) continue;

      const { result: newResult, expanded } = expandMacroOnce(result, macro);
      if (expanded) {
        result = newResult;
        totalExpanded++;
        anyExpanded = true;
      }
    }

    if (!anyExpanded) break;
    iteration++;
  }

  return { content: result, expandedCount: totalExpanded };
}
