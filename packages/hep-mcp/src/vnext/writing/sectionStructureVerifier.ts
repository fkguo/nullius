export type DeterministicStructureCheck = {
  pass: boolean;
  feedback: string[];
  diagnostics: {
    paragraphs_total: number;
    single_sentence_paragraphs: number;
    unclosed_environments: string[];
  };
};

function splitParagraphs(content: string): string[] {
  return String(content ?? '')
    .split(/\n\s*\n/g)
    .map(p => p.trim())
    .filter(Boolean);
}

function countSentences(text: string): number {
  const s = String(text ?? '').trim();
  if (!s) return 0;
  const parts = s.split(/[.!?。！？]+/).map(x => x.trim()).filter(Boolean);
  return Math.max(1, parts.length);
}

function scanLatexEnvironments(content: string): { unclosed: string[] } {
  const tokens = Array.from(String(content ?? '').matchAll(/\\(begin|end)\{([^}]+)\}/g)).map(m => ({
    kind: m[1] as 'begin' | 'end',
    name: String(m[2] ?? '').trim(),
  }));

  const stack: string[] = [];
  const unclosed: string[] = [];

  for (const t of tokens) {
    if (!t.name) continue;
    if (t.kind === 'begin') {
      stack.push(t.name);
      continue;
    }
    if (stack.length === 0) {
      unclosed.push(t.name);
      continue;
    }

    const idx = stack.lastIndexOf(t.name);
    if (idx === -1) {
      unclosed.push(t.name);
      continue;
    }

    // Close mismatched nesting by marking intermediate environments as unclosed.
    while (stack.length - 1 > idx) {
      const popped = stack.pop();
      if (popped) unclosed.push(popped);
    }
    stack.pop();
  }

  unclosed.push(...stack.reverse());
  return { unclosed: Array.from(new Set(unclosed)).filter(Boolean) };
}

export function verifyDeterministicSectionStructure(params: {
  content: string;
  min_paragraphs: number;
  max_single_sentence_paragraphs: number;
  require_no_unclosed_environments: boolean;
}): DeterministicStructureCheck {
  const paragraphs = splitParagraphs(params.content);
  const singleSentence = paragraphs.filter(p => countSentences(p) <= 1).length;

  const env = scanLatexEnvironments(params.content);
  const feedback: string[] = [];

  if (paragraphs.length < params.min_paragraphs) {
    feedback.push(`Structure: too few paragraphs (${paragraphs.length}); require at least ${params.min_paragraphs}. Split into coherent paragraphs.`);
  }

  if (singleSentence > params.max_single_sentence_paragraphs) {
    feedback.push(
      `Structure: too many single-sentence paragraphs (${singleSentence}); require at most ${params.max_single_sentence_paragraphs}. Merge/smooth transitions.`
    );
  }

  if (params.require_no_unclosed_environments && env.unclosed.length > 0) {
    feedback.push(`LaTeX: unclosed or mismatched environments detected: ${env.unclosed.join(', ')}. Fix \\begin{...}/\\end{...} pairs.`);
  }

  return {
    pass: feedback.length === 0,
    feedback,
    diagnostics: {
      paragraphs_total: paragraphs.length,
      single_sentence_paragraphs: singleSentence,
      unclosed_environments: env.unclosed,
    },
  };
}
