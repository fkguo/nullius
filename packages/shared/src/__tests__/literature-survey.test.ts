import { describe, expect, it } from 'vitest';
import {
  assembleLiteratureSurvey,
  computeSurveyCoverage,
  danglingSynthesisRefs,
  parseLiteratureSurveyV1,
  safeParseLiteratureSurveyV1,
  type AssembleLiteratureSurveyInput,
  type SurveyPaper,
} from '../literature-survey.js';

const GEN = '2026-06-13T00:00:00Z';

function paper(overrides: Partial<SurveyPaper> = {}): SurveyPaper {
  return {
    ref_key: 'Smith2024',
    domain: 'hep',
    read_status: 'deep_read',
    role: 'core',
    one_line: 'Measures the branching ratio.',
    ...overrides,
  };
}

function input(overrides: Partial<AssembleLiteratureSurveyInput> = {}): AssembleLiteratureSurveyInput {
  return {
    generated_at: GEN,
    topic: 'rare decays',
    papers: [paper()],
    synthesis: { consensus: [], tensions: [], gaps: [] },
    ...overrides,
  };
}

describe('computeSurveyCoverage', () => {
  it('derives counts from papers (not trusted from caller)', () => {
    const papers = [
      paper({ ref_key: 'A', role: 'core', read_status: 'deep_read' }),
      paper({ ref_key: 'B', role: 'core', read_status: 'metadata_only' }),
      paper({ ref_key: 'C', role: 'supporting', read_status: 'deep_read' }),
      paper({ ref_key: 'D', role: 'background', read_status: 'unavailable' }),
    ];
    const cov = computeSurveyCoverage(papers, 'coverage_incomplete');
    expect(cov.total_papers).toBe(4);
    expect(cov.deep_read).toBe(2);
    expect(cov.core_total).toBe(2);
    expect(cov.core_deep_read).toBe(1);
    expect(cov.saturation).toBe('coverage_incomplete');
  });
  it('defaults saturation to unknown and empty papers to zeros', () => {
    const cov = computeSurveyCoverage([]);
    expect(cov).toMatchObject({ total_papers: 0, deep_read: 0, core_total: 0, core_deep_read: 0, saturation: 'unknown' });
  });
});

describe('assembleLiteratureSurvey', () => {
  it('recomputes coverage from papers, ignoring any caller-asserted counts', () => {
    const survey = assembleLiteratureSurvey(input({
      papers: [paper({ ref_key: 'A', read_status: 'deep_read' }), paper({ ref_key: 'B', read_status: 'metadata_only' })],
    }));
    expect(survey.coverage.total_papers).toBe(2);
    expect(survey.coverage.deep_read).toBe(1);
    expect(survey.version).toBe(1);
  });

  it('accepts synthesis that only cites papers in the survey', () => {
    const survey = assembleLiteratureSurvey(input({
      papers: [paper({ ref_key: 'A' }), paper({ ref_key: 'B' })],
      synthesis: {
        consensus: [{ statement: 'BR is ~1e-3', supporting_ref_keys: ['A', 'B'] }],
        tensions: [{ statement: 'A and B disagree on sign', ref_keys: ['A', 'B'], kind: 'measurement' }],
        gaps: ['no lattice input'],
      },
    }));
    expect(survey.synthesis.consensus[0]!.supporting_ref_keys).toEqual(['A', 'B']);
  });

  it('THROWS when synthesis cites a ref_key absent from papers (referential integrity)', () => {
    expect(() => assembleLiteratureSurvey(input({
      papers: [paper({ ref_key: 'A' })],
      synthesis: { consensus: [{ statement: 's', supporting_ref_keys: ['A', 'GHOST'] }], tensions: [], gaps: [] },
    }))).toThrow(/cites ref_keys absent from papers: GHOST/);
  });

  it('round-trips through the parser', () => {
    const survey = assembleLiteratureSurvey(input());
    expect(() => parseLiteratureSurveyV1(survey)).not.toThrow();
  });
});

describe('danglingSynthesisRefs', () => {
  it('returns the cited ref_keys not present in papers', () => {
    const survey = {
      papers: [paper({ ref_key: 'A' })],
      synthesis: {
        consensus: [{ statement: 's', supporting_ref_keys: ['A', 'X'] }],
        tensions: [{ statement: 't', ref_keys: ['Y'] }],
        gaps: [],
      },
    };
    expect(danglingSynthesisRefs(survey).sort()).toEqual(['X', 'Y']);
  });

  it('does not throw on malformed (null / non-array) synthesis elements', () => {
    const junk = {
      papers: [null, paper({ ref_key: 'A' }), { ref_key: 42 }],
      synthesis: { consensus: [null, { supporting_ref_keys: null }, { supporting_ref_keys: ['A', 'Z'] }], tensions: null },
    } as never;
    expect(() => danglingSynthesisRefs(junk)).not.toThrow();
    expect(danglingSynthesisRefs(junk)).toEqual(['Z']);
  });
});

describe('safeParseLiteratureSurveyV1', () => {
  function valid() {
    return assembleLiteratureSurvey(input({
      papers: [paper({ ref_key: 'A' })],
      synthesis: { consensus: [{ statement: 's', supporting_ref_keys: ['A'] }], tensions: [], gaps: [] },
    }));
  }

  it('accepts a well-formed survey', () => {
    expect(safeParseLiteratureSurveyV1(valid()).ok).toBe(true);
  });

  it('rejects an unknown read_status / role / domain', () => {
    const bad = { ...valid(), papers: [{ ...valid().papers[0], read_status: 'skimmed' }] };
    const parsed = safeParseLiteratureSurveyV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.some(i => i.path === 'papers[0].read_status')).toBe(true);
  });

  it('rejects a synthesis citing an absent ref_key (referential integrity at the boundary)', () => {
    const bad = { ...valid(), synthesis: { ...valid().synthesis, consensus: [{ statement: 's', supporting_ref_keys: ['NOPE'] }] } };
    const parsed = safeParseLiteratureSurveyV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.some(i => i.path === 'synthesis' && i.message.includes('NOPE'))).toBe(true);
  });

  it('does NOT throw on malformed papers/synthesis (returns {ok:false})', () => {
    const bad = { ...valid(), papers: [null], synthesis: { consensus: [null], tensions: [{ ref_keys: null }], gaps: [] } } as unknown;
    expect(() => safeParseLiteratureSurveyV1(bad)).not.toThrow();
    expect(safeParseLiteratureSurveyV1(bad).ok).toBe(false);
  });

  it('rejects a non-object / wrong version / missing topic', () => {
    expect(safeParseLiteratureSurveyV1(null).ok).toBe(false);
    expect(safeParseLiteratureSurveyV1({ ...valid(), version: 2 }).ok).toBe(false);
    expect(safeParseLiteratureSurveyV1({ ...valid(), topic: '' }).ok).toBe(false);
  });

  it('rejects a coverage block that overstates depth vs the papers (parse-boundary integrity)', () => {
    const v = valid();
    const bad = { ...v, coverage: { ...v.coverage, deep_read: 99, total_papers: 99 } };
    const parsed = safeParseLiteratureSurveyV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.some(i => i.path === 'coverage.deep_read')).toBe(true);
  });
});

describe('crash-safety of the assemble/compute path', () => {
  it('computeSurveyCoverage does not throw on malformed / non-array papers', () => {
    expect(() => computeSurveyCoverage([null as never, { ref_key: 'A' } as never])).not.toThrow();
    expect(() => computeSurveyCoverage(42 as never)).not.toThrow();
    expect(computeSurveyCoverage(42 as never).total_papers).toBe(0);
  });

  it('assembleLiteratureSurvey throws a clean validation Error (not a raw TypeError) on a null paper', () => {
    expect(() => assembleLiteratureSurvey(input({ papers: [null as unknown as SurveyPaper] }))).toThrow(/failed validation/);
  });
});
