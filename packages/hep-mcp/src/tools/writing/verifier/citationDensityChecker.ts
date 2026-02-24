/**
 * Citation Density Checker
 *
 * Detects excessive repetition of the same citation within a paragraph.
 * Academic writing convention: same paper should not be cited 3+ times per paragraph.
 */

import type { CitationIssue } from './types.js';

/** Threshold for citation repetition warning */
const MAX_SAME_CITE_PER_PARAGRAPH = 2;

/**
 * Check citation density in content
 * Returns issues for paragraphs with excessive citation repetition
 */
export function checkCitationDensity(content: string): CitationIssue[] {
  const issues: CitationIssue[] = [];
  const paragraphs = content.split(/\n\n+/);

  paragraphs.forEach((para, idx) => {
    const citeCounts = countCitationsInParagraph(para);

    for (const [key, count] of citeCounts) {
      if (count > MAX_SAME_CITE_PER_PARAGRAPH) {
        issues.push({
          type: 'citation_density',
          severity: 'warning',
          citation: key,
          count,
          paragraph_index: idx,
          message: `Citation "${key}" appears ${count} times in paragraph ${idx + 1}. ` +
                   `Consider grouping: "A, B, and C~\\\\cite{${key}}" instead of citing each sentence.`,
        });
      }
    }
  });

  return issues;
}

/**
 * Count occurrences of each citation key in a paragraph
 */
function countCitationsInParagraph(paragraph: string): Map<string, number> {
  const citeCounts = new Map<string, number>();

  // Match \cite{key} and \cite{key1,key2,...}
  const citeMatches = paragraph.matchAll(/\\cite[a-zA-Z*]*\{([^}]+)\}/g);

  for (const match of citeMatches) {
    // Handle multiple keys in single \cite{a,b,c}
    const keys = match[1].split(',').map(k => k.trim());
    for (const key of keys) {
      citeCounts.set(key, (citeCounts.get(key) || 0) + 1);
    }
  }

  return citeCounts;
}

