import type { CanonicalPaper } from '@autoresearch/shared';

export function buildPaperRerankerPrompt(params: {
  promptVersion: string;
  query: string;
  papers: Array<CanonicalPaper & { stage1_score: number }>;
}): string {
  const lines = [
    'You are ranking canonical scholarly paper candidates for a scientific discovery query.',
    'Prioritize exact identifier matches first, then logically relevant title/author/year matches, then cross-provider agreement.',
    'Do not invent metadata. If the candidate set is too weak to confidently improve ranking, abstain.',
    '',
    'Return STRICT JSON ONLY with keys:',
    '- abstain: boolean',
    '- reason: short snake_case string',
    '- ranked: array of objects with keys canonical_key, score, reason_codes',
    '- score must be a number in [0,1]',
    '- reason_codes should be short snake_case strings',
    '',
    `prompt_version=${params.promptVersion}`,
    `query=${JSON.stringify(params.query)}`,
    '',
    'Candidates:',
  ];

  for (const paper of params.papers) {
    lines.push(JSON.stringify({
      canonical_key: paper.canonical_key,
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      identifiers: paper.identifiers,
      provider_sources: paper.provider_sources,
      merge_state: paper.merge_state,
      match_reasons: paper.match_reasons,
      stage1_score: paper.stage1_score,
    }));
  }

  return lines.join('\n');
}
