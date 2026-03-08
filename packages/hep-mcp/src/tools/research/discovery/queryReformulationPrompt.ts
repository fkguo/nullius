export function buildQueryReformulationPrompt(params: {
  promptVersion: string;
  query: string;
  difficulty: string;
  ambiguity: string;
  lowRecallRisk: string;
  reasonCodes: string[];
}): string {
  return [
    'You are reformulating a scholarly known-item or scientific retrieval query.',
    'Rewrite only when the original query appears ambiguous, underspecified, acronym-heavy, or recall-starved.',
    'Preserve the original intent. Do not invent identifiers, authors, venues, or claims not grounded in the input query.',
    'Prefer expanding acronyms, clarifying author/year/title fragments, and removing vague filler.',
    'If the query should stay unchanged, abstain.',
    '',
    'Return STRICT JSON ONLY with keys:',
    '- abstain: boolean',
    '- reason: short snake_case string',
    '- reformulated_query: string (required only when abstain=false)',
    '',
    `prompt_version=${params.promptVersion}`,
    `difficulty=${params.difficulty}`,
    `ambiguity=${params.ambiguity}`,
    `low_recall_risk=${params.lowRecallRisk}`,
    `reason_codes=${JSON.stringify(params.reasonCodes)}`,
    `query=${JSON.stringify(params.query)}`,
  ].join('\n');
}
