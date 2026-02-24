export type DebateAxis =
  | 'internal_structure'
  | 'mechanism'
  | 'quantum_numbers'
  | 'methodology'
  | 'systematics'
  | 'other';

export const AXIS_POSITION_LEXICON = {
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

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function classifyAxisPosition(text: string): {
  axis: DebateAxis;
  position: string;
  hits: string[];
} {
  const lower = normalizeForMatch(text);
  if (!lower) return { axis: 'other', position: 'unknown', hits: [] };

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

  if (matches.length === 0) return { axis: 'other', position: 'unknown', hits: [] };
  matches.sort((a, b) => b.score - a.score);
  const best = matches[0]!;
  return { axis: best.axis, position: best.position, hits };
}

const MUTUAL_EXCLUSION_RULES: Record<string, Array<[string, string]>> = {
  internal_structure: [
    ['molecular', 'tetraquark'],
    ['molecular', 'hybrid'],
    ['tetraquark', 'hybrid'],
  ],
};

export function mutualExclusionRuleHits(axis: DebateAxis, positionA: string, positionB: string): string[] {
  const a = positionA.trim().toLowerCase();
  const b = positionB.trim().toLowerCase();
  if (!a || !b || a === b) return [];

  const rules = MUTUAL_EXCLUSION_RULES[axis] ?? [];
  const hits: string[] = [];
  for (const [x, y] of rules) {
    const xa = x.toLowerCase();
    const ya = y.toLowerCase();
    if ((a === xa && b === ya) || (a === ya && b === xa)) {
      hits.push(`mutual_exclusion:${axis}:${[xa, ya].sort().join('__')}`);
    }
  }
  return hits;
}
