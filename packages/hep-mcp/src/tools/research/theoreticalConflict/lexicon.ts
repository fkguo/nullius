export type DebateAxis =
  | 'internal_structure'
  | 'mechanism'
  | 'quantum_numbers'
  | 'methodology'
  | 'systematics'
  | 'other';

const AXIS_POSITION_LEXICON = {
  internal_structure: {
    molecular: ['molecular', 'hadronic molecule', 'molecule', 'bound state of', 'd*d', 'd*0', 'd0 d*', 'threshold'],
    tetraquark: ['tetraquark', 'diquark', 'compact'],
    hybrid: ['hybrid', 'gluonic excitation', 'gluonic'],
    mixture: ['mixture', 'admixture', 'two-component', 'two component'],
  },
  methodology: {
    lattice: ['lattice', 'lqcd'],
    qcdsr: ['qcd sum rule', 'sum rules', 'ope'],
    eft: ['effective field theory', 'eft', 'hhchpt', 'chpt'],
  },
} as const;

type AxisKey = keyof typeof AXIS_POSITION_LEXICON;

export type LexiconRetrievalPriorV1 = {
  source: 'provider_local_lexicon';
  axis_hint: DebateAxis;
  position_hint: string;
  hits: string[];
  match_score: number;
};

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function collectLexiconRetrievalPrior(text: string): LexiconRetrievalPriorV1 | null {
  const lower = normalizeForMatch(text);
  if (!lower) return null;

  const matches: Array<{ axis: AxisKey; position: string; score: number }> = [];
  const hits: string[] = [];

  for (const axis of Object.keys(AXIS_POSITION_LEXICON) as AxisKey[]) {
    const positions = AXIS_POSITION_LEXICON[axis];
    for (const [position, needles] of Object.entries(positions) as Array<[string, string[]]>) {
      let score = 0;
      for (const needleRaw of needles) {
        const needle = normalizeForMatch(needleRaw);
        if (!needle) continue;
        if (lower.includes(needle)) score += 1;
      }
      if (score > 0) {
        matches.push({ axis, position, score });
        hits.push(`lexicon:${axis}:${position}`);
      }
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.score - a.score);
  const best = matches[0]!;
  return {
    source: 'provider_local_lexicon',
    axis_hint: best.axis,
    position_hint: best.position,
    hits,
    match_score: best.score,
  };
}
