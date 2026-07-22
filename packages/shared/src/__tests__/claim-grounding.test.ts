import { describe, expect, it } from 'vitest';
import {
  applyGroundingToClaims,
  assembleClaimGroundingReport,
  classifyEvidenceDomain,
  enforceCitationIdentityRule,
  enforceNumericMatchRule,
  enforceSpanRule,
  groundingRiskScore,
  parseClaimGroundingReportV1,
  safeParseClaimGroundingReportV1,
  verdictToVerificationStatus,
  type ClaimGroundingEntry,
  type ClaimGroundingEntryInput,
  type ClaimNumericComparisonInputRecord,
} from '../claim-grounding.js';
import {
  evaluateCitationIdentity,
  type CitationIdentityInput,
} from '../citation-identity.js';
import type { NumericClaimComparisonInput } from '../numeric-claim-match.js';

const GEN = '2026-06-13T00:00:00Z';
const METADATA_SHA = `sha256:${'ab'.repeat(32)}`;
const EVIDENCE_URI = 'https://records.example/works/record-1';

function citationIdentity(overrides: Partial<CitationIdentityInput> = {}): CitationIdentityInput {
  return {
    evidence_uri: EVIDENCE_URI,
    displayed: {
      title: 'A recorded evaluation',
      authors: ['A. Author', 'B. Researcher'],
      identifier: 'work:record-1',
      url: EVIDENCE_URI,
    },
    canonical: {
      title: 'A recorded evaluation',
      authors: ['Alice Author', 'Boris Researcher'],
      identifier: 'work:record-1',
      url: EVIDENCE_URI,
      provenance: {
        kind: 'archived_canonical_metadata',
        provider: 'canonical-registry',
        record_ref: `project://evidence/citation-1.json#${METADATA_SHA}`,
        record_sha256: METADATA_SHA,
      },
    },
    ...overrides,
  };
}

function entryInput(overrides: Partial<ClaimGroundingEntryInput> = {}): ClaimGroundingEntryInput {
  return {
    claim_index: 0,
    claim_text: 'The source reports the stated outcome.',
    support_type: 'literature',
    evidence_uris: [EVIDENCE_URI],
    domain: 'general',
    method: 'text_entailment',
    verdict: 'substantiated',
    supporting_spans: [{ evidence_uri: EVIDENCE_URI, quote: 'The evaluation reports the stated outcome.' }],
    citation_identities: [citationIdentity()],
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

describe('citation identity is a prerequisite to positive grounding', () => {
  it('accepts hash-bound archived canonical metadata without a network dependency', () => {
    const report = assembleClaimGroundingReport({ generated_at: GEN, entries: [entryInput()] });
    expect(report.claims[0]!.verdict).toBe('substantiated');
    expect(report.claims[0]!.citation_identities[0]!.verdict).toBe('matched');
    expect(report.claims[0]!.citation_identities[0]!.input.canonical!.provenance.kind)
      .toBe('archived_canonical_metadata');
  });

  it('hard-fails a swapped displayed title even when a full-text span supports the prose claim', () => {
    const swapped = citationIdentity({
      displayed: {
        title: 'A different work',
        authors: ['A. Author', 'B. Researcher'],
        identifier: 'work:record-1',
        url: EVIDENCE_URI,
      },
    });
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({ citation_identities: [swapped] })],
    });
    const entry = report.claims[0]!;
    expect(entry.supporting_spans).toHaveLength(1);
    expect(entry.citation_identities[0]!.verdict).toBe('mismatch');
    expect(entry.citation_identities[0]!.diagnostics.map(item => item.code)).toContain('title_mismatch');
    expect(entry.verdict).toBe('not_substantiated');
    expect(entry.verification_status).toBe('unverified');
    expect(entry.notes).toContain('citation identity mismatch');
    expect(entry.notes).toContain('title_mismatch');
  });

  it('binds displayed authors when present and rejects a swapped author list', () => {
    const swapped = citationIdentity({
      displayed: {
        title: 'A recorded evaluation',
        authors: ['C. Different', 'B. Researcher'],
        identifier: 'work:record-1',
        url: EVIDENCE_URI,
      },
    });
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({ citation_identities: [swapped] })],
    });
    expect(report.claims[0]!.citation_identities[0]!.diagnostics.map(item => item.code))
      .toContain('authors_mismatch');
    expect(report.claims[0]!.verdict).toBe('not_substantiated');
  });

  it('rejects a canonical identifier mismatch independently of title and full text', () => {
    const swapped = citationIdentity({
      displayed: {
        title: 'A recorded evaluation',
        authors: ['A. Author', 'B. Researcher'],
        identifier: 'work:record-2',
        url: EVIDENCE_URI,
      },
    });
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({ citation_identities: [swapped] })],
    });
    expect(report.claims[0]!.citation_identities[0]!.diagnostics.map(item => item.code))
      .toContain('displayed_identifier_mismatch');
    expect(report.claims[0]!.verdict).toBe('not_substantiated');
  });

  it('rejects a displayed URL that points outside the canonical locator set', () => {
    const swapped = citationIdentity({
      displayed: {
        title: 'A recorded evaluation',
        authors: ['A. Author', 'B. Researcher'],
        identifier: 'work:record-1',
        url: 'https://records.example/works/record-9',
      },
    });
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({ citation_identities: [swapped] })],
    });
    expect(report.claims[0]!.citation_identities[0]!.diagnostics.map(item => item.code))
      .toContain('displayed_url_mismatch');
    expect(report.claims[0]!.verdict).toBe('not_substantiated');
  });

  it('rejects an evidence URI that points outside the canonical locator set', () => {
    const foreignEvidenceUri = 'https://records.example/works/record-9';
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({
        evidence_uris: [foreignEvidenceUri],
        supporting_spans: [{
          evidence_uri: foreignEvidenceUri,
          quote: 'The foreign source contains a similar statement.',
        }],
        citation_identities: [citationIdentity({ evidence_uri: foreignEvidenceUri })],
      })],
    });
    expect(report.claims[0]!.citation_identities[0]!.diagnostics.map(item => item.code))
      .toContain('evidence_uri_mismatch');
    expect(report.claims[0]!.verdict).toBe('not_substantiated');
  });

  it('fails closed as source_unavailable when neither archived nor retrieved metadata exists', () => {
    const unavailable = citationIdentity({
      canonical: undefined,
      unavailable_reason: 'authoritative metadata retrieval did not return a record',
    });
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({ citation_identities: [unavailable] })],
    });
    expect(report.claims[0]!.citation_identities[0]!.verdict).toBe('metadata_unavailable');
    expect(report.claims[0]!.verdict).toBe('source_unavailable');
    expect(report.claims[0]!.notes).toContain('canonical citation metadata unavailable');
  });

  it('fails closed when a positive entry omits the identity check entirely', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({ citation_identities: [] })],
    });
    expect(report.claims[0]!.verdict).toBe('source_unavailable');
    expect(report.claims[0]!.verification_status).toBe('unverified');
  });

  it('detects one canonical identifier reused under two displayed titles', () => {
    const uri = 'https://records.example/works/record-2';
    const canonical = {
      title: 'Canonical methods for structured inference',
      authors: ['Ada Example'],
      identifier: 'work:record-2',
      url: uri,
      provenance: {
        kind: 'citation_triangulation' as const,
        provider: 'citation-triangulation',
        record_ref: `project://evidence/citation-triangulation.json#${METADATA_SHA}`,
        record_sha256: METADATA_SHA,
      },
    };
    const binding = (displayedTitle: string): CitationIdentityInput => ({
      evidence_uri: uri,
      displayed: {
        title: displayedTitle,
        authors: ['A. Example'],
        identifier: 'work:record-2',
        url: uri,
      },
      canonical,
    });
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [
        entryInput({
          claim_index: 0,
          evidence_uris: [uri],
          domain: 'general',
          supporting_spans: [{ evidence_uri: uri, quote: 'A source-backed statement.' }],
          citation_identities: [binding(canonical.title)],
        }),
        entryInput({
          claim_index: 1,
          evidence_uris: [uri],
          domain: 'general',
          supporting_spans: [{ evidence_uri: uri, quote: 'Another source-backed statement.' }],
          citation_identities: [binding('A swapped title from another work')],
        }),
      ],
    });
    expect(report.claims[0]!.verdict).toBe('substantiated');
    expect(report.claims[1]!.citation_identities[0]!.diagnostics.map(item => item.code))
      .toContain('title_mismatch');
    expect(report.claims[1]!.verdict).toBe('not_substantiated');
  });

  it('rejects internally conflicting canonical metadata for one identifier', () => {
    const first = citationIdentity();
    const second = citationIdentity({
      displayed: {
        title: 'A conflicting canonical title',
        authors: ['A. Author', 'B. Researcher'],
        identifier: 'work:record-1',
        url: EVIDENCE_URI,
      },
      canonical: {
        ...citationIdentity().canonical!,
        title: 'A conflicting canonical title',
        provenance: {
          ...citationIdentity().canonical!.provenance,
          record_ref: `project://evidence/citation-1.json#sha256:${'cd'.repeat(32)}`,
          record_sha256: `sha256:${'cd'.repeat(32)}`,
        },
      },
    });
    expect(() => assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [
        entryInput({ claim_index: 0, citation_identities: [first] }),
        entryInput({ claim_index: 1, citation_identities: [second] }),
      ],
    })).toThrow(/canonical locator .* is reused with a title/);
  });

  it('the citation-identity downgrade is idempotent', () => {
    const mismatched = evaluateCitationIdentity(citationIdentity({
      displayed: {
        title: 'A different work',
        identifier: 'work:record-1',
        url: EVIDENCE_URI,
      },
    }));
    const assembled = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({ citation_identities: [mismatched.input] })],
    }).claims[0]!;
    expect(enforceCitationIdentityRule(assembled)).toEqual(assembled);
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

  it('rejects a hand-edited positive verdict over a stored identity mismatch', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({ citation_identities: [citationIdentity({
        displayed: {
          title: 'A different work',
          identifier: 'work:record-1',
          url: EVIDENCE_URI,
        },
      })] })],
    });
    const bad = {
      ...report,
      claims: [{ ...report.claims[0], verdict: 'substantiated', verification_status: 'verified' }],
    };
    const parsed = safeParseClaimGroundingReportV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some(item =>
        item.path === 'claims[0].verdict' && item.message.includes('citation identity is mismatch'),
      )).toBe(true);
    }
  });

  it('rejects a hand-edited conflicting/falsified verdict over a stored identity mismatch', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({
        verdict: 'conflicting',
        citation_identities: [citationIdentity({
          displayed: {
            title: 'A different work',
            identifier: 'work:record-1',
            url: EVIDENCE_URI,
          },
        })],
      })],
    });
    expect(report.claims[0]!.verdict).toBe('not_substantiated');

    const bad = {
      ...report,
      claims: [{
        ...report.claims[0],
        verdict: 'conflicting',
        verification_status: 'falsified',
      }],
      summary: {
        total: 1,
        by_verdict: {
          substantiated: 0,
          partial: 0,
          not_substantiated: 0,
          conflicting: 1,
          source_unavailable: 0,
        },
        grounding_risk_score: 1,
      },
    };
    const parsed = safeParseClaimGroundingReportV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some(item =>
        item.path === 'claims[0].verdict' && item.message.includes('citation identity is mismatch'),
      )).toBe(true);
    }
  });

  it('rejects a conflicting verdict without citation evidence', () => {
    expect(() => assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({
        verdict: 'conflicting',
        evidence_uris: [],
        supporting_spans: [],
        citation_identities: [],
      })],
    })).toThrow(/must be non-empty for verdict 'conflicting'/);
  });

  it('rejects a hand-edited identity verdict or diagnostic that its input does not reproduce', () => {
    const report = assembleClaimGroundingReport({ generated_at: GEN, entries: [entryInput()] });
    const identity = report.claims[0]!.citation_identities[0]!;
    const bad = {
      ...report,
      claims: [{
        ...report.claims[0],
        citation_identities: [{
          ...identity,
          verdict: 'mismatch',
          diagnostics: [{ code: 'title_mismatch', message: 'hand-edited diagnostic' }],
        }],
      }],
    };
    const parsed = safeParseClaimGroundingReportV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some(item => item.path.includes('citation_identities[0].verdict'))).toBe(true);
      expect(parsed.issues.some(item => item.path.includes('citation_identities[0].diagnostics'))).toBe(true);
    }
  });

  it('rejects malformed citation metadata with a validation error rather than a raw TypeError', () => {
    const malformed = citationIdentity() as unknown as Record<string, unknown>;
    malformed.canonical = { title: 'Incomplete canonical metadata' };
    expect(() => assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({
        citation_identities: [malformed as unknown as CitationIdentityInput],
      })],
    })).toThrow(/assembled claim_grounding_report failed validation/);
  });

  it('rejects a null citation identity with a validation error rather than a raw TypeError', () => {
    expect(() => assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({
        citation_identities: [null as unknown as CitationIdentityInput],
      })],
    })).toThrow(/assembled claim_grounding_report failed validation/);
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
        entryInput({
          claim_index: 1,
          claim_text: 'B',
          verdict: 'conflicting',
          supporting_spans: [{ evidence_uri: EVIDENCE_URI, quote: 'contradicts' }],
        }),
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

  it('rejects a supporting span whose URI is outside the claim evidence set', () => {
    expect(() => assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({
        supporting_spans: [{
          evidence_uri: 'https://records.example/works/record-9',
          quote: 'A statement from another source.',
        }],
      })],
    })).toThrow(/supporting_spans\[0\]\.evidence_uri: must name one of the claim evidence_uris/);
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

// ─── numeric_match coupling ───

/** |1.2 - 1.19| = 0.01 within 2 * hypot(0.1, 0.05): within_tolerance, diagnostic. */
const WITHIN_INPUT: NumericClaimComparisonInput = {
  claimed_value: 1.2,
  claimed_uncertainty: 0.1,
  source_value: 1.19,
  source_uncertainty: 0.05,
  tolerance: { kind: 'uncertainty_multiple', multiple: 2 },
};

/** |2.4 - 1.19| = 1.21 far beyond 2 * 0.05: mismatch. */
const MISMATCH_INPUT: NumericClaimComparisonInput = {
  claimed_value: 2.4,
  source_value: 1.19,
  source_uncertainty: 0.05,
  tolerance: { kind: 'uncertainty_multiple', multiple: 2 },
};

/** Tolerance 10 vs 5 * hypot(0.01, 0.01) ~ 0.07: non-diagnostic, incomparable. */
const INCOMPARABLE_INPUT: NumericClaimComparisonInput = {
  claimed_value: 1.0,
  claimed_uncertainty: 0.01,
  source_value: 1.5,
  source_uncertainty: 0.01,
  tolerance: { kind: 'absolute', value: 10 },
};

/** No uncertainties and NO no_stated_uncertainty attestation: incomparable
 *  (uncertainty_not_attested) even though |diff| is inside the window. */
const UNATTESTED_INPUT: NumericClaimComparisonInput = {
  claimed_value: 1.2,
  source_value: 1.23,
  tolerance: { kind: 'absolute', value: 0.05 },
};

/** claimed_value === source_value: exact. */
const EXACT_INPUT: NumericClaimComparisonInput = {
  claimed_value: 1.19,
  source_value: 1.19,
  tolerance: { kind: 'absolute', value: 0.01 },
};

/** Pass `comparison: null` to build a numeric_match entry with NO recorded comparison
 *  (an explicit `undefined` argument would fall back to the default parameter). */
function numericEntryInput(
  overrides: Partial<ClaimGroundingEntryInput> = {},
  comparison: ClaimNumericComparisonInputRecord | null = { input: WITHIN_INPUT },
): ClaimGroundingEntryInput {
  return entryInput({
    claim_text: 'The measured value is 1.2 +- 0.1.',
    method: 'numeric_match',
    verdict: 'substantiated',
    supporting_spans: [{
      evidence_uri: EVIDENCE_URI,
      quote: 'The reference reports 1.19 +- 0.05.',
      locator: 'Table 2',
    }],
    ...(comparison !== null ? { numeric_comparison: comparison } : {}),
    ...overrides,
  });
}

describe('assembleClaimGroundingReport: numeric_match rule', () => {
  it('keeps substantiated when the comparison computes within_tolerance, and derives verdict/details from input', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput()], // record supplies only the input
    });
    const entry = report.claims[0]!;
    expect(entry.verdict).toBe('substantiated');
    expect(entry.verification_status).toBe('verified');
    expect(entry.numeric_comparison!.verdict).toBe('within_tolerance');
    expect(entry.numeric_comparison!.details.decision_path).toBe('within_tolerance');
    expect(entry.numeric_comparison!.details.tolerance_used).toBeCloseTo(2 * Math.hypot(0.1, 0.05), 12);
  });

  it('ignores a supplied comparison verdict: a fake within_tolerance over mismatch input is recomputed AND the entry is downgraded to conflicting', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput({}, { input: MISMATCH_INPUT, verdict: 'within_tolerance' })],
    });
    const entry = report.claims[0]!;
    expect(entry.numeric_comparison!.verdict).toBe('mismatch');
    expect(entry.verdict).toBe('conflicting');
    expect(entry.verification_status).toBe('falsified');
    expect(entry.notes).toContain("supplied 'within_tolerance', computed 'mismatch'");
    expect(entry.notes).toContain('downgraded to conflicting');
    expect(report.summary.by_verdict.conflicting).toBe(1);
  });

  it('withdraws numeric falsification when the comparison used a misidentified citation', () => {
    const wrongTitle = citationIdentity({
      displayed: {
        title: 'A different work',
        authors: ['A. Author', 'B. Researcher'],
        identifier: 'work:record-1',
        url: EVIDENCE_URI,
      },
    });
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput(
        { citation_identities: [wrongTitle] },
        { input: MISMATCH_INPUT },
      )],
    });
    const entry = report.claims[0]!;
    expect(entry.numeric_comparison!.verdict).toBe('mismatch');
    expect(entry.citation_identities[0]!.verdict).toBe('mismatch');
    expect(entry.verdict).toBe('not_substantiated');
    expect(entry.verification_status).toBe('unverified');
    expect(entry.notes).toContain('citation identity mismatch');
  });

  it('downgrades partial to conflicting on a computed mismatch too', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput({ verdict: 'partial' }, { input: MISMATCH_INPUT })],
    });
    expect(report.claims[0]!.verdict).toBe('conflicting');
  });

  it('does NOT upgrade a negative verdict on a mismatch: not_substantiated stays not_substantiated', () => {
    // A mismatch may stem from a unit/convention error on the caller side (no unit
    // conversion in v1), so the machine never force-falsifies beyond the mandated rule.
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput({ verdict: 'not_substantiated' }, { input: MISMATCH_INPUT })],
    });
    expect(report.claims[0]!.verdict).toBe('not_substantiated');
    expect(report.claims[0]!.verification_status).toBe('unverified');
  });

  it('downgrades substantiated to not_substantiated when the comparison is incomparable (non-diagnostic tolerance)', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput({}, { input: INCOMPARABLE_INPUT })],
    });
    const entry = report.claims[0]!;
    expect(entry.numeric_comparison!.verdict).toBe('incomparable');
    expect(entry.numeric_comparison!.details.decision_path).toBe('non_diagnostic_tolerance');
    expect(entry.verdict).toBe('not_substantiated');
    expect(entry.notes).toContain('incomparable (non_diagnostic_tolerance)');
  });

  it('leaves partial available under an incomparable comparison', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput({ verdict: 'partial' }, { input: INCOMPARABLE_INPUT })],
    });
    expect(report.claims[0]!.verdict).toBe('partial');
  });

  it('closes the silent-omission channel: unattested no-uncertainty within cannot substantiate', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput({}, { input: UNATTESTED_INPUT })],
    });
    const entry = report.claims[0]!;
    expect(entry.numeric_comparison!.verdict).toBe('incomparable');
    expect(entry.numeric_comparison!.details.decision_path).toBe('uncertainty_not_attested');
    expect(entry.verdict).toBe('not_substantiated');
  });

  it('the attested no-uncertainty comparison can substantiate, with the weaker footing recorded', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput({}, { input: { ...UNATTESTED_INPUT, no_stated_uncertainty: true } })],
    });
    const entry = report.claims[0]!;
    expect(entry.numeric_comparison!.verdict).toBe('within_tolerance');
    expect(entry.numeric_comparison!.details.decision_path).toBe('within_tolerance_no_uncertainty');
    expect(entry.verdict).toBe('substantiated');
  });

  it('an exact comparison flows through the contract unchanged and round-trips', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput({}, { input: EXACT_INPUT })],
    });
    const entry = report.claims[0]!;
    expect(entry.numeric_comparison!.verdict).toBe('exact');
    expect(entry.numeric_comparison!.details.decision_path).toBe('exact_equal');
    expect(entry.verdict).toBe('substantiated');
    expect(safeParseClaimGroundingReportV1(report).ok).toBe(true);
  });

  it('downgrades substantiated/partial numeric_match entries that carry NO comparison', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [
        numericEntryInput({ claim_index: 0 }, null),
        numericEntryInput({ claim_index: 1, verdict: 'partial' }, null),
        numericEntryInput({ claim_index: 2, verdict: 'not_substantiated' }, null),
      ],
    });
    expect(report.claims[0]!.verdict).toBe('not_substantiated');
    expect(report.claims[0]!.notes).toContain('no numeric_comparison was recorded');
    expect(report.claims[1]!.verdict).toBe('not_substantiated');
    expect(report.claims[2]!.verdict).toBe('not_substantiated'); // untouched, no note added
    expect(report.claims[2]!.notes).toBeUndefined();
  });

  it('still applies the span rule to numeric_match entries: within_tolerance without a span is downgraded', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput({ supporting_spans: [] })],
    });
    expect(report.claims[0]!.verdict).toBe('not_substantiated');
    expect(report.claims[0]!.notes).toContain('no verbatim supporting span');
  });

  it('a computed mismatch lands on conflicting even when the entry also lacks a span (rule order)', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput({ supporting_spans: [] }, { input: MISMATCH_INPUT })],
    });
    expect(report.claims[0]!.verdict).toBe('conflicting');
  });

  it('throws when a numeric_comparison is attached to a non-numeric_match entry', () => {
    expect(() => assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [entryInput({ method: 'text_entailment', numeric_comparison: { input: WITHIN_INPUT } })],
    })).toThrow(/only allowed when method is 'numeric_match'/);
  });

  it('round-trips an assembled numeric report through the parser', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [
        numericEntryInput({ claim_index: 0 }),
        numericEntryInput({ claim_index: 1, verdict: 'partial' }, { input: INCOMPARABLE_INPUT }),
        numericEntryInput({ claim_index: 2 }, { input: MISMATCH_INPUT }),
      ],
    });
    expect(() => parseClaimGroundingReportV1(report)).not.toThrow();
  });
});

describe('enforceNumericMatchRule (unit)', () => {
  it('leaves non-numeric_match entries untouched', () => {
    const entry = { ...(entryInput() as ClaimGroundingEntry), verification_status: 'verified' as const };
    expect(enforceNumericMatchRule(entry)).toEqual(entry);
  });

  it('accepts a loose input record (no verdict/details) and fills in the derived ones', () => {
    const draft = { ...numericEntryInput(), verification_status: 'verified' as const };
    const out = enforceNumericMatchRule(draft);
    expect(out.numeric_comparison!.verdict).toBe('within_tolerance');
    expect(out.numeric_comparison!.details.decision_path).toBe('within_tolerance');
    expect(out.verdict).toBe('substantiated');
    expect(out.notes).toBeUndefined(); // no supplied verdict, so no recompute note
  });

  it('is idempotent on an already-normalized entry', () => {
    const once = enforceNumericMatchRule({ ...numericEntryInput(), verification_status: 'verified' as const });
    const twice = enforceNumericMatchRule(once);
    expect(twice).toEqual(once);
  });

  it('is idempotent on the downgrade paths too (no double-appended notes)', () => {
    const mismatched = enforceNumericMatchRule({
      ...numericEntryInput({}, { input: MISMATCH_INPUT }),
      verification_status: 'verified' as const,
    });
    expect(mismatched.verdict).toBe('conflicting');
    expect(enforceNumericMatchRule(mismatched)).toEqual(mismatched);

    const incomparable = enforceNumericMatchRule({
      ...numericEntryInput({}, { input: INCOMPARABLE_INPUT }),
      verification_status: 'verified' as const,
    });
    expect(incomparable.verdict).toBe('not_substantiated');
    expect(enforceNumericMatchRule(incomparable)).toEqual(incomparable);
  });
});

describe('safeParseClaimGroundingReportV1: numeric_match coupling', () => {
  function numericReport(
    comparisonInput: NumericClaimComparisonInput = WITHIN_INPUT,
    overrides: Partial<ClaimGroundingEntryInput> = {},
  ) {
    return assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput(overrides, { input: comparisonInput })],
    });
  }

  function tamper(report: ReturnType<typeof numericReport>, patch: Record<string, unknown>): unknown {
    return { ...report, claims: [{ ...report.claims[0], ...patch }] };
  }

  it('rejects substantiated/partial when the recorded comparison verdict is mismatch', () => {
    const report = numericReport(MISMATCH_INPUT); // assemble lands on conflicting
    for (const verdict of ['substantiated', 'partial'] as const) {
      const bad = tamper(report, { verdict });
      const parsed = safeParseClaimGroundingReportV1(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.issues.some(i =>
          i.path === 'claims[0].verdict' && i.message.includes("numeric_comparison.verdict is 'mismatch'"),
        )).toBe(true);
      }
    }
  });

  it('rejects substantiated when the recorded comparison verdict is incomparable', () => {
    const report = numericReport(INCOMPARABLE_INPUT); // assemble lands on not_substantiated
    const bad = tamper(report, { verdict: 'substantiated' });
    const parsed = safeParseClaimGroundingReportV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some(i =>
        i.path === 'claims[0].verdict' && i.message.includes("'incomparable'"),
      )).toBe(true);
    }
  });

  it('rejects a hand-edited comparison verdict that the recorded input does not reproduce', () => {
    const report = numericReport();
    const entry = report.claims[0]!;
    const bad = tamper(report, {
      verdict: 'conflicting', // keep entry-level coupling satisfied for a 'mismatch' comparison
      verification_status: 'falsified',
      numeric_comparison: { ...entry.numeric_comparison!, verdict: 'mismatch' },
    });
    const parsed = safeParseClaimGroundingReportV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some(i =>
        i.path === 'claims[0].numeric_comparison.verdict'
        && i.message.includes("recomputed from input ('within_tolerance')"),
      )).toBe(true);
    }
  });

  it('rejects a hand-edited decision_path that the recorded input does not reproduce', () => {
    const report = numericReport();
    const entry = report.claims[0]!;
    const bad = tamper(report, {
      numeric_comparison: {
        ...entry.numeric_comparison!,
        details: { ...entry.numeric_comparison!.details, decision_path: 'within_tolerance_no_uncertainty' },
      },
    });
    const parsed = safeParseClaimGroundingReportV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some(i => i.path === 'claims[0].numeric_comparison.details.decision_path')).toBe(true);
    }
  });

  it('rejects a substantiated or partial numeric_match entry with no numeric_comparison', () => {
    const report = numericReport();
    for (const [verdict, status] of [['substantiated', 'verified'], ['partial', 'unverified']] as const) {
      const entryNoComparison = {
        ...report.claims[0]!,
        verdict,
        verification_status: status,
      } as Record<string, unknown>;
      delete entryNoComparison.numeric_comparison;
      const bad = { ...report, claims: [entryNoComparison] };
      const parsed = safeParseClaimGroundingReportV1(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.issues.some(i =>
          i.path === 'claims[0].numeric_comparison' && i.message.includes('required'),
        )).toBe(true);
      }
    }
  });

  it('rejects a hand-edited verification_status that the verdict does not derive', () => {
    const report = numericReport();
    const bad = tamper(report, { verification_status: 'unverified' }); // verdict stays substantiated
    const parsed = safeParseClaimGroundingReportV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some(i =>
        i.path === 'claims[0].verification_status' && i.message.includes("derived from verdict ('verified')"),
      )).toBe(true);
    }
  });

  it('rejects a tampered summary (tally, total, or risk score) that the claims do not derive', () => {
    const report = numericReport();
    const tallyBad = {
      ...report,
      summary: { ...report.summary, by_verdict: { ...report.summary.by_verdict, substantiated: 0, conflicting: 1 } },
    };
    const totalBad = { ...report, summary: { ...report.summary, total: 2 } };
    const riskBad = { ...report, summary: { ...report.summary, grounding_risk_score: 0.9 } };
    for (const bad of [tallyBad, totalBad, riskBad]) {
      const parsed = safeParseClaimGroundingReportV1(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.issues.some(i => i.path.startsWith('summary'))).toBe(true);
      }
    }
  });

  it('accepts a numeric_match entry without comparison when the verdict is negative', () => {
    const report = assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput({ verdict: 'source_unavailable', supporting_spans: [] }, null)],
    });
    expect(safeParseClaimGroundingReportV1(report).ok).toBe(true);
  });

  it('rejects a numeric_comparison on a text_entailment entry', () => {
    const report = numericReport();
    const bad = tamper(report, { method: 'text_entailment' });
    const parsed = safeParseClaimGroundingReportV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some(i =>
        i.path === 'claims[0].numeric_comparison' && i.message.includes('only allowed'),
      )).toBe(true);
    }
  });

  it('rejects (never throws on) structurally malformed comparison records', () => {
    const report = numericReport();
    const entry = report.claims[0]!;
    const cases: unknown[] = [
      null,
      { input: null, verdict: 'exact', details: entry.numeric_comparison!.details },
      {
        input: { ...WITHIN_INPUT, claimed_value: 'not-a-number' },
        verdict: 'within_tolerance',
        details: entry.numeric_comparison!.details,
      },
      {
        input: { ...WITHIN_INPUT, tolerance: { kind: 'bogus' } },
        verdict: 'within_tolerance',
        details: entry.numeric_comparison!.details,
      },
      { input: WITHIN_INPUT, verdict: 'maybe', details: entry.numeric_comparison!.details },
      { input: WITHIN_INPUT, verdict: 'within_tolerance', details: { decision_path: 'nope', reason: '' } },
    ];
    for (const numeric_comparison of cases) {
      const bad = tamper(report, { numeric_comparison });
      expect(() => safeParseClaimGroundingReportV1(bad)).not.toThrow();
      expect(safeParseClaimGroundingReportV1(bad).ok).toBe(false);
    }
  });

  it('rejects stored comparison inputs carrying NaN/Infinity (JSON round-trip faithfulness)', () => {
    // NaN/Infinity turn into null under JSON.stringify, so a report that accepted
    // them in memory would fail to re-validate after a round-trip. The contract
    // therefore refuses to store them at all.
    const report = numericReport();
    const entry = report.claims[0]!;
    const cases: unknown[] = [
      { ...entry.numeric_comparison!, input: { ...WITHIN_INPUT, claimed_value: Number.NaN } },
      { ...entry.numeric_comparison!, input: { ...WITHIN_INPUT, source_value: Number.POSITIVE_INFINITY } },
      { ...entry.numeric_comparison!, input: { ...WITHIN_INPUT, source_uncertainty: Number.NaN } },
      {
        ...entry.numeric_comparison!,
        input: { ...WITHIN_INPUT, tolerance: { kind: 'absolute', value: Number.POSITIVE_INFINITY } },
      },
    ];
    for (const numeric_comparison of cases) {
      const bad = tamper(report, { numeric_comparison });
      const parsed = safeParseClaimGroundingReportV1(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.issues.some(i => i.message.includes('finite'))).toBe(true);
      }
    }
  });

  it('assemble refuses to store a non-finite comparison input even under a negative verdict', () => {
    expect(() => assembleClaimGroundingReport({
      generated_at: GEN,
      entries: [numericEntryInput(
        { verdict: 'not_substantiated' },
        { input: { ...WITHIN_INPUT, claimed_value: Number.NaN } },
      )],
    })).toThrow(/finite number/);
  });

  it('accepts a tampered ADVISORY detail magnitude while verdict/decision_path hold (documented boundary)', () => {
    // The numeric detail fields are an advisory audit trail, type/finiteness-checked
    // only (cross-language JSON float re-serialization); the load-bearing verdict +
    // decision_path ARE recomputed from the input and enforced. This test pins the
    // boundary so a future tightening that would break honest cross-language
    // reports fails loudly here.
    const report = numericReport();
    const entry = report.claims[0]!;
    const bad = tamper(report, {
      numeric_comparison: {
        ...entry.numeric_comparison!,
        details: { ...entry.numeric_comparison!.details, signed_difference: 99 },
      },
    });
    expect(safeParseClaimGroundingReportV1(bad).ok).toBe(true);
  });
});
