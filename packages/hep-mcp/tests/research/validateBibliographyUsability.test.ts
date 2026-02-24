import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/tools/research/extractBibliography.js', () => ({
  extractBibliography: vi.fn(),
}));

vi.mock('../../src/tools/research/latex/inspireValidator.js', () => ({
  validateBibliography: vi.fn(),
  isValidTexkey: vi.fn((key: string) => /^[A-Za-z][A-Za-z-]*:\d{4}[a-z]{2,4}$/i.test(key)),
}));

import { validateBibliography } from '../../src/tools/research/validateBibliography.js';
import * as extractBibliographyModule from '../../src/tools/research/extractBibliography.js';
import * as inspireValidatorModule from '../../src/tools/research/latex/inspireValidator.js';

describe('validateBibliography usability-first audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to manual_only usability checks and skips INSPIRE-managed entries', async () => {
    vi.mocked(extractBibliographyModule.extractBibliography).mockResolvedValueOnce({
      entries: [
        { key: 'Guo:2017jvc', type: 'article', doi: '10.1000/abc' },
        { key: 'ManualNote', type: 'misc', title: 'internal note' },
        { key: 'ManualWithDoi', type: 'misc', doi: '10.2000/xyz' },
      ],
      source_file: '/tmp/main.tex',
      arxiv_id: '2501.00001',
      total: 3,
      with_doi: 2,
      with_arxiv: 0,
    } as any);

    const result = await validateBibliography({ identifier: '2501.00001' });

    expect(inspireValidatorModule.validateBibliography).not.toHaveBeenCalled();
    expect(result.usability.scope).toBe('manual_only');
    expect(result.usability.checked_entries).toBe(2);
    expect(result.usability.skipped_inspire_managed).toBe(1);
    expect(result.usability.locatable).toBe(1);
    expect(result.usability.not_locatable).toBe(1);
    expect(result.usability.warnings).toHaveLength(1);
    expect(result.usability.warnings[0]?.key).toBe('ManualNote');
    expect(result.summary.total).toBe(2);
    expect(result.summary.matched).toBe(0);
  });

  it('can enable INSPIRE cross-check for audited entries', async () => {
    vi.mocked(extractBibliographyModule.extractBibliography).mockResolvedValueOnce({
      entries: [
        { key: 'ManualOne', type: 'article', doi: '10.1000/abc' },
        { key: 'ManualTwo', type: 'article', arxiv_id: '2501.12345' },
      ],
      source_file: '/tmp/main.tex',
      arxiv_id: '2501.00001',
      total: 2,
      with_doi: 1,
      with_arxiv: 1,
    } as any);

    vi.mocked(inspireValidatorModule.validateBibliography).mockResolvedValueOnce([
      { key: 'ManualOne', status: 'matched', match_method: 'doi', inspire_recid: '111' },
      { key: 'ManualTwo', status: 'not_found' },
    ] as any);

    const result = await validateBibliography({
      identifier: '2501.00001',
      scope: 'all',
      validate_against_inspire: true,
      check_discrepancies: false,
    });

    expect(inspireValidatorModule.validateBibliography).toHaveBeenCalledTimes(1);
    const [entriesArg, optionsArg] = vi.mocked(inspireValidatorModule.validateBibliography).mock.calls[0] ?? [];
    expect(Array.isArray(entriesArg)).toBe(true);
    expect((entriesArg as any[]).length).toBe(2);
    expect(optionsArg).toMatchObject({ check_discrepancies: false });

    expect(result.summary.total).toBe(2);
    expect(result.summary.matched).toBe(1);
    expect(result.summary.not_found).toBe(1);
    expect(result.match_methods.doi).toBe(1);
  });
});
