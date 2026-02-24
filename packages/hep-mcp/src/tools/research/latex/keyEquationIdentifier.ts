/**
 * Key Equation Identifier
 * Identifies and scores important equations in LaTeX documents
 *
 * Scoring factors:
 * - Reference count: How many times the equation is cited (\ref, \eqref, etc.)
 * - Position: Equations in abstract/conclusions are more important
 * - Label existence: Labeled equations are typically more important
 * - Context keywords: Surrounding text with "key result", "main equation", etc.
 */

import { latexParser } from 'latex-utensils';
import type { LatexAst, LatexNode } from './parser.js';
import { extractEquations, type Equation } from './equationExtractor.js';
import { extractText } from './sectionExtractor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface KeyEquation extends Equation {
  /** Importance score (0-100) */
  importance_score: number;
  /** Number of times referenced in text */
  reference_count: number;
  /** Section where equation appears */
  section?: string;
  /** Whether in abstract or conclusions */
  in_key_section: boolean;
  /** Surrounding context text */
  context_text?: string;
  /** Keywords found near equation */
  context_keywords: string[];
}

export interface KeyEquationOptions {
  /** Maximum equations to return (default: 10) */
  max_equations?: number;
  /** Minimum importance score (default: 20) */
  min_score?: number;
  /** Include inline math (default: false) */
  include_inline?: boolean;
  /** Context window size in characters (default: 300) */
  context_window?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Keywords indicating important equations */
const IMPORTANCE_KEYWORDS = [
  'key result', 'main result', 'central result', 'principal result',
  'key equation', 'main equation', 'central equation', 'fundamental equation',
  'important', 'crucial', 'essential', 'primary',
  'master equation', 'defining equation', 'basic equation',
  'our result', 'final result', 'main finding',
  'dispersion relation', 'sum rule', 'amplitude',
];

/** Section names indicating key content */
const KEY_SECTIONS = [
  'abstract', 'summary', 'conclusion', 'conclusions',
  'results', 'main results', 'discussion',
];

/** Scoring weights */
const WEIGHTS = {
  reference: 15,      // Per reference
  label: 10,          // Has label
  key_section: 20,    // In abstract/conclusions
  keyword: 8,         // Per keyword found
  display_type: 5,    // Display vs inline
  max_reference: 45,  // Cap for reference score
  max_keyword: 24,    // Cap for keyword score
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count references to equation labels in the document
 */
function countReferences(texContent: string): Map<string, number> {
  const refCounts = new Map<string, number>();

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
      const labels = match[1].split(',').map(l => l.trim());
      for (const label of labels) {
        refCounts.set(label, (refCounts.get(label) || 0) + 1);
      }
    }
  }

  return refCounts;
}

/**
 * Find the section containing a given position in the document
 */
function findSectionAtPosition(
  nodes: LatexNode[],
  targetIndex: number
): string | undefined {
  let currentSection: string | undefined;
  let nodeIndex = 0;

  function traverse(nodeList: LatexNode[]) {
    for (const node of nodeList) {
      if (nodeIndex > targetIndex) return;

      if (latexParser.isCommand(node)) {
        const sectionCommands = ['section', 'subsection', 'subsubsection', 'chapter'];
        if (sectionCommands.includes(node.name)) {
          const arg = node.args[0];
          if (arg && latexParser.isGroup(arg)) {
            currentSection = extractText(arg.content);
          }
        }
      }

      nodeIndex++;

      if (latexParser.isEnvironment(node)) {
        traverse(node.content);
      }
    }
  }

  traverse(nodes);
  return currentSection;
}

/**
 * Check if text contains importance keywords
 */
function findKeywords(text: string): string[] {
  const lowerText = text.toLowerCase();
  return IMPORTANCE_KEYWORDS.filter(kw => lowerText.includes(kw));
}

/**
 * Check if section name indicates key content
 */
function isKeySection(sectionName?: string): boolean {
  if (!sectionName) return false;
  const lower = sectionName.toLowerCase();
  return KEY_SECTIONS.some(ks => lower.includes(ks));
}

/**
 * Extract context around an equation from raw LaTeX content
 */
function extractContext(
  texContent: string,
  equationLatex: string,
  windowSize: number
): string {
  const idx = texContent.indexOf(equationLatex);
  if (idx === -1) return '';

  const start = Math.max(0, idx - windowSize);
  const end = Math.min(texContent.length, idx + equationLatex.length + windowSize);

  let context = texContent.slice(start, end);
  // Clean up LaTeX commands for readability
  context = context
    .replace(/\\[a-zA-Z]+\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return context;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identify and score key equations in a LaTeX document
 */
export function identifyKeyEquations(
  ast: LatexAst,
  texContent: string,
  options: KeyEquationOptions = {}
): KeyEquation[] {
  const {
    max_equations = 10,
    min_score = 20,
    include_inline = false,
    context_window = 300,
  } = options;

  // Step 1: Extract all equations
  let equations = extractEquations(ast, { content: texContent });

  // Filter inline if not requested
  if (!include_inline) {
    equations = equations.filter(eq => eq.type !== 'inline');
  }

  // Step 2: Count references
  const refCounts = countReferences(texContent);

  // Step 3: Score each equation
  const scoredEquations: KeyEquation[] = equations.map((eq, index) => {
    let score = 0;
    const keywords: string[] = [];

    // Reference score
    const refCount = eq.label ? (refCounts.get(eq.label) || 0) : 0;
    const refScore = Math.min(refCount * WEIGHTS.reference, WEIGHTS.max_reference);
    score += refScore;

    // Label score
    if (eq.label) {
      score += WEIGHTS.label;
    }

    // Display type score
    if (eq.type !== 'inline') {
      score += WEIGHTS.display_type;
    }

    // Section analysis
    const section = findSectionAtPosition(ast.content, index);
    const inKeySection = isKeySection(section);
    if (inKeySection) {
      score += WEIGHTS.key_section;
    }

    // Context keyword analysis
    const context = extractContext(texContent, eq.latex, context_window);
    const foundKeywords = findKeywords(context);
    const keywordScore = Math.min(
      foundKeywords.length * WEIGHTS.keyword,
      WEIGHTS.max_keyword
    );
    score += keywordScore;
    keywords.push(...foundKeywords);

    return {
      ...eq,
      importance_score: Math.min(score, 100),
      reference_count: refCount,
      section,
      in_key_section: inKeySection,
      context_text: context || undefined,
      context_keywords: keywords,
    };
  });

  // Step 4: Sort by importance and filter
  return scoredEquations
    .filter(eq => eq.importance_score >= min_score)
    .sort((a, b) => b.importance_score - a.importance_score)
    .slice(0, max_equations);
}

/**
 * Get a summary of key equations suitable for review output
 */
export function summarizeKeyEquations(
  keyEquations: KeyEquation[]
): Array<{
  latex: string;
  label?: string;
  importance: 'high' | 'medium' | 'low';
  description: string;
}> {
  return keyEquations.map(eq => {
    let importance: 'high' | 'medium' | 'low';
    if (eq.importance_score >= 60) {
      importance = 'high';
    } else if (eq.importance_score >= 40) {
      importance = 'medium';
    } else {
      importance = 'low';
    }

    // Build description
    const parts: string[] = [];
    if (eq.reference_count > 0) {
      parts.push(`referenced ${eq.reference_count} time(s)`);
    }
    if (eq.in_key_section && eq.section) {
      parts.push(`in ${eq.section}`);
    }
    if (eq.context_keywords.length > 0) {
      parts.push(`keywords: ${eq.context_keywords.slice(0, 2).join(', ')}`);
    }

    return {
      latex: eq.latex,
      label: eq.label,
      importance,
      description: parts.join('; ') || 'display equation',
    };
  });
}
