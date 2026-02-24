/**
 * Claims Table Storage
 * Stores full claims tables to disk, returns lightweight references for MCP responses
 * Uses WRITING_PROGRESS_DIR for storage (same as other writing workflow intermediates)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { EnhancedClaimsTable } from '../types.js';
import { generateFingerprint } from '../contentIndex/fingerprint.js';
import { getWritingProgressDir } from '../../../data/dataDir.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ClaimsTableReference {
  /** Unique reference ID for retrieving the full table */
  ref_id: string;
  /** Topic used for generation */
  topic: string;
  /** Statistics summary */
  statistics: {
    total_claims: number;
    total_formulas: number;
    total_figures: number;
    total_tables: number;
    claims_by_category: Record<string, number>;
  };
  /** Paper IDs included */
  paper_ids: string[];
  /** Created timestamp */
  created_at: string;
  /** Storage path (for debugging) */
  storage_path: string;
}

export interface StoredClaimsTable {
  ref_id: string;
  claims_table: EnhancedClaimsTable;
  created_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Valid ref_id format: ct_ followed by exactly 12 hex characters
const REF_ID_PATTERN = /^ct_[a-f0-9]{12}$/;

// Use WRITING_PROGRESS_DIR for consistency with other writing workflow files.
// Fail-fast if the env var is misconfigured (points outside HEP_DATA_DIR).
function getStorageDir(): string {
  return getWritingProgressDir();
}

/**
 * Validate ref_id format to prevent path traversal attacks
 */
function isValidRefIdFormat(refId: string): boolean {
  return REF_ID_PATTERN.test(refId);
}

// In-memory cache for faster subsequent access
const memoryStore = new Map<string, StoredClaimsTable>();

// ─────────────────────────────────────────────────────────────────────────────
// Storage Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Store a claims table and return a lightweight reference
 */
export async function storeClaimsTable(
  claimsTable: EnhancedClaimsTable,
  topic: string
): Promise<ClaimsTableReference> {
  const refId = generateRefId(claimsTable, topic);
  const createdAt = new Date().toISOString();
  const storageDir = getStorageDir();

  const stored: StoredClaimsTable = {
    ref_id: refId,
    claims_table: claimsTable,
    created_at: createdAt,
  };

  // Ensure directory exists
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  // Write to disk
  const filePath = path.join(storageDir, `${refId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(stored, null, 2));

  // Also cache in memory for faster access
  memoryStore.set(refId, stored);

  return {
    ref_id: refId,
    topic,
    statistics: {
      total_claims: claimsTable.claims.length,
      total_formulas: claimsTable.visual_assets.formulas.length,
      total_figures: claimsTable.visual_assets.figures.length,
      total_tables: claimsTable.visual_assets.tables.length,
      claims_by_category: claimsTable.statistics?.claims_by_category || {},
    },
    paper_ids: claimsTable.corpus_snapshot.recids,
    created_at: createdAt,
    storage_path: filePath,
  };
}

/**
 * Retrieve a full claims table by reference ID
 * Note: Currently uses sync fs operations but API is async for future extensibility
 */
export async function retrieveClaimsTable(
  refId: string
): Promise<EnhancedClaimsTable | null> {
  // Validate ref_id format to prevent path traversal
  if (!isValidRefIdFormat(refId)) {
    return null;
  }

  // Try memory first (faster)
  const memoryStored = memoryStore.get(refId);
  if (memoryStored) {
    return memoryStored.claims_table;
  }

  // Try disk
  const storageDir = getStorageDir();
  const filePath = path.join(storageDir, `${refId}.json`);

  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const stored = JSON.parse(content) as StoredClaimsTable;
      // Cache in memory for faster subsequent access
      memoryStore.set(refId, stored);
      return stored.claims_table;
    } catch {
      // Corrupted file, ignore
    }
  }

  return null;
}

/**
 * Check if a claims table reference is valid
 * Note: Currently uses sync fs operations but API is async for future extensibility
 */
export async function isValidReference(refId: string): Promise<boolean> {
  // Validate ref_id format to prevent path traversal
  if (!isValidRefIdFormat(refId)) {
    return false;
  }

  if (memoryStore.has(refId)) return true;

  const storageDir = getStorageDir();
  const filePath = path.join(storageDir, `${refId}.json`);
  return fs.existsSync(filePath);
}

/**
 * Clear expired claims tables from memory
 */
export function clearMemoryStore(): void {
  memoryStore.clear();
}

/**
 * Cleanup expired claims table files from disk
 * @param maxAgeMs Maximum age in milliseconds (default: 24 hours)
 * @returns Object with counts of deleted and remaining files
 */
export function cleanupExpiredFiles(maxAgeMs: number = 24 * 60 * 60 * 1000): {
  deleted: number;
  remaining: number;
  errors: string[];
} {
  const storageDir = getStorageDir();
  const result = { deleted: 0, remaining: 0, errors: [] as string[] };

  if (!fs.existsSync(storageDir)) {
    return result;
  }

  const now = Date.now();
  const files = fs.readdirSync(storageDir).filter(f => f.startsWith('ct_') && f.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(storageDir, file);
    try {
      const stat = fs.statSync(filePath);
      const age = now - stat.mtimeMs;

      if (age > maxAgeMs) {
        // Also remove from memory cache
        const refId = file.replace('.json', '');
        memoryStore.delete(refId);
        fs.unlinkSync(filePath);
        result.deleted++;
      } else {
        result.remaining++;
      }
    } catch (error) {
      result.errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

/**
 * Get storage statistics
 */
export function getStorageStats(): {
  memory_count: number;
  disk_count: number;
  storage_dir: string;
  total_size_bytes: number;
} {
  const storageDir = getStorageDir();
  let diskCount = 0;
  let totalSize = 0;

  if (fs.existsSync(storageDir)) {
    const files = fs.readdirSync(storageDir).filter(f => f.startsWith('ct_') && f.endsWith('.json'));
    diskCount = files.length;

    for (const file of files) {
      try {
        const stat = fs.statSync(path.join(storageDir, file));
        totalSize += stat.size;
      } catch {
        // Ignore errors
      }
    }
  }

  return {
    memory_count: memoryStore.size,
    disk_count: diskCount,
    storage_dir: storageDir,
    total_size_bytes: totalSize,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function generateRefId(claimsTable: EnhancedClaimsTable, topic: string): string {
  const input = `${topic}:${claimsTable.corpus_snapshot.recids.join(',')}:${Date.now()}`;
  const fingerprint = generateFingerprint(input);
  return `ct_${fingerprint.slice(0, 12)}`;
}
