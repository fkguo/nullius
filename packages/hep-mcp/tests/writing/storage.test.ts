/**
 * Claims Table Storage Tests
 *
 * Tests for disk storage functionality:
 * - Store and retrieve round-trip
 * - Memory cache behavior
 * - Cleanup functionality
 * - Error handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  storeClaimsTable,
  retrieveClaimsTable,
  isValidReference,
  clearMemoryStore,
  cleanupExpiredFiles,
  getStorageStats,
} from '../../src/tools/writing/claimsTable/storage.js';

import type { EnhancedClaimsTable } from '../../src/tools/writing/types.js';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockClaimsTable(overrides: Partial<EnhancedClaimsTable> = {}): EnhancedClaimsTable {
  return {
    id: 'test-id',
    corpus_snapshot: {
      paper_count: 1,
      recids: ['123456'],
      generated_at: new Date().toISOString(),
    },
    claims: [
      {
        claim_id: 'c1',
        claim_no: 'C001',
        claim_text: 'Test claim',
        category: 'experimental_result',
        status: 'emerging',
        paper_ids: ['123456'],
        supporting_evidence: [],
        assumptions: [],
        scope: '',
        evidence_grade: 'moderate',
        keywords: [],
        is_extractive: true,
      },
    ],
    visual_assets: {
      formulas: [
        {
          id: 'f1',
          latex: 'E = mc^2',
          label: 'eq:energy',
          importance: 'high',
          importance_score: 80,
          paper_id: '123456',
          locator: { label: 'eq:energy' },
        },
      ],
      figures: [],
      tables: [],
    },
    glossary: [],
    notation_table: [],
    disagreement_graph: { nodes: [], edges: [] },
    analysis_dimensions: [],
    metadata: {
      created_at: new Date().toISOString(),
      processing_time_ms: 100,
      source_paper_count: 1,
      version: '2.0',
    },
    statistics: {
      total_claims: 1,
      claims_by_category: { experimental_result: 1 },
      claims_by_status: { emerging: 1 },
      total_formulas: 1,
      total_figures: 0,
      total_tables: 0,
      coverage_ratio: 1,
    },
    ...overrides,
  };
}

// =============================================================================
// Test Setup
// =============================================================================

describe('Claims Table Storage', () => {
  let testDir: string;
  let originalProgressEnv: string | undefined;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    // Create temp directory for tests
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
    originalProgressEnv = process.env.WRITING_PROGRESS_DIR;
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    process.env.HEP_DATA_DIR = testDir;
    process.env.WRITING_PROGRESS_DIR = testDir;

    // Clear memory store before each test
    clearMemoryStore();
  });

  afterEach(() => {
    // Restore environment
    if (originalProgressEnv !== undefined) {
      process.env.WRITING_PROGRESS_DIR = originalProgressEnv;
    } else {
      delete process.env.WRITING_PROGRESS_DIR;
    }
    if (originalDataDirEnv !== undefined) {
      process.env.HEP_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.HEP_DATA_DIR;
    }

    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }

    clearMemoryStore();
  });

  // ===========================================================================
  // Store and Retrieve Tests
  // ===========================================================================

  describe('storeClaimsTable', () => {
    it('should store claims table and return reference', async () => {
      const table = createMockClaimsTable();
      const ref = await storeClaimsTable(table, 'test-topic');

      expect(ref.ref_id).toMatch(/^ct_[a-f0-9]{12}$/);
      expect(ref.topic).toBe('test-topic');
      expect(ref.statistics.total_claims).toBe(1);
      expect(ref.statistics.total_formulas).toBe(1);
      expect(ref.paper_ids).toEqual(['123456']);
      expect(ref.storage_path).toContain(testDir);
    });

    it('fails fast when WRITING_PROGRESS_DIR is unsafe', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-outside-'));
      try {
        process.env.WRITING_PROGRESS_DIR = outsideDir; // outside HEP_DATA_DIR (unsafe)

        const table = createMockClaimsTable();
        await expect(storeClaimsTable(table, 'test-topic')).rejects.toMatchObject({ code: 'UNSAFE_FS' });
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('fails fast when writing_progress is a symlink escape', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-outside-'));
      try {
        delete process.env.WRITING_PROGRESS_DIR; // use default <HEP_DATA_DIR>/writing_progress

        const linkPath = path.join(testDir, 'writing_progress');
        fs.symlinkSync(outsideDir, linkPath, 'dir');

        const table = createMockClaimsTable();
        await expect(storeClaimsTable(table, 'test-topic')).rejects.toMatchObject({ code: 'UNSAFE_FS' });
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('should create file on disk', async () => {
      const table = createMockClaimsTable();
      const ref = await storeClaimsTable(table, 'test-topic');

      expect(fs.existsSync(ref.storage_path)).toBe(true);

      const content = JSON.parse(fs.readFileSync(ref.storage_path, 'utf-8'));
      expect(content.ref_id).toBe(ref.ref_id);
      expect(content.claims_table.claims.length).toBe(1);
    });
  });

  describe('retrieveClaimsTable', () => {
    it('should retrieve stored claims table', async () => {
      const original = createMockClaimsTable();
      const ref = await storeClaimsTable(original, 'test-topic');

      // Clear memory to force disk read
      clearMemoryStore();

      const retrieved = await retrieveClaimsTable(ref.ref_id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.claims.length).toBe(1);
      expect(retrieved!.visual_assets.formulas.length).toBe(1);
      expect(retrieved!.visual_assets.formulas[0].latex).toBe('E = mc^2');
    });

    it('fails fast when WRITING_PROGRESS_DIR is unsafe', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-outside-'));
      try {
        const original = createMockClaimsTable();
        const ref = await storeClaimsTable(original, 'test-topic');

        clearMemoryStore(); // force disk read

        process.env.WRITING_PROGRESS_DIR = outsideDir; // outside HEP_DATA_DIR (unsafe)
        await expect(retrieveClaimsTable(ref.ref_id)).rejects.toMatchObject({ code: 'UNSAFE_FS' });
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('fails fast when writing_progress is a symlink escape', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-outside-'));
      try {
        const original = createMockClaimsTable();
        const ref = await storeClaimsTable(original, 'test-topic');

        const linkPath = path.join(testDir, 'writing_progress');
        fs.symlinkSync(outsideDir, linkPath, 'dir');

        clearMemoryStore(); // force disk read

        delete process.env.WRITING_PROGRESS_DIR; // use default <HEP_DATA_DIR>/writing_progress
        await expect(retrieveClaimsTable(ref.ref_id)).rejects.toMatchObject({ code: 'UNSAFE_FS' });
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('should return from memory cache on second access', async () => {
      const original = createMockClaimsTable();
      const ref = await storeClaimsTable(original, 'test-topic');

      // First retrieval (from memory, as store also caches)
      const first = await retrieveClaimsTable(ref.ref_id);
      expect(first).not.toBeNull();

      // Delete disk file
      fs.unlinkSync(ref.storage_path);

      // Second retrieval should still work (from memory)
      const second = await retrieveClaimsTable(ref.ref_id);
      expect(second).not.toBeNull();
      expect(second!.claims[0].claim_text).toBe('Test claim');
    });

    it('should return null for non-existent ref_id', async () => {
      const result = await retrieveClaimsTable('ct_nonexistent');
      expect(result).toBeNull();
    });

    it('should reject malicious ref_id (path traversal attempt)', async () => {
      // These should all return null due to format validation
      const maliciousIds = [
        '../../../etc/passwd',
        'ct_../../../etc',
        'ct_12345678901x',  // invalid hex
        'ct_12345',         // too short
        'ct_1234567890123', // too long
        '',
        'random_string',
      ];

      for (const id of maliciousIds) {
        const result = await retrieveClaimsTable(id);
        expect(result).toBeNull();
      }
    });
  });

  describe('isValidReference', () => {
    it('should return true for valid reference', async () => {
      const table = createMockClaimsTable();
      const ref = await storeClaimsTable(table, 'test-topic');

      const valid = await isValidReference(ref.ref_id);
      expect(valid).toBe(true);
    });

    it('should return false for invalid reference', async () => {
      const valid = await isValidReference('ct_invalid123');
      expect(valid).toBe(false);
    });

    it('should reject malicious ref_id format', async () => {
      const valid = await isValidReference('../../../etc/passwd');
      expect(valid).toBe(false);
    });

    it('should return true when only in memory', async () => {
      const table = createMockClaimsTable();
      const ref = await storeClaimsTable(table, 'test-topic');

      // Delete disk file but keep memory
      fs.unlinkSync(ref.storage_path);

      const valid = await isValidReference(ref.ref_id);
      expect(valid).toBe(true);
    });
  });

  // ===========================================================================
  // Cleanup Tests
  // ===========================================================================

  describe('cleanupExpiredFiles', () => {
    it('should delete old files', async () => {
      const table = createMockClaimsTable();
      const ref = await storeClaimsTable(table, 'test-topic');

      // Set file mtime to 2 days ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(ref.storage_path, twoHoursAgo, twoHoursAgo);

      // Cleanup with 1 hour max age
      const result = cleanupExpiredFiles(60 * 60 * 1000);

      expect(result.deleted).toBe(1);
      expect(result.remaining).toBe(0);
      expect(fs.existsSync(ref.storage_path)).toBe(false);
    });

    it('should keep recent files', async () => {
      const table = createMockClaimsTable();
      const ref = await storeClaimsTable(table, 'test-topic');

      // Cleanup with 24 hour max age (file is very recent)
      const result = cleanupExpiredFiles(24 * 60 * 60 * 1000);

      expect(result.deleted).toBe(0);
      expect(result.remaining).toBe(1);
      expect(fs.existsSync(ref.storage_path)).toBe(true);
    });

    it('should also clear memory cache for deleted files', async () => {
      const table = createMockClaimsTable();
      const ref = await storeClaimsTable(table, 'test-topic');

      // Set file mtime to old
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      fs.utimesSync(ref.storage_path, old, old);

      // Cleanup
      cleanupExpiredFiles(60 * 60 * 1000);

      // Memory cache should also be cleared
      const retrieved = await retrieveClaimsTable(ref.ref_id);
      expect(retrieved).toBeNull();
    });
  });

  describe('getStorageStats', () => {
    it('should return correct statistics', async () => {
      const table1 = createMockClaimsTable();
      const table2 = createMockClaimsTable({ id: 'test-id-2' });

      await storeClaimsTable(table1, 'topic1');
      await storeClaimsTable(table2, 'topic2');

      const stats = getStorageStats();

      expect(stats.memory_count).toBe(2);
      expect(stats.disk_count).toBe(2);
      expect(stats.storage_dir).toBe(testDir);
      expect(stats.total_size_bytes).toBeGreaterThan(0);
    });

    it('should handle empty storage', () => {
      const stats = getStorageStats();

      expect(stats.memory_count).toBe(0);
      expect(stats.disk_count).toBe(0);
      expect(stats.total_size_bytes).toBe(0);
    });
  });
});
