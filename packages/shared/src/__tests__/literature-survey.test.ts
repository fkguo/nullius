import { describe, expect, it } from 'vitest';
import {
  assembleLiteratureSurvey,
  assessSaturationEvidence,
  computeSurveyCoverage,
  danglingSynthesisRefs,
  enforceSaturationRule,
  parseLiteratureSurveyV1,
  safeParseLiteratureSurveyV1,
  type AssembleLiteratureSurveyInput,
  type LiteratureSurveyCoverage,
  type SaturationExpansionRound,
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

/** Rounds whose terminal entry converged (screened > 0, zero new core papers). */
function convergedRounds(): SaturationExpansionRound[] {
  return [
    { round: 1, expansion_candidates_screened: 40, new_core_papers: 2 },
    { round: 2, expansion_candidates_screened: 25, new_core_papers: 0 },
  ];
}

describe('computeSurveyCoverage', () => {
  it('derives counts from papers (not trusted from caller)', () => {
    const papers = [
      paper({ ref_key: 'A', role: 'core', read_status: 'deep_read' }),
      paper({ ref_key: 'B', role: 'core', read_status: 'metadata_only' }),
      paper({ ref_key: 'C', role: 'supporting', read_status: 'deep_read' }),
      paper({ ref_key: 'D', role: 'background', read_status: 'unavailable' }),
    ];
    const cov = computeSurveyCoverage(papers, { saturation: 'coverage_incomplete' });
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
  it('keeps a saturated status that the recorded rounds support, carrying the evidence', () => {
    const cov = computeSurveyCoverage(
      [paper({ ref_key: 'A' }), paper({ ref_key: 'B' })],
      { saturation: 'saturated', saturation_evidence: convergedRounds() },
    );
    expect(cov.saturation).toBe('saturated');
    expect(cov.saturation_evidence).toEqual(convergedRounds());
    expect(cov.notes).toBeUndefined();
  });
  it('downgrades an evidence-free saturated on the compute path too (no bypass)', () => {
    const cov = computeSurveyCoverage([paper()], { saturation: 'saturated' });
    expect(cov.saturation).toBe('coverage_incomplete');
    expect(cov.notes).toMatch(/downgraded to coverage_incomplete/);
  });
  it('downgrades a saturated whose converged rounds admit more core papers than the survey derives (standalone call, no parser in the loop)', () => {
    // One core paper, but convergedRounds() claims two admissions: the compute
    // path itself must refuse the saturated claim, not defer to the parser.
    const cov = computeSurveyCoverage([paper()], { saturation: 'saturated', saturation_evidence: convergedRounds() });
    expect(cov.core_total).toBe(1);
    expect(cov.saturation).toBe('coverage_incomplete');
    expect(cov.notes).toMatch(/rounds admit 2 core papers in total but the survey carries only 1/);
  });
});

describe('assessSaturationEvidence (the mechanical saturation rule)', () => {
  it('supports saturation when the terminal round screened candidates and found no new core papers', () => {
    expect(assessSaturationEvidence(convergedRounds())).toEqual({ supported: true });
  });

  it('supports a single converged round (K = 1)', () => {
    expect(assessSaturationEvidence([
      { round: 1, expansion_candidates_screened: 12, new_core_papers: 0 },
    ])).toEqual({ supported: true });
  });

  it('rejects missing or empty evidence (saturation must be measured, not asserted)', () => {
    for (const evidence of [undefined, []]) {
      const res = assessSaturationEvidence(evidence);
      expect(res.supported).toBe(false);
      if (!res.supported) expect(res.reason).toMatch(/no expansion-round evidence recorded/);
    }
  });

  it('rejects when the last round still yielded new core papers (not converged)', () => {
    const res = assessSaturationEvidence([
      { round: 1, expansion_candidates_screened: 40, new_core_papers: 0 },
      { round: 2, expansion_candidates_screened: 30, new_core_papers: 1 },
    ]);
    expect(res.supported).toBe(false);
    if (!res.supported) expect(res.reason).toMatch(/round 2.*1 new core paper.*has not converged/);
  });

  it('rejects a zero-work terminal round (screened nothing proves nothing)', () => {
    const res = assessSaturationEvidence([
      { round: 1, expansion_candidates_screened: 40, new_core_papers: 2 },
      { round: 2, expansion_candidates_screened: 0, new_core_papers: 0 },
    ]);
    expect(res.supported).toBe(false);
    if (!res.supported) expect(res.reason).toMatch(/screened zero candidates/);
  });

  it('applies the admissions-vs-core reconciliation only when coreTotal context is supplied', () => {
    // convergedRounds() admits 2 in total.
    expect(assessSaturationEvidence(convergedRounds(), 2)).toEqual({ supported: true });
    expect(assessSaturationEvidence(convergedRounds(), 3)).toEqual({ supported: true });
    const res = assessSaturationEvidence(convergedRounds(), 1);
    expect(res.supported).toBe(false);
    if (!res.supported) expect(res.reason).toMatch(/rounds admit 2 core papers in total but the survey carries only 1/);
    // Without context the rounds-only checks still pass: the caller owns supplying core_total.
    expect(assessSaturationEvidence(convergedRounds())).toEqual({ supported: true });
  });

  it('rejects malformed evidence: non-array, non-object rounds, negatives, floats, gaps, new > screened', () => {
    const malformed: unknown[] = [
      null,
      'two rounds, honest',
      [null],
      [{ round: 1, expansion_candidates_screened: -1, new_core_papers: 0 }],
      [{ round: 1, expansion_candidates_screened: 10.5, new_core_papers: 0 }],
      [{ round: 2, expansion_candidates_screened: 10, new_core_papers: 0 }], // must start at 1
      [
        { round: 1, expansion_candidates_screened: 10, new_core_papers: 1 },
        { round: 3, expansion_candidates_screened: 10, new_core_papers: 0 }, // gap
      ],
      [{ round: 1, expansion_candidates_screened: 2, new_core_papers: 5 }], // new > screened
    ];
    for (const evidence of malformed) {
      const res = assessSaturationEvidence(evidence);
      expect(res.supported).toBe(false);
      if (!res.supported) expect(res.reason).toMatch(/malformed/);
    }
  });
});

describe('enforceSaturationRule', () => {
  // core_total = 2 matches convergedRounds()' total admissions, so the supported
  // case is self-consistent by construction.
  function coverage(overrides: Partial<LiteratureSurveyCoverage> = {}): LiteratureSurveyCoverage {
    return { total_papers: 2, deep_read: 2, core_total: 2, core_deep_read: 2, saturation: 'saturated', ...overrides };
  }

  it('downgrades an unsupported saturated to coverage_incomplete with a visible reason', () => {
    const out = enforceSaturationRule(coverage());
    expect(out.saturation).toBe('coverage_incomplete');
    expect(out.notes).toMatch(/downgraded to coverage_incomplete: no expansion-round evidence recorded/);
  });

  it('appends the downgrade reason after existing notes instead of overwriting them', () => {
    const out = enforceSaturationRule(coverage({ notes: 'searched three providers' }));
    expect(out.notes).toMatch(/^searched three providers; downgraded to coverage_incomplete/);
  });

  it('keeps a supported saturated untouched', () => {
    const cov = coverage({ saturation_evidence: convergedRounds() });
    expect(enforceSaturationRule(cov)).toEqual(cov);
  });

  it('downgrades converged rounds whose admissions exceed the coverage core_total (inconsistent evidence)', () => {
    const out = enforceSaturationRule(coverage({ core_total: 1, core_deep_read: 1, saturation_evidence: convergedRounds() }));
    expect(out.saturation).toBe('coverage_incomplete');
    expect(out.notes).toMatch(/rounds admit 2 core papers in total but the survey carries only 1/);
  });

  it('downgrades structurally malformed evidence with a malformed reason (direct-call path)', () => {
    const out = enforceSaturationRule(coverage({
      saturation_evidence: [{ round: 1, expansion_candidates_screened: -1, new_core_papers: 0 }],
    }));
    expect(out.saturation).toBe('coverage_incomplete');
    expect(out.notes).toMatch(/downgraded to coverage_incomplete: expansion-round evidence is malformed/);
  });

  it('leaves non-saturated statuses alone (no evidence demanded for honest debt)', () => {
    for (const saturation of ['coverage_incomplete', 'unknown'] as const) {
      const cov = coverage({ saturation });
      expect(enforceSaturationRule(cov)).toEqual(cov);
    }
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

  it('keeps saturated when the expansion rounds support it, and round-trips', () => {
    const survey = assembleLiteratureSurvey(input({
      papers: [paper({ ref_key: 'A' }), paper({ ref_key: 'B' })],
      saturation: 'saturated',
      saturation_evidence: convergedRounds(),
    }));
    expect(survey.coverage.saturation).toBe('saturated');
    expect(survey.coverage.saturation_evidence).toEqual(convergedRounds());
    expect(() => parseLiteratureSurveyV1(survey)).not.toThrow();
  });

  it('DOWNGRADES saturated-without-evidence to coverage_incomplete, visibly, and the result still parses', () => {
    const survey = assembleLiteratureSurvey(input({ saturation: 'saturated' }));
    expect(survey.coverage.saturation).toBe('coverage_incomplete');
    expect(survey.coverage.notes).toMatch(/downgraded to coverage_incomplete: no expansion-round evidence recorded/);
    // Dual-side consistency: what assemble emits, the parse boundary accepts.
    expect(safeParseLiteratureSurveyV1(survey).ok).toBe(true);
  });

  it('DOWNGRADES saturated whose last round still yielded new core papers, appending to existing notes', () => {
    const survey = assembleLiteratureSurvey(input({
      papers: [paper({ ref_key: 'A' }), paper({ ref_key: 'B' })],
      saturation: 'saturated',
      saturation_evidence: [
        { round: 1, expansion_candidates_screened: 30, new_core_papers: 0 },
        { round: 2, expansion_candidates_screened: 20, new_core_papers: 1 },
      ],
      coverage_notes: 'three providers searched',
    }));
    expect(survey.coverage.saturation).toBe('coverage_incomplete');
    expect(survey.coverage.notes).toMatch(/^three providers searched; downgraded to coverage_incomplete: .*has not converged/);
    expect(safeParseLiteratureSurveyV1(survey).ok).toBe(true);
  });

  it('DOWNGRADES saturated whose last round screened zero candidates (zero-work round)', () => {
    const survey = assembleLiteratureSurvey(input({
      saturation: 'saturated',
      saturation_evidence: [{ round: 1, expansion_candidates_screened: 0, new_core_papers: 0 }],
    }));
    expect(survey.coverage.saturation).toBe('coverage_incomplete');
    expect(survey.coverage.notes).toMatch(/screened zero candidates/);
  });

  it('THROWS on structurally malformed saturation_evidence (data corruption, not a claim to downgrade)', () => {
    expect(() => assembleLiteratureSurvey(input({
      saturation: 'saturated',
      saturation_evidence: [{ round: 1, expansion_candidates_screened: -5, new_core_papers: 0 }],
    }))).toThrow(/failed validation/);
  });

  it('THROWS when the rounds admit more core papers than the survey contains', () => {
    // One core paper in the survey, but the rounds claim three admissions.
    expect(() => assembleLiteratureSurvey(input({
      papers: [paper({ ref_key: 'A' })],
      saturation_evidence: [
        { round: 1, expansion_candidates_screened: 10, new_core_papers: 3 },
        { round: 2, expansion_candidates_screened: 5, new_core_papers: 0 },
      ],
    }))).toThrow(/exceeding core_total/);
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

  it('REJECTS a hand-authored saturated without supporting evidence (fail-closed at the boundary)', () => {
    const v = valid();
    const bad = { ...v, coverage: { ...v.coverage, saturation: 'saturated' } };
    const parsed = safeParseLiteratureSurveyV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const hit = parsed.issues.find(i => i.path === 'coverage.saturation');
      expect(hit?.message).toMatch(/unsupported by saturation_evidence.*no expansion-round evidence recorded/);
    }
  });

  it('REJECTS a hand-authored saturated whose last round still yielded new core papers', () => {
    const v = valid();
    const bad = {
      ...v,
      coverage: {
        ...v.coverage,
        saturation: 'saturated',
        saturation_evidence: [{ round: 1, expansion_candidates_screened: 10, new_core_papers: 1 }],
      },
    };
    const parsed = safeParseLiteratureSurveyV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.some(i => i.path === 'coverage.saturation' && /has not converged/.test(i.message))).toBe(true);
  });

  it('accepts a hand-authored saturated whose rounds support it', () => {
    const v = assembleLiteratureSurvey(input({
      papers: [paper({ ref_key: 'A' })],
      synthesis: { consensus: [{ statement: 's', supporting_ref_keys: ['A'] }], tensions: [], gaps: [] },
      saturation: 'saturated',
      saturation_evidence: [{ round: 1, expansion_candidates_screened: 15, new_core_papers: 0 }],
    }));
    expect(v.coverage.saturation).toBe('saturated');
    expect(safeParseLiteratureSurveyV1(JSON.parse(JSON.stringify(v))).ok).toBe(true);
  });

  it('accepts an honest coverage_incomplete carrying non-converged rounds as declared debt', () => {
    const v = valid();
    const ok = {
      ...v,
      coverage: {
        ...v.coverage,
        saturation: 'coverage_incomplete',
        saturation_evidence: [{ round: 1, expansion_candidates_screened: 10, new_core_papers: 1 }],
      },
    };
    expect(safeParseLiteratureSurveyV1(ok).ok).toBe(true);
  });

  it('accepts an empty rounds array under a non-saturated status, but rejects it under saturated', () => {
    const v = valid();
    const incomplete = { ...v, coverage: { ...v.coverage, saturation: 'unknown', saturation_evidence: [] } };
    expect(safeParseLiteratureSurveyV1(incomplete).ok).toBe(true);
    const saturated = { ...v, coverage: { ...v.coverage, saturation: 'saturated', saturation_evidence: [] } };
    expect(safeParseLiteratureSurveyV1(saturated).ok).toBe(false);
  });

  it('rejects structurally malformed rounds with per-field issue paths (and does not throw)', () => {
    const v = valid();
    const bad = {
      ...v,
      coverage: {
        ...v.coverage,
        saturation_evidence: [
          { round: 1, expansion_candidates_screened: -2, new_core_papers: 0.5 },
          null,
          { round: 7, expansion_candidates_screened: 1, new_core_papers: 3 },
        ],
      },
    };
    expect(() => safeParseLiteratureSurveyV1(bad)).not.toThrow();
    const parsed = safeParseLiteratureSurveyV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const paths = parsed.issues.map(i => i.path);
      expect(paths).toContain('coverage.saturation_evidence[0].expansion_candidates_screened');
      expect(paths).toContain('coverage.saturation_evidence[0].new_core_papers');
      expect(paths).toContain('coverage.saturation_evidence[1]');
      expect(paths).toContain('coverage.saturation_evidence[2].round');
      expect(paths).toContain('coverage.saturation_evidence[2].new_core_papers');
    }
  });

  it('REJECTS saturated combined with structurally malformed rounds (both issue families fire)', () => {
    const v = valid();
    const bad = {
      ...v,
      coverage: {
        ...v.coverage,
        saturation: 'saturated',
        saturation_evidence: [{ round: 1, expansion_candidates_screened: -1, new_core_papers: 0 }],
      },
    };
    const parsed = safeParseLiteratureSurveyV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some(i => i.path === 'coverage.saturation_evidence[0].expansion_candidates_screened')).toBe(true);
      expect(parsed.issues.some(i => i.path === 'coverage.saturation' && /malformed/.test(i.message))).toBe(true);
    }
  });

  it('rejects a non-array saturation_evidence (and does not throw)', () => {
    const v = valid();
    const bad = { ...v, coverage: { ...v.coverage, saturation_evidence: 'looks measured' } };
    expect(() => safeParseLiteratureSurveyV1(bad)).not.toThrow();
    const parsed = safeParseLiteratureSurveyV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.some(i => i.path === 'coverage.saturation_evidence')).toBe(true);
  });

  it('rejects rounds whose total admissions exceed core_total (fabrication upper bound)', () => {
    const v = valid(); // exactly one core paper
    const bad = {
      ...v,
      coverage: {
        ...v.coverage,
        saturation_evidence: [
          { round: 1, expansion_candidates_screened: 10, new_core_papers: 2 },
          { round: 2, expansion_candidates_screened: 5, new_core_papers: 0 },
        ],
      },
    };
    const parsed = safeParseLiteratureSurveyV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.some(i => i.path === 'coverage.saturation_evidence' && /exceeding core_total/.test(i.message))).toBe(true);
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
