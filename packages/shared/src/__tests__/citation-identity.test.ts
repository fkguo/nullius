import { describe, expect, it } from 'vitest';
import {
  canonicalizeCitationLocator,
  evaluateCitationIdentity,
  normalizeCitationAuthorFamily,
  normalizeCitationTitle,
  safeParseCitationIdentityCheck,
  type CitationIdentityInput,
} from '../citation-identity.js';

const RECORD_SHA = `sha256:${'12'.repeat(32)}`;

function input(overrides: Partial<CitationIdentityInput> = {}): CitationIdentityInput {
  return {
    evidence_uri: 'https://metadata.example/works/record-3',
    displayed: {
      title: 'A study of the α response',
      authors: ['J. de Groot', 'M. Example'],
      identifier: 'work:record-3-revision-2',
      url: 'https://metadata.example/works/record-3/revision/2',
    },
    canonical: {
      title: 'A Study of the $\\alpha$ Response',
      authors: ['Johannes de Groot', 'Maria Example'],
      identifier: 'work:record-3',
      url: 'https://metadata.example/works/record-3',
      locator_aliases: [
        'work:record-3-revision-2',
        'https://metadata.example/works/record-3/revision/2',
      ],
      provenance: {
        kind: 'authoritative_retrieval',
        provider: 'canonical-registry',
        record_ref: 'https://metadata.example/records/record-3',
        record_sha256: RECORD_SHA,
      },
    },
    ...overrides,
  };
}

describe('citation metadata normalization', () => {
  it('folds common LaTeX and Unicode title forms without conflating distinct symbols', () => {
    expect(normalizeCitationTitle('A study of $\\alpha$')).toBe(normalizeCitationTitle('A Study of α'));
    expect(normalizeCitationTitle('A study of α')).not.toBe(normalizeCitationTitle('A study of β'));
  });

  it('compares ordered author family names while tolerating initials', () => {
    expect(normalizeCitationAuthorFamily('J. de Groot')).toBe(normalizeCitationAuthorFamily('Johannes de Groot'));
    expect(normalizeCitationAuthorFamily('Example, Maria')).toBe(normalizeCitationAuthorFamily('M. Example'));
  });

  it('normalizes generic URL transport details without guessing provider aliases', () => {
    expect(canonicalizeCitationLocator('https://METADATA.example/works/record-3#section'))
      .toBe(canonicalizeCitationLocator('https://metadata.example/works/record-3'));
    expect(canonicalizeCitationLocator('https://metadata.example/works/record-3?edition=1'))
      .not.toBe(canonicalizeCitationLocator('https://metadata.example/works/record-3?edition=2'));
  });
});

describe('evaluateCitationIdentity', () => {
  it('derives matched from canonical metadata rather than trusting a supplied verdict', () => {
    const check = evaluateCitationIdentity(input());
    expect(check.verdict).toBe('matched');
    expect(check.diagnostics).toEqual([]);
  });

  it('returns an explicit hard mismatch for swapped title and identifier metadata', () => {
    const check = evaluateCitationIdentity(input({
      displayed: {
        title: 'A different paper',
        authors: ['J. de Groot', 'M. Example'],
        identifier: 'work:record-999',
        url: 'https://metadata.example/works/record-3',
      },
    }));
    expect(check.verdict).toBe('mismatch');
    expect(check.diagnostics.map(item => item.code)).toEqual([
      'title_mismatch',
      'displayed_identifier_mismatch',
    ]);
  });

  it('accepts only provider-declared locator aliases instead of guessing equivalence', () => {
    const canonical = { ...input().canonical!, locator_aliases: undefined };
    const check = evaluateCitationIdentity(input({ canonical }));
    expect(check.verdict).toBe('mismatch');
    expect(check.diagnostics.map(item => item.code)).toEqual([
      'displayed_identifier_mismatch',
      'displayed_url_mismatch',
    ]);
  });

  it('fails closed when displayed authors cannot be checked against canonical metadata', () => {
    const canonical = { ...input().canonical! };
    delete canonical.authors;
    const check = evaluateCitationIdentity(input({ canonical }));
    expect(check.verdict).toBe('metadata_unavailable');
    expect(check.diagnostics.map(item => item.code)).toEqual(['authors_unavailable']);
  });

  it('records canonical metadata unavailability instead of treating content retrieval as identity', () => {
    const check = evaluateCitationIdentity(input({
      canonical: undefined,
      unavailable_reason: 'no archived record and authoritative retrieval unavailable',
    }));
    expect(check.verdict).toBe('metadata_unavailable');
    expect(check.diagnostics[0]!.code).toBe('canonical_metadata_unavailable');
  });
});

describe('safeParseCitationIdentityCheck', () => {
  it('round-trips a derived matched check', () => {
    expect(safeParseCitationIdentityCheck(evaluateCitationIdentity(input())).ok).toBe(true);
  });

  it('rejects a hand-edited verdict and diagnostics', () => {
    const check = evaluateCitationIdentity(input());
    const parsed = safeParseCitationIdentityCheck({
      ...check,
      verdict: 'mismatch',
      diagnostics: [{ code: 'title_mismatch', message: 'hand-edited diagnostic' }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some(item => item.path === 'verdict')).toBe(true);
      expect(parsed.issues.some(item => item.path === 'diagnostics')).toBe(true);
    }
  });

  it('rejects unbound provenance and unavailable inputs without a reason', () => {
    const badProvenance = evaluateCitationIdentity(input({
      canonical: {
        ...input().canonical!,
        provenance: { ...input().canonical!.provenance, record_sha256: 'sha256:not-a-hash' },
      },
    }));
    expect(safeParseCitationIdentityCheck(badProvenance).ok).toBe(false);

    const unavailable = evaluateCitationIdentity(input({ canonical: undefined }));
    expect(safeParseCitationIdentityCheck(unavailable).ok).toBe(false);
  });

  it('rejects an archived metadata reference whose URI fragment names another digest', () => {
    const canonical = {
      ...input().canonical!,
      provenance: {
        kind: 'archived_canonical_metadata' as const,
        provider: 'canonical-registry',
        record_ref: `project://evidence/record-3.json#sha256:${'34'.repeat(32)}`,
        record_sha256: RECORD_SHA,
      },
    };
    const parsed = safeParseCitationIdentityCheck(evaluateCitationIdentity(input({ canonical })));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some(item =>
        item.path === 'input.canonical.provenance.record_ref'
        && item.message.includes('matching #sha256'),
      )).toBe(true);
    }
  });
});
