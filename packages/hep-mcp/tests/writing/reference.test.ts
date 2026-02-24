/**
 * Reference module tests
 *
 * Tests for Phase 11.1 reference management:
 * - extractKeyFromBibtex: BibTeX key extraction
 * - ReferenceManager: INSPIRE key strategy, run-stable, fallback
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
  extractKeyFromBibtex,
  isValidBibtexKey,
  generateFallbackKey,
  isFallbackKey,
} from '../../src/tools/writing/reference/bibtexUtils.js';

import {
  ReferenceManager,
} from '../../src/tools/writing/reference/referenceManager.js';

import {
  MockClock,
} from '../../src/tools/writing/state/testable.js';

// =============================================================================
// extractKeyFromBibtex Tests
// =============================================================================

describe('extractKeyFromBibtex', () => {
  it('should extract key from simple article', () => {
    const bibtex = '@article{Guo:2017jvc,\n  title = {Test}\n}';
    expect(extractKeyFromBibtex(bibtex)).toBe('Guo:2017jvc');
  });

  it('should extract key from inproceedings', () => {
    const bibtex = '@inproceedings{BESIII:2020nme,\n  title = {Test}\n}';
    expect(extractKeyFromBibtex(bibtex)).toBe('BESIII:2020nme');
  });

  it('should handle whitespace around key', () => {
    const bibtex = '@article{  Guo:2017jvc  ,\n  title = {Test}\n}';
    expect(extractKeyFromBibtex(bibtex)).toBe('Guo:2017jvc');
  });

  it('should skip @comment entries', () => {
    const bibtex = `@comment{This is a comment}
@article{Actual:2020key,
  title = {Test}
}`;
    expect(extractKeyFromBibtex(bibtex)).toBe('Actual:2020key');
  });

  it('should skip @preamble entries', () => {
    const bibtex = `@preamble{"Some preamble"}
@article{Real:2021,
  title = {Test}
}`;
    expect(extractKeyFromBibtex(bibtex)).toBe('Real:2021');
  });

  it('should skip @string entries', () => {
    const bibtex = `@string{jphysg = "J. Phys. G"}
@article{Paper:2022,
  title = {Test}
}`;
    expect(extractKeyFromBibtex(bibtex)).toBe('Paper:2022');
  });

  it('should handle BOM', () => {
    const bibtex = '\uFEFF@article{WithBom:2023,\n  title = {Test}\n}';
    expect(extractKeyFromBibtex(bibtex)).toBe('WithBom:2023');
  });

  it('should return null for empty string', () => {
    expect(extractKeyFromBibtex('')).toBeNull();
  });

  it('should return null for invalid bibtex', () => {
    expect(extractKeyFromBibtex('not bibtex at all')).toBeNull();
  });

  it('should handle keys with various characters', () => {
    expect(extractKeyFromBibtex('@article{Author:2020abc, ...}')).toBe('Author:2020abc');
    expect(extractKeyFromBibtex('@article{Author_Name:2020, ...}')).toBe('Author_Name:2020');
    expect(extractKeyFromBibtex('@article{Author-Name.2020, ...}')).toBe('Author-Name.2020');
  });
});

describe('bibtexUtils helpers', () => {
  describe('isValidBibtexKey', () => {
    it('should accept valid keys', () => {
      expect(isValidBibtexKey('Guo:2017jvc')).toBe(true);
      expect(isValidBibtexKey('BESIII:2020nme')).toBe(true);
      expect(isValidBibtexKey('Author_Name:2020')).toBe(true);
      expect(isValidBibtexKey('A-B.C:2020')).toBe(true);
    });

    it('should reject invalid keys', () => {
      expect(isValidBibtexKey('has space')).toBe(false);
      expect(isValidBibtexKey('has{brace')).toBe(false);
      expect(isValidBibtexKey('')).toBe(false);
    });
  });

  describe('generateFallbackKey', () => {
    it('should generate INSPIRE_ prefix', () => {
      expect(generateFallbackKey('1515400')).toBe('INSPIRE_1515400');
    });
  });

  describe('isFallbackKey', () => {
    it('should detect fallback keys', () => {
      expect(isFallbackKey('INSPIRE_1515400')).toBe(true);
      expect(isFallbackKey('Guo:2017jvc')).toBe(false);
    });
  });
});

// =============================================================================
// ReferenceManager Tests
// =============================================================================

describe('ReferenceManager', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `ref-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('addReference - INSPIRE key priority', () => {
    it('should use INSPIRE bibtex key when available', () => {
      const refManager = new ReferenceManager();
      const bibtex = '@article{Guo:2017jvc,\n  title = {Test}\n}';

      const result = refManager.addReference(
        '1515400',
        { title: 'Test', authors: ['Guo'], year: 2017 },
        bibtex
      );

      expect(result.bibtex_key).toBe('Guo:2017jvc');
      expect(result.source).toBe('inspire');
      expect(result.is_new).toBe(true);
    });

    it('should fallback when no INSPIRE bibtex', () => {
      const refManager = new ReferenceManager();

      const result = refManager.addReference(
        '1515400',
        { title: 'Test', authors: ['Guo'], year: 2017 }
        // No bibtex parameter
      );

      expect(result.bibtex_key).toBe('INSPIRE_1515400');
      expect(result.source).toBe('fallback');
    });

    it('should fallback when key extraction fails', () => {
      const refManager = new ReferenceManager();
      const badBibtex = 'invalid bibtex content';

      const result = refManager.addReference(
        '1515400',
        { title: 'Test', authors: ['Guo'], year: 2017 },
        badBibtex
      );

      expect(result.bibtex_key).toBe('INSPIRE_1515400');
      expect(result.source).toBe('fallback');
    });
  });

  describe('addReference - Run-stable keys', () => {
    it('should return same key for same recid (run-stable)', () => {
      const refManager = new ReferenceManager();
      const bibtex1 = '@article{OldKey:2020, title={Test}}';

      const result1 = refManager.addReference(
        '123',
        { title: 'Test', authors: [], year: 2020 },
        bibtex1
      );
      expect(result1.bibtex_key).toBe('OldKey:2020');
      expect(result1.is_new).toBe(true);

      // Second call with different bibtex
      const bibtex2 = '@article{NewKey:2020, title={Test}}';
      const result2 = refManager.addReference(
        '123',
        { title: 'Test', authors: [], year: 2020 },
        bibtex2
      );

      // Should keep original key
      expect(result2.bibtex_key).toBe('OldKey:2020');
      expect(result2.is_new).toBe(false);
    });
  });

  describe('addReference - Key conflict handling', () => {
    it('should add recid suffix on key conflict', () => {
      const refManager = new ReferenceManager();

      // First paper with key
      refManager.addReference(
        '111',
        { title: 'First', authors: [], year: 2020 },
        '@article{Same:2020, ...}'
      );

      // Second paper with same key (different recid)
      const result = refManager.addReference(
        '222',
        { title: 'Second', authors: [], year: 2020 },
        '@article{Same:2020, ...}'
      );

      expect(result.bibtex_key).toBe('Same:2020_222');
      expect(result.source).toBe('fallback');
    });
  });

  describe('generateMasterBib', () => {
    it('should use INSPIRE bibtex as-is', () => {
      const refManager = new ReferenceManager();
      const inspireBibtex = `@article{Guo:2017jvc,
  author = "Guo, Feng-Kun",
  title = "{Hadronic molecules}",
  journal = "Rev. Mod. Phys.",
  volume = "90",
  year = "2018"
}`;

      refManager.addReference(
        '1515400',
        { title: 'Hadronic molecules', authors: ['Guo, Feng-Kun'], year: 2018 },
        inspireBibtex
      );

      const masterBib = refManager.generateMasterBib();

      // Should contain original bibtex unchanged
      expect(masterBib).toContain('@article{Guo:2017jvc');
      expect(masterBib).toContain('Rev. Mod. Phys.');
      expect(masterBib).toContain('author = "Guo, Feng-Kun"');
    });

    it('should generate fallback bibtex for entries without INSPIRE bibtex', () => {
      const refManager = new ReferenceManager();

      refManager.addReference('789', {
        title: 'Test Paper',
        authors: ['Author, A.'],
        year: 2021,
        arxiv_id: '2101.12345',
      });

      const masterBib = refManager.generateMasterBib();

      expect(masterBib).toContain('@misc{INSPIRE_789');
      expect(masterBib).toContain('title = {Test Paper}');
      expect(masterBib).toContain('author = {Author, A.}');
      expect(masterBib).toContain('eprint = {2101.12345}');
    });

    it('should use collaborations in fallback when no authors', () => {
      const refManager = new ReferenceManager();

      refManager.addReference('789', {
        title: 'ATLAS measurement',
        authors: [],
        collaborations: ['ATLAS'],
        year: 2020,
      });

      const masterBib = refManager.generateMasterBib();
      expect(masterBib).toContain('{ATLAS Collaboration}');
    });

    it('should combine multiple entries', () => {
      const refManager = new ReferenceManager();

      refManager.addReference(
        '111',
        { title: 'Paper 1', authors: ['A'], year: 2020 },
        '@article{Key1:2020, title={Paper 1}}'
      );

      refManager.addReference(
        '222',
        { title: 'Paper 2', authors: ['B'], year: 2021 },
        '@article{Key2:2021, title={Paper 2}}'
      );

      const masterBib = refManager.generateMasterBib();

      expect(masterBib).toContain('Key1:2020');
      expect(masterBib).toContain('Key2:2021');
    });
  });

  describe('lookup methods', () => {
    it('should get key by recid', () => {
      const refManager = new ReferenceManager();
      refManager.addReference(
        '123',
        { title: 'Test', authors: [], year: 2020 },
        '@article{TestKey:2020, ...}'
      );

      expect(refManager.getKeyByRecid('123')).toBe('TestKey:2020');
      expect(refManager.getKeyByRecid('999')).toBeUndefined();
    });

    it('should get recid by key', () => {
      const refManager = new ReferenceManager();
      refManager.addReference(
        '123',
        { title: 'Test', authors: [], year: 2020 },
        '@article{TestKey:2020, ...}'
      );

      expect(refManager.getRecidByKey('TestKey:2020')).toBe('123');
      expect(refManager.getRecidByKey('Unknown')).toBeUndefined();
    });

    it('should get full entry', () => {
      const refManager = new ReferenceManager();
      refManager.addReference(
        '123',
        { title: 'Test Paper', authors: ['Author'], year: 2020, doi: '10.1234/test' },
        '@article{TestKey:2020, ...}'
      );

      const entry = refManager.getEntry('123');
      expect(entry).toBeDefined();
      expect(entry!.title).toBe('Test Paper');
      expect(entry!.doi).toBe('10.1234/test');
    });

    it('should check hasRecid', () => {
      const refManager = new ReferenceManager();
      refManager.addReference('123', { title: 'Test', authors: [], year: 2020 });

      expect(refManager.hasRecid('123')).toBe(true);
      expect(refManager.hasRecid('999')).toBe(false);
    });

    it('should return size', () => {
      const refManager = new ReferenceManager();
      expect(refManager.size).toBe(0);

      refManager.addReference('123', { title: 'Test', authors: [], year: 2020 });
      expect(refManager.size).toBe(1);
    });
  });

  describe('persistence', () => {
    it('should save and load from disk', async () => {
      // Save
      const manager1 = new ReferenceManager(testDir);
      manager1.addReference(
        '123',
        { title: 'Test', authors: ['Author'], year: 2020 },
        '@article{TestKey:2020, title={Test}}'
      );
      await manager1.saveToDisk();

      // Load
      const manager2 = new ReferenceManager(testDir);
      await manager2.loadFromDisk();

      expect(manager2.getKeyByRecid('123')).toBe('TestKey:2020');
      expect(manager2.getEntry('123')?.title).toBe('Test');
    });

    it('should handle missing file gracefully', async () => {
      const manager = new ReferenceManager(testDir);
      await manager.loadFromDisk();  // Should not throw
      expect(manager.size).toBe(0);
    });

    it('should throw without runDir', async () => {
      const manager = new ReferenceManager();  // No runDir
      await expect(manager.saveToDisk()).rejects.toThrow('runDir not configured');
      await expect(manager.loadFromDisk()).rejects.toThrow('runDir not configured');
    });
  });

  describe('testable clock injection', () => {
    it('should use injected clock for timestamps', () => {
      const mockClock = new MockClock(new Date('2025-01-15T12:00:00Z'));
      const refManager = new ReferenceManager(undefined, mockClock);

      refManager.addReference(
        '123',
        { title: 'Test', authors: [], year: 2020 },
        '@article{Test:2020, ...}'
      );

      const entry = refManager.getEntry('123');
      expect(entry?.registered_at).toBe('2025-01-15T12:00:00.000Z');
    });
  });
});
