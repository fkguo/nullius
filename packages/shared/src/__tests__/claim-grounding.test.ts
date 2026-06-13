import { describe, expect, it } from 'vitest';
import {
  applyGroundingToClaims,
  assembleClaimGroundingReport,
  classifyEvidenceDomain,
  enforceSpanRule,
  groundingRiskScore,
  parseClaimGroundingReportV1,
  safeParseClaimGroundingReportV1,
  verdictToVerificationStatus,
  type ClaimGroundingEntry,
  type ClaimGroundingEntryInput,
} from '../claim-grounding.js';

const GEN = '2026-06-13T00:00:00Z';

function entryInput(overrides: Partial<ClaimGroundingEntryInput> = {}): ClaimGroundingEntryInput {
  return {
    claim_index: 0,
    claim_text: 'The branching ratio is 1.2e-3.',
    support_type: 'literature',
    evidence_uris: ['https://inspirehep.net/literature/1'],
    domain: 'hep',
    method: 'text_entailment',
    verdict: 'substantiated',
    supporting_spans: [{ evidence_uri: 'https://inspirehep.net/literature/1', quote: 'We measure BR = 1.2e-3.' }],
    ...overrides,
  };
}

describe('classifyEvidenceDomain', () => {
  it('routes INSPIRE + HEP-category sources to hep', () => {
    expect(classifyEvidenceDomain('https://inspirehep.net/literature/123')).toBe('hep');
    expect(classifyEvidenceDomain('arXiv:hep-ph/0123456')).toBe('hep');
    expect(classifyEvidenceDomain('https://arxiv.org/abs/hep-ex/9901001')).toBe('hep');
  });
  it('routes everything else to general', () => {
    expect(classifyEvidenceDomain('https://arxiv.org/abs/2401.01234')).toBe('general');
    expect(classifyEvidenceDomain('https://openalex.org/W123')).toBe('general');
    expect(classifyEvidenceDomain('https://doi.org/10.1000/xyz')).toBe('general');
  });
});

describe('verdictToVerificationStatus', () => {
  it('maps only substantiated→verified and conflicting→falsified; the rest stay unverified', () => {
    expect(verdictToVerificationStatus('substantiated')).toBe('verified');
    expect(verdictToVerificationStatus('conflicting')).toBe('falsified');
    expect(verdictToVerificationStatus('partial')).toBe('unverified');
    expect(verdictToVerificationStatus('not_substantiated')).toBe('unverified');
    expect(verdictToVerificationStatus('source_unavailable')).toBe('unverified');
  });
});

describe('enforceSpanRule', () => {
  function entry(overrides: Partial<ClaimGroundingEntry>): ClaimGroundingEntry {
    return { ...(entryInput() as ClaimGroundingEntry), verification_status: 'verified', ...overrides };
  }

  it('downgrades a span-less substantiated verdict to not_substantiated', () => {
    const out = enforceSpanRule(entry({ verdict: 'substantiated', supporting_spans: [], verification_status: 'verified' }));
    expect(out.verdict).toBe('not_substantiated');
    expect(out.verification_status).toBe('unverified');
    expect(out.notes).toContain('no verbatim supporting span');
  });

  it('downgrades a span-less partial verdict too (blank quotes do not count)', () => {
    const out = enforceSpanRule(entry({
      verdict: 'partial',
      supporting_spans: [{ evidence_uri: 'u', quote: '   ' }],
      verification_status: 'unverified',
    }));
    expect(out.verdict).toBe('not_substantiated');
  });

  it('leaves a span-backed substantiated verdict untouched', () => {
    const input = entry({ verdict: 'substantiated' });
    expect(enforceSpanRule(input)).toEqual(input);
  });

  it('does not touch verdicts that do not require a span', () => {
    const input = entry({ verdict: 'source_unavailable', supporting_spans: [], verification_status: 'unverified' });
    expect(enforceSpanRule(input).verdict).toBe('source_unavailable');
  });
});

describe('groundingRiskScore', () => {
  it('is 0 for no entries', () => {
    expect(groundingRiskScore([])).toBe(0);
  });
  it('is a weighted mean over verdicts', () => {
    // substantiated(0) + conflicting(1) → 0.5
    expect(groundingRiskScore([{ verdict: 'substantiated' }, { verdict: 'conflicting' }])).toBe(0.5);
    // not_substantiated(0.8) + source_unavailable(0.6) → 0.7
    expect(groundingRiskScore([{ verdict: 'not_substantiated' }, { verdict: 'source_unavailable' }])).toBe(0.7);
  });
});

describe('assembleClaimGroundingReport', () => {
  it('derives verification_status from verdict, ignoring any supplied value', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      source_ref: 'idea-card://x',
      entries: [entryInput({ verdict: 'substantiated', verification_status: 'falsified' })],
    });
    expect(report.claims[0]!.verification_status).toBe('verified');
    expect(report.version).toBe(1);
    expect(report.source_ref).toBe('idea-card://x');
  });

  it('enforces the span rule during assembly and reflects it in the summary', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [
        entryInput({ claim_index: 0, verdict: 'substantiated', supporting_spans: [] }), // → not_substantiated
        entryInput({ claim_index: 1, verdict: 'conflicting', supporting_spans: [] }),
      ],
    });
    expect(report.claims[0]!.verdict).toBe('not_substantiated');
    expect(report.summary.total).toBe(2);
    expect(report.summary.by_verdict.not_substantiated).toBe(1);
    expect(report.summary.by_verdict.conflicting).toBe(1);
    expect(report.summary.by_verdict.substantiated).toBe(0);
    // (0.8 + 1.0) / 2
    expect(report.summary.grounding_risk_score).toBe(0.9);
  });

  it('produces a report that round-trips through the parser', () => {
    const report = assembleClaimGroundingReport({ generated_at: GEN, entries: [entryInput()] });
    expect(() => parseClaimGroundingReportV1(report)).not.toThrow();
  });
});

describe('safeParseClaimGroundingReportV1', () => {
  function validReport() {
    return assembleClaimGroundingReport({ generated_at: GEN, entries: [entryInput()] });
  }

  it('accepts a well-formed report', () => {
    expect(safeParseClaimGroundingReportV1(validReport()).ok).toBe(true);
  });

  it('rejects an unknown verdict', () => {
    const bad = { ...validReport(), claims: [{ ...validReport().claims[0], verdict: 'maybe' }] };
    const parsed = safeParseClaimGroundingReportV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.some(i => i.path === 'claims[0].verdict')).toBe(true);
  });

  it('rejects a substantiated entry that carries no verbatim span', () => {
    const bad = { ...validReport(), claims: [{ ...validReport().claims[0], verdict: 'substantiated', supporting_spans: [] }] };
    const parsed = safeParseClaimGroundingReportV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.some(i => i.path === 'claims[0].supporting_spans')).toBe(true);
  });

  it('rejects an out-of-range grounding_risk_score', () => {
    const bad = { ...validReport(), summary: { ...validReport().summary, grounding_risk_score: 1.5 } };
    expect(safeParseClaimGroundingReportV1(bad).ok).toBe(false);
  });

  it('rejects a non-object / wrong version', () => {
    expect(safeParseClaimGroundingReportV1(null).ok).toBe(false);
    expect(safeParseClaimGroundingReportV1({ ...validReport(), version: 2 }).ok).toBe(false);
  });
});

describe('applyGroundingToClaims', () => {
  it('writes verification_status/notes by claim_index and preserves other fields', () => {
    const claims = [
      { claim_text: 'A', support_type: 'literature', evidence_uris: ['u'], confidence: 0.9 },
      { claim_text: 'B', support_type: 'data', evidence_uris: ['v'] },
    ];
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [
        entryInput({ claim_index: 0, claim_text: 'A', verdict: 'substantiated' }),
        entryInput({ claim_index: 1, claim_text: 'B', verdict: 'conflicting', supporting_spans: [{ evidence_uri: 'v', quote: 'contradicts' }] }),
      ],
    });
    const out = applyGroundingToClaims(claims, report);
    expect(out[0]!.verification_status).toBe('verified');
    expect(out[0]!.confidence).toBe(0.9); // preserved
    expect(out[1]!.verification_status).toBe('falsified');
    expect(out[1]!.verification_notes).toContain('conflicting');
  });

  it('leaves claims without a matching report entry untouched', () => {
    const claims = [{ claim_text: 'only', support_type: 'assumption', evidence_uris: [] }];
    const report = assembleClaimGroundingReport({ generated_at: GEN, entries: [] });
    expect(applyGroundingToClaims(claims, report)).toEqual(claims);
  });
});

describe('robustness against malformed span elements', () => {
  function reportWithSpans(spans: unknown): unknown {
    return {
      version: 1,
      generated_at: GEN,
      claims: [{
        claim_index: 0,
        claim_text: 'x',
        support_type: 'literature',
        evidence_uris: ['u'],
        domain: 'general',
        method: 'text_entailment',
        verdict: 'substantiated',
        supporting_spans: spans,
        verification_status: 'verified',
      }],
      summary: {
        total: 1,
        by_verdict: { substantiated: 1, partial: 0, not_substantiated: 0, conflicting: 0, source_unavailable: 0 },
        grounding_risk_score: 0,
      },
    };
  }

  // Regression: safeParse must REJECT malformed agent JSON, never throw on it.
  it('returns {ok:false} (does not throw) for a null span element', () => {
    expect(() => safeParseClaimGroundingReportV1(reportWithSpans([null]))).not.toThrow();
    expect(safeParseClaimGroundingReportV1(reportWithSpans([null])).ok).toBe(false);
  });

  it('returns {ok:false} (does not throw) for an undefined span element', () => {
    expect(() => safeParseClaimGroundingReportV1(reportWithSpans([undefined]))).not.toThrow();
    expect(safeParseClaimGroundingReportV1(reportWithSpans([undefined])).ok).toBe(false);
  });

  it('assemble throws a clean validation Error (not a raw TypeError) on a null span', () => {
    expect(() => assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({ verdict: 'substantiated', supporting_spans: [null as unknown as ClaimGroundingEntry['supporting_spans'][number]] })],
    })).toThrow(/assembled claim_grounding_report failed validation/);
  });
});

describe('summary validation', () => {
  function validReport() {
    return assembleClaimGroundingReport({ generated_at: GEN, entries: [entryInput()] });
  }
  it('rejects a by_verdict missing a verdict key', () => {
    const bad = { ...validReport(), summary: { ...validReport().summary, by_verdict: { substantiated: 1 } } };
    expect(safeParseClaimGroundingReportV1(bad).ok).toBe(false);
  });
  it('rejects a non-integer total', () => {
    const bad = { ...validReport(), summary: { ...validReport().summary, total: 1.5 } };
    expect(safeParseClaimGroundingReportV1(bad).ok).toBe(false);
  });
});
