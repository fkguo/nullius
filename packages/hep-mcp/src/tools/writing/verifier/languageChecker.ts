/**
 * Language Checker - Ensures consistent language across sections
 *
 * Phase 2 Writing Quality Fix: Detects language mixing and ensures
 * all sections use a consistent language (English or Chinese).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DetectedLanguage = 'en' | 'zh' | 'mixed';

export interface LanguageCheckResult {
  /** Whether all sections use consistent language */
  is_consistent: boolean;
  /** The dominant language across all sections */
  dominant_language: 'en' | 'zh';
  /** Per-section language detection results */
  sections_by_language: Array<{
    section_number: string;
    detected_language: DetectedLanguage;
    cjk_ratio: number;
  }>;
  /** Issues found (inconsistent sections) */
  issues: string[];
  /** Suggestions for fixing inconsistencies */
  suggestions: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Language Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect the primary language of a text based on character distribution.
 * Uses CJK character ratio to determine if text is Chinese, English, or mixed.
 */
export function detectLanguage(text: string): DetectedLanguage {
  if (!text || text.trim().length === 0) {
    return 'en';  // Default to English for empty text
  }

  // Count CJK characters (Chinese, Japanese, Korean - but primarily Chinese in HEP context)
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  // Count Latin characters
  const latinChars = (text.match(/[a-zA-Z]/g) || []).length;

  const total = cjkChars + latinChars;
  if (total === 0) {
    return 'en';  // No alphabetic content, default to English
  }

  const cjkRatio = cjkChars / total;

  // Thresholds for language detection
  if (cjkRatio > 0.3) {
    return 'zh';  // Primarily Chinese
  }
  if (cjkRatio > 0.1) {
    return 'mixed';  // Significant mixing
  }
  return 'en';  // Primarily English
}

/**
 * Calculate the CJK character ratio in text.
 */
export function calculateCjkRatio(text: string): number {
  if (!text || text.trim().length === 0) {
    return 0;
  }

  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
  const total = cjkChars + latinChars;

  if (total === 0) {
    return 0;
  }

  return cjkChars / total;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check language consistency across multiple sections.
 *
 * @param sections - Array of sections with number and content
 * @returns Language check result with consistency status and issues
 */
export function checkLanguageConsistency(
  sections: Array<{ number: string; content: string }>
): LanguageCheckResult {
  if (sections.length === 0) {
    return {
      is_consistent: true,
      dominant_language: 'en',
      sections_by_language: [],
      issues: [],
      suggestions: [],
    };
  }

  // Detect language for each section
  const detections = sections.map(s => ({
    section_number: s.number,
    detected_language: detectLanguage(s.content),
    cjk_ratio: calculateCjkRatio(s.content),
  }));

  // Count languages (excluding mixed)
  const enCount = detections.filter(d => d.detected_language === 'en').length;
  const zhCount = detections.filter(d => d.detected_language === 'zh').length;
  const mixedCount = detections.filter(d => d.detected_language === 'mixed').length;

  // Determine dominant language
  const dominant: 'en' | 'zh' = enCount >= zhCount ? 'en' : 'zh';

  // Find inconsistent sections
  const inconsistent = detections.filter(
    d => d.detected_language !== dominant && d.detected_language !== 'mixed'
  );

  // Build issues and suggestions
  const issues: string[] = [];
  const suggestions: string[] = [];

  for (const d of inconsistent) {
    issues.push(
      `Section ${d.section_number} uses ${d.detected_language === 'zh' ? 'Chinese' : 'English'}, ` +
      `expected ${dominant === 'zh' ? 'Chinese' : 'English'}`
    );
  }

  if (mixedCount > 0) {
    const mixedSections = detections
      .filter(d => d.detected_language === 'mixed')
      .map(d => d.section_number);
    issues.push(`Sections ${mixedSections.join(', ')} contain mixed language content`);
  }

  if (issues.length > 0) {
    suggestions.push(
      `Rewrite inconsistent sections in ${dominant === 'zh' ? 'Chinese' : 'English'} ` +
      `to maintain language consistency throughout the document.`
    );
  }

  return {
    is_consistent: inconsistent.length === 0 && mixedCount === 0,
    dominant_language: dominant,
    sections_by_language: detections,
    issues,
    suggestions,
  };
}
