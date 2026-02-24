/**
 * LaTeX Preprocessing Types
 * Types for flattening, macro expansion, and source mapping
 */

// ─────────────────────────────────────────────────────────────────────────────
// Source Mapping Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a line in the flattened content to its original source
 */
export interface SourceLocation {
  /** Original source file path */
  file: string;
  /** Line number in original file (1-based) */
  line: number;
  /** Column offset (0-based, optional) */
  column?: number;
}

/**
 * Source map for the entire flattened document
 * Maps flattened line numbers to original locations
 */
export interface SourceMap {
  /** Map from flattened line number (1-based) to source location */
  lineMap: Map<number, SourceLocation>;
  /** All source files involved */
  sourceFiles: string[];
  /** Main file path */
  mainFile: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Macro Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A LaTeX macro definition
 */
export interface MacroDefinition {
  /** Macro name (without backslash) */
  name: string;
  /** Number of arguments (0-9) */
  numArgs: number;
  /** Optional argument default value */
  optionalArg?: string;
  /** Expansion template (with #1, #2, etc.) */
  expansion: string;
  /** Source location where defined */
  location: SourceLocation;
  /** Whether this is a safe macro to expand */
  isSafe: boolean;
  /** Definition type */
  type: 'newcommand' | 'renewcommand' | 'def' | 'let' | 'DeclareMathOperator';
}

/**
 * Collection of macro definitions
 */
export interface MacroRegistry {
  /** All defined macros */
  macros: Map<string, MacroDefinition>;
  /** Macros that were skipped (unsafe to expand) */
  skipped: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Math Environment Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalized math environment types
 */
export type MathEnvType =
  | 'inline'      // $...$ or \(...\)
  | 'display'     // $$...$$ or \[...\] or equation
  | 'align'       // align, align*, eqnarray
  | 'gather'      // gather, gather*
  | 'multline'    // multline, multline*
  | 'split'       // split (inside other envs)
  | 'cases'       // cases
  | 'array'       // array, matrix variants
  | 'subequations'; // subequations wrapper

/**
 * A normalized math block
 */
export interface NormalizedMath {
  /** Environment type */
  type: MathEnvType;
  /** Math content (without delimiters) */
  content: string;
  /** Label if present */
  label?: string;
  /** Line range in flattened content */
  lineRange: [number, number];
  /** Original environment name */
  originalEnv: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preprocessing Result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of LaTeX preprocessing
 */
export interface PreprocessResult {
  /** Flattened and processed content */
  content: string;
  /** Source map for line tracking */
  sourceMap: SourceMap;
  /** Extracted macro definitions */
  macros: MacroRegistry;
  /** Normalized math environments */
  mathBlocks: NormalizedMath[];
  /** Processing statistics */
  stats: PreprocessStats;
}

/**
 * Preprocessing statistics
 */
export interface PreprocessStats {
  /** Number of files merged */
  filesMerged: number;
  /** Number of macros found */
  macrosFound: number;
  /** Number of macros expanded */
  macrosExpanded: number;
  /** Number of math environments normalized */
  mathEnvsNormalized: number;
  /** Processing time in ms */
  processingTimeMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for LaTeX preprocessing
 */
export interface PreprocessOptions {
  /** Maximum recursion depth for includes (default: 10) */
  maxDepth?: number;
  /** Expand macros (default: true) */
  expandMacros?: boolean;
  /** Only expand safe macros (default: true) */
  safeExpansionOnly?: boolean;
  /** Normalize math environments (default: true) */
  normalizeMath?: boolean;
  /** Preserve comments (default: false) */
  preserveComments?: boolean;
  /** Custom macro definitions to use */
  customMacros?: MacroDefinition[];
}
