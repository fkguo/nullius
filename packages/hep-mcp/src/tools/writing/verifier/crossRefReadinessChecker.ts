export interface CrossRefReadinessResult {
  pass: boolean;
  expected_definitions: string[];
  actual_definitions: string[];
  missing_definitions: string[];
  feedback: string[];
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Verify that the section defines the expected concepts/terms (Phase 0 cross-ref hints).
 *
 * Current implementation is heuristic: it checks the presence of the concept strings
 * in the section content. This is intentionally deterministic and cheap.
 */
export function verifyCrossRefReadiness(
  sectionOutput: { content?: string },
  crossRefHints: { this_section_defines: string[] }
): CrossRefReadinessResult {
  const content = typeof sectionOutput?.content === 'string' ? sectionOutput.content : '';
  const expected = Array.isArray(crossRefHints?.this_section_defines)
    ? crossRefHints.this_section_defines.map(String).map(s => s.trim()).filter(Boolean)
    : [];

  if (expected.length === 0) {
    return {
      pass: true,
      expected_definitions: [],
      actual_definitions: [],
      missing_definitions: [],
      feedback: [],
    };
  }

  const contentNorm = normalize(content);
  const actual: string[] = [];
  const missing: string[] = [];

  for (const term of expected) {
    const termNorm = normalize(term);
    if (termNorm && contentNorm.includes(termNorm)) actual.push(term);
    else missing.push(term);
  }

  const feedback = missing.map(t => `Missing expected definition: "${t}". Define it explicitly before later sections reference it.`);

  return {
    pass: missing.length === 0,
    expected_definitions: expected,
    actual_definitions: actual,
    missing_definitions: missing,
    feedback,
  };
}

