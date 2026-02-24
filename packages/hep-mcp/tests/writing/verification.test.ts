import { describe, it, expect } from 'vitest';

import { verifyAssetCoverage } from '../../src/tools/writing/verifier/assetCoverageChecker.js';
import { verifyWordCount } from '../../src/tools/writing/verifier/wordCountChecker.js';
import { verifyCrossRefReadiness } from '../../src/tools/writing/verifier/crossRefReadinessChecker.js';
import type { WritingPacket } from '../../src/tools/writing/types.js';

describe('M12.2: Phase 1 Verification + Retry (post-hoc)', () => {
  describe('Asset Coverage Verification', () => {
    it('detects missing mentions', () => {
      const assigned_assets: WritingPacket['assigned_assets'] = {
        equations: [{ evidence_id: 'eq_abc123', label: 'eq:mass', number: '3' } as any],
        figures: [],
        tables: [],
      };

      const result = verifyAssetCoverage({ content: 'No equation reference here.' }, assigned_assets);
      expect(result.pass).toBe(false);
      expect(result.equations.missing).toContain('eq_abc123');
      expect(result.feedback.join('\n')).toContain('NOT referenced');
    });

    it('detects shallow adjacent discussion', () => {
      const assigned_assets: WritingPacket['assigned_assets'] = {
        equations: [{ evidence_id: 'eq_abc123' } as any],
        figures: [],
        tables: [],
      };

      const content = `We use Eq[eq_abc123]. Short.\n\nNext paragraph is also short.`;
      const result = verifyAssetCoverage({ content }, assigned_assets);
      expect(result.pass).toBe(false);
      expect(result.equations.shallow).toContain('eq_abc123');
    });

    it('passes when the asset is discussed substantively near the mention', () => {
      const assigned_assets: WritingPacket['assigned_assets'] = {
        equations: [{ evidence_id: 'eq_abc123' } as any],
        figures: [],
        tables: [],
      };

      const content = `We reference Eq[eq_abc123] and explain it in depth. This sentence adds context and meaning.
It indicates how parameters relate to observables and why the dependence matters for interpretation.
We further compare alternative forms and discuss limitations, making the explanation clearly substantive.`;

      const result = verifyAssetCoverage({ content }, assigned_assets);
      expect(result.pass).toBe(true);
      expect(result.equations.missing).toEqual([]);
      expect(result.equations.shallow).toEqual([]);
    });

    it('passes when a later mention contains the substantive adjacent discussion', () => {
      const assigned_assets: WritingPacket['assigned_assets'] = {
        equations: [{ evidence_id: 'eq_abc123' } as any],
        figures: [],
        tables: [],
      };

      const content = `We first mention Eq[eq_abc123] briefly.\n\nLater we return to Eq[eq_abc123] and explain it in depth. This sentence adds context and meaning.
It indicates how parameters relate to observables and why the dependence matters for interpretation.
We further compare alternative forms and discuss limitations, making the explanation clearly substantive.`;

      const result = verifyAssetCoverage({ content }, assigned_assets);
      expect(result.pass).toBe(true);
      expect(result.equations.missing).toEqual([]);
      expect(result.equations.shallow).toEqual([]);
    });

    it('rejects non-pointer mentions (evidence_id alone is not a valid reference)', () => {
      const assigned_assets: WritingPacket['assigned_assets'] = {
        equations: [{ evidence_id: 'eq_abc123' } as any],
        figures: [],
        tables: [],
      };

      const content = `The term eq_abc123 appears in text, but without a proper reference marker.\n\nWe talk about the equation in words without explicit pointer.`;
      const result = verifyAssetCoverage({ content }, assigned_assets);
      expect(result.pass).toBe(false);
      expect(result.equations.missing).toContain('eq_abc123');
    });
  });

  describe('Word Count Verification', () => {
    it('fails when below budget', () => {
      const result = verifyWordCount('too short', { min_words: 50, max_words: 100 });
      expect(result.pass).toBe(false);
      expect(result.feedback.join('\n')).toContain('below minimum');
    });
  });

  describe('Cross-ref Readiness Verification', () => {
    it('fails when expected definitions are missing', () => {
      const result = verifyCrossRefReadiness(
        { content: 'This section discusses something else.' },
        { this_section_defines: ['X(3872)'] }
      );
      expect(result.pass).toBe(false);
      expect(result.missing_definitions).toContain('X(3872)');
    });
  });
});
