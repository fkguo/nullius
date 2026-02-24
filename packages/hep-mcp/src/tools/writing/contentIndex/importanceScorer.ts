/**
 * Figure Importance Scorer
 * Scores figure importance based on reference count, caption keywords, and section position
 */

import type { Figure } from '../../research/latex/figureExtractor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Keywords indicating important figures */
const IMPORTANCE_KEYWORDS = [
  'main result', 'key result', 'central result',
  'summary', 'overview', 'schematic',
  'comparison', 'experimental', 'measurement',
  'spectrum', 'distribution', 'cross section',
  'mass', 'width', 'branching ratio',
  'fit', 'data', 'signal',
];

/** Section names indicating key content */
const KEY_SECTIONS = [
  'results', 'discussion', 'analysis',
  'experimental results', 'main results',
];

/** Scoring weights */
const WEIGHTS = {
  reference: 10,
  label: 5,
  key_section: 15,
  keyword: 5,
  max_reference: 30,
  max_keyword: 15,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count references to figure labels in the document
 */
export function countFigureReferences(
  texContent: string,
  label: string | undefined
): number {
  if (!label) return 0;

  const refPatterns = [
    new RegExp(`\\\\ref\\{${escapeRegex(label)}\\}`, 'g'),
    new RegExp(`\\\\cref\\{${escapeRegex(label)}\\}`, 'g'),
    new RegExp(`\\\\autoref\\{${escapeRegex(label)}\\}`, 'g'),
    new RegExp(`\\\\Cref\\{${escapeRegex(label)}\\}`, 'g'),
    new RegExp(`Fig\\.?\\s*\\\\ref\\{${escapeRegex(label)}\\}`, 'gi'),
  ];

  let count = 0;
  for (const pattern of refPatterns) {
    const matches = texContent.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if caption contains importance keywords
 */
function captionContainsKeywords(caption: string | undefined): string[] {
  if (!caption) return [];
  const lowerCaption = caption.toLowerCase();
  return IMPORTANCE_KEYWORDS.filter(kw => lowerCaption.includes(kw));
}

/**
 * Check if section name indicates key content
 */
function isKeySection(sectionName: string | undefined): boolean {
  if (!sectionName) return false;
  const lower = sectionName.toLowerCase();
  return KEY_SECTIONS.some(ks => lower.includes(ks));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export type ImportanceLevel = 'high' | 'medium' | 'low';

export interface ScoredFigure extends Figure {
  importance: ImportanceLevel;
  importance_score: number;
  reference_count: number;
  context_keywords: string[];
}

/**
 * Score figure importance
 */
export function scoreFigureImportance(
  figure: Figure,
  texContent: string
): ScoredFigure {
  let score = 0;
  const keywords: string[] = [];

  // Reference score
  const refCount = countFigureReferences(texContent, figure.label);
  const refScore = Math.min(refCount * WEIGHTS.reference, WEIGHTS.max_reference);
  score += refScore;

  // Label score
  if (figure.label) {
    score += WEIGHTS.label;
  }

  // Section analysis
  const inKeySection = isKeySection(figure.section);
  if (inKeySection) {
    score += WEIGHTS.key_section;
  }

  // Caption keyword analysis
  const foundKeywords = captionContainsKeywords(figure.caption);
  const keywordScore = Math.min(
    foundKeywords.length * WEIGHTS.keyword,
    WEIGHTS.max_keyword
  );
  score += keywordScore;
  keywords.push(...foundKeywords);

  // Determine importance level
  let importance: ImportanceLevel;
  if (score >= 40) {
    importance = 'high';
  } else if (score >= 20) {
    importance = 'medium';
  } else {
    importance = 'low';
  }

  return {
    ...figure,
    importance,
    importance_score: Math.min(score, 100),
    reference_count: refCount,
    context_keywords: keywords,
  };
}

/**
 * Score all figures in a document
 */
export function scoreFigures(
  figures: Figure[],
  texContent: string
): ScoredFigure[] {
  return figures
    .map(fig => scoreFigureImportance(fig, texContent))
    .sort((a, b) => b.importance_score - a.importance_score);
}
