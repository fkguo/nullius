/**
 * Depth Checker - Verifies analytical depth of generated content
 *
 * Checks for:
 * - Analytical sentences (suggests, indicates, implies)
 * - Comparison sentences (however, in contrast, whereas)
 * - Figure/equation discussion depth
 */

import type { DepthConfig } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Pattern Definitions
// ─────────────────────────────────────────────────────────────────────────────

/** Patterns indicating analytical/interpretive sentences */
const ANALYSIS_PATTERNS = [
  /\bsuggests?\b/i,
  /\bindicates?\b/i,
  /\bimplies?\b/i,
  /\bdemonstrates?\b/i,
  /\breveals?\b/i,
  /\bconfirms?\b/i,
  /\bsupports?\b/i,
  /\bpoints?\s+to\b/i,
  /\bconsistent\s+with\b/i,
  /\bcan\s+be\s+(interpreted|understood|explained)\b/i,
  /\bthis\s+(result|finding|observation)\b/i,
];

/** Patterns indicating comparison/contrast sentences */
const COMPARISON_PATTERNS = [
  /\bhowever\b/i,
  /\bin\s+contrast\b/i,
  /\bwhereas\b/i,
  /\bwhile\b/i,
  /\bon\s+the\s+other\s+hand\b/i,
  /\bconversely\b/i,
  /\bunlike\b/i,
  /\bcompared\s+(to|with)\b/i,
  /\bdiffers?\s+from\b/i,
  /\bin\s+comparison\b/i,
  /\balternatively\b/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Advisory level for depth check (soft constraint) */
export type DepthAdvisory = 'good' | 'acceptable' | 'needs_improvement';

export interface DepthCheckResult {
  /** Advisory level instead of pass/fail (Phase 1 soft constraints) */
  advisory: DepthAdvisory;
  /** Legacy pass field for backward compatibility */
  pass: boolean;
  analysis_sentences: {
    count: number;
    min_required: number;
    pass: boolean;
    examples: string[];
  };
  comparison_sentences: {
    count: number;
    min_required: number;
    pass: boolean;
    examples: string[];
  };
  figure_discussions: FigureDiscussionResult[];
  equation_discussions: EquationDiscussionResult[];
  table_discussions: TableDiscussionResult[];
  issues: string[];
  suggestions: string[];
}

export interface FigureDiscussionResult {
  label: string;
  word_count: number;
  min_required: number;
  pass: boolean;
  context: string;
}

export interface EquationDiscussionResult {
  label: string;
  word_count: number;
  min_required: number;
  pass: boolean;
  context: string;
}

export interface TableDiscussionResult {
  label: string;
  word_count: number;
  min_required: number;
  pass: boolean;
  context: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/** Split content into sentences */
function splitSentences(content: string): string[] {
  // Remove LaTeX commands that might interfere
  const cleaned = content
    .replace(/\\cite\{[^}]+\}/g, '')
    .replace(/\\ref\{[^}]+\}/g, '')
    .replace(/~+/g, ' ');

  // Split on sentence boundaries
  return cleaned
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 10);
}

/** Count words in text */
function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

/** Check if sentence matches any pattern */
function matchesPatterns(sentence: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(sentence));
}

/**
 * Compute advisory level based on analysis metrics (Phase 1 soft constraints).
 * Returns 'good', 'acceptable', or 'needs_improvement' instead of pass/fail.
 */
function computeAdvisory(
  analysisCount: number,
  comparisonCount: number,
  allChecksPass: boolean
): DepthAdvisory {
  // If all hard checks pass and we have good analytical depth
  if (allChecksPass && analysisCount >= 3 && comparisonCount >= 2) {
    return 'good';
  }
  // If we have some analytical content or all checks pass
  if (allChecksPass || analysisCount >= 1 || comparisonCount >= 1) {
    return 'acceptable';
  }
  // Needs improvement but not blocking
  return 'needs_improvement';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check analytical depth of content
 */
export function checkDepth(
  content: string,
  constraints: DepthConfig,
  figureLabels: string[] = [],
  equationLabels: string[] = [],
  tableLabels: string[] = []
): DepthCheckResult {
  const sentences = splitSentences(content);
  const issues: string[] = [];
  const suggestions: string[] = [];

  // Check analysis sentences
  const analysisSentences = sentences.filter(s => matchesPatterns(s, ANALYSIS_PATTERNS));
  const minAnalysis = constraints.min_analysis_sentences || 0;
  const analysisPass = analysisSentences.length >= minAnalysis;

  if (!analysisPass && minAnalysis > 0) {
    issues.push(`Only ${analysisSentences.length}/${minAnalysis} analytical sentences found`);
    suggestions.push('Add interpretive sentences using "suggests", "indicates", "demonstrates"');
  }

  // Check comparison sentences
  const comparisonSentences = sentences.filter(s => matchesPatterns(s, COMPARISON_PATTERNS));
  const minComparison = constraints.min_comparison_sentences || 0;
  const comparisonPass = comparisonSentences.length >= minComparison;

  if (!comparisonPass && minComparison > 0) {
    issues.push(`Only ${comparisonSentences.length}/${minComparison} comparison sentences found`);
    suggestions.push('Add comparative analysis using "however", "in contrast", "compared to"');
  }

  // Check figure discussions
  const figureDiscussions = checkFigureDiscussions(
    content,
    figureLabels,
    constraints.min_figure_discussion_words || 0
  );
  const figurePass = figureDiscussions.every(f => f.pass);

  if (!figurePass) {
    const failing = figureDiscussions.filter(f => !f.pass);
    issues.push(`${failing.length} figure(s) lack sufficient discussion`);
    suggestions.push('Expand figure discussions to explain significance and implications');
  }

  // Check equation discussions
  const equationDiscussions = checkEquationDiscussions(
    content,
    equationLabels,
    constraints.min_equation_explanation_words || 0
  );
  const equationPass = equationDiscussions.every(e => e.pass);

  if (!equationPass) {
    const failing = equationDiscussions.filter(e => !e.pass);
    issues.push(`${failing.length} equation(s) lack sufficient explanation`);
    suggestions.push('Add explanations for equation terms and physical significance');
  }

  // Check table discussions
  const tableDiscussions = checkTableDiscussions(
    content,
    tableLabels,
    constraints.min_table_discussion_words || 0
  );
  const tablePass = tableDiscussions.every(t => t.pass);

  if (!tablePass) {
    const failing = tableDiscussions.filter(t => !t.pass);
    issues.push(`${failing.length} table(s) lack sufficient discussion`);
    suggestions.push('Expand table discussions to explain data significance');
  }

  // Compute advisory level (soft constraint)
  const allPass = analysisPass && comparisonPass && figurePass && equationPass && tablePass;
  const advisory = computeAdvisory(analysisSentences.length, comparisonSentences.length, allPass);

  return {
    advisory,
    pass: allPass,  // Legacy field for backward compatibility
    analysis_sentences: {
      count: analysisSentences.length,
      min_required: minAnalysis,
      pass: analysisPass,
      examples: analysisSentences.slice(0, 3),
    },
    comparison_sentences: {
      count: comparisonSentences.length,
      min_required: minComparison,
      pass: comparisonPass,
      examples: comparisonSentences.slice(0, 3),
    },
    figure_discussions: figureDiscussions,
    equation_discussions: equationDiscussions,
    table_discussions: tableDiscussions,
    issues,
    suggestions,
  };
}

/**
 * Check figure discussion depth
 */
function checkFigureDiscussions(
  content: string,
  figureLabels: string[],
  minWords: number
): FigureDiscussionResult[] {
  if (minWords === 0 || figureLabels.length === 0) {
    return [];
  }

  const results: FigureDiscussionResult[] = [];

  for (const label of figureLabels) {
    // Find sentences mentioning this figure
    const pattern = new RegExp(`[^.]*\\\\ref\\{${label}\\}[^.]*\\.`, 'gi');
    const matches = content.match(pattern) || [];
    const context = matches.join(' ');
    const wordCount = countWords(context);

    results.push({
      label,
      word_count: wordCount,
      min_required: minWords,
      pass: wordCount >= minWords,
      context: context.slice(0, 200),
    });
  }

  return results;
}

/**
 * Check equation discussion depth
 */
function checkEquationDiscussions(
  content: string,
  equationLabels: string[],
  minWords: number
): EquationDiscussionResult[] {
  if (minWords === 0 || equationLabels.length === 0) {
    return [];
  }

  const results: EquationDiscussionResult[] = [];

  for (const label of equationLabels) {
    // Find sentences mentioning this equation
    const pattern = new RegExp(`[^.]*\\\\ref\\{${label}\\}[^.]*\\.`, 'gi');
    const matches = content.match(pattern) || [];
    const context = matches.join(' ');
    const wordCount = countWords(context);

    results.push({
      label,
      word_count: wordCount,
      min_required: minWords,
      pass: wordCount >= minWords,
      context: context.slice(0, 200),
    });
  }

  return results;
}

/**
 * Check table discussion depth
 */
function checkTableDiscussions(
  content: string,
  tableLabels: string[],
  minWords: number
): TableDiscussionResult[] {
  if (minWords === 0 || tableLabels.length === 0) {
    return [];
  }

  const results: TableDiscussionResult[] = [];

  for (const label of tableLabels) {
    const pattern = new RegExp(`[^.]*\\\\ref\\{${label}\\}[^.]*\\.`, 'gi');
    const matches = content.match(pattern) || [];
    const context = matches.join(' ');
    const wordCount = countWords(context);

    results.push({
      label,
      word_count: wordCount,
      min_required: minWords,
      pass: wordCount >= minWords,
      context: context.slice(0, 200),
    });
  }

  return results;
}
