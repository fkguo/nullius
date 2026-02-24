/**
 * Reference Manager for Phase 11 writing tools
 *
 * Manages BibTeX references with INSPIRE integration:
 * - Priority: Use INSPIRE's cite key when available
 * - Run-stable: First key wins within a writing session
 * - Fallback: Generate INSPIRE_<recid> when API fails or bibtex parse error
 * - Output: Use INSPIRE's original bibtex as-is in master.bib
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteJson, atomicReadJson } from '../state/atomicWrite.js';
import { type Clock, systemClock, isNodeError } from '../state/testable.js';
import { extractKeyFromBibtex, generateFallbackKey } from './bibtexUtils.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Reference entry stored in the manager
 */
export interface ReferenceEntry {
  /** INSPIRE record ID (internal index key) */
  recid: string;

  /** BibTeX citation key (for \cite{}) */
  bibtex_key: string;

  /** Source of the key */
  bibtex_source: 'inspire' | 'fallback';

  /** Paper title */
  title: string;

  /** Author list */
  authors: string[];

  /** HEP collaborations (e.g., LHCb, BESIII) */
  collaborations?: string[];

  /** Publication year */
  year: number;

  /** arXiv identifier */
  arxiv_id?: string;

  /** DOI */
  doi?: string;

  /** Original INSPIRE BibTeX content (stored as-is) */
  bibtex_content?: string;

  /** When this reference was registered */
  registered_at: string;
}

/**
 * Paper info for adding a reference
 */
export interface PaperInfo {
  title: string;
  authors: string[];
  collaborations?: string[];
  year: number;
  arxiv_id?: string;
  doi?: string;
}

/**
 * Result of adding a reference
 */
export interface AddReferenceResult {
  /** The BibTeX key to use in \cite{} */
  bibtex_key: string;

  /** Source of the key */
  source: 'inspire' | 'fallback';

  /** Whether this is a newly added reference */
  is_new: boolean;
}

/**
 * Serialized format for disk storage
 */
interface ReferenceMapData {
  entries: Record<string, ReferenceEntry>;
  key_to_recid: Record<string, string>;
  updated_at: string;
}

// =============================================================================
// Reference Manager
// =============================================================================

/**
 * Reference Manager
 *
 * Key behaviors (from V8.1):
 * 1. Run-stable: Once a key is assigned to a recid, it doesn't change
 * 2. INSPIRE priority: Use INSPIRE's key when bibtex is available
 * 3. Fallback: Use INSPIRE_<recid> when API fails or bibtex parse error
 * 4. As-is output: Master.bib uses INSPIRE's original bibtex unchanged
 */
export class ReferenceManager {
  /** recid -> ReferenceEntry */
  private entries = new Map<string, ReferenceEntry>();

  /** bibtex_key -> recid (for reverse lookup) */
  private keyToRecid = new Map<string, string>();

  /** Directory for persistence (optional) */
  private readonly runDir?: string;

  /** Clock for timestamps (injectable for testing) */
  private readonly clock: Clock;

  constructor(runDir?: string, clock: Clock = systemClock) {
    this.runDir = runDir;
    this.clock = clock;
  }

  // ===========================================================================
  // Core Methods
  // ===========================================================================

  /**
   * Add a reference
   *
   * Strategy (V8.1):
   * 1. Run-stable: If recid already exists, return existing key
   * 2. INSPIRE priority: Extract key from bibtex if provided
   * 3. Fallback: Use INSPIRE_<recid> if no bibtex or extraction fails
   * 4. Handle key conflicts by adding recid suffix
   */
  addReference(
    recid: string,
    paperInfo: PaperInfo,
    inspireBibtex?: string
  ): AddReferenceResult {
    // Run-stable: already exists, return existing
    if (this.entries.has(recid)) {
      const existing = this.entries.get(recid)!;
      return {
        bibtex_key: existing.bibtex_key,
        source: existing.bibtex_source,
        is_new: false,
      };
    }

    // Determine key and source
    let bibtex_key: string;
    let bibtex_source: 'inspire' | 'fallback';

    if (inspireBibtex) {
      const extractedKey = extractKeyFromBibtex(inspireBibtex);
      if (extractedKey) {
        bibtex_key = extractedKey;
        bibtex_source = 'inspire';
      } else {
        // Extraction failed, fallback
        console.warn(
          `Cannot extract key from INSPIRE bibtex for recid=${recid}, using fallback`
        );
        bibtex_key = generateFallbackKey(recid);
        bibtex_source = 'fallback';
      }
    } else {
      // No bibtex provided, fallback
      bibtex_key = generateFallbackKey(recid);
      bibtex_source = 'fallback';
    }

    // Handle key conflict (rare but possible)
    if (this.keyToRecid.has(bibtex_key)) {
      const existingRecid = this.keyToRecid.get(bibtex_key)!;
      if (existingRecid !== recid) {
        console.warn(
          `Key conflict: ${bibtex_key} used by recid=${existingRecid}, ` +
          `adding suffix for recid=${recid}`
        );
        bibtex_key = `${bibtex_key}_${recid}`;
        bibtex_source = 'fallback';
      }
    }

    // Create and store entry
    const entry: ReferenceEntry = {
      recid,
      bibtex_key,
      bibtex_source,
      title: paperInfo.title,
      authors: paperInfo.authors,
      collaborations: paperInfo.collaborations,
      year: paperInfo.year,
      arxiv_id: paperInfo.arxiv_id,
      doi: paperInfo.doi,
      bibtex_content: inspireBibtex,
      registered_at: this.clock.nowIso(),
    };

    this.entries.set(recid, entry);
    this.keyToRecid.set(bibtex_key, recid);

    return {
      bibtex_key,
      source: bibtex_source,
      is_new: true,
    };
  }

  /**
   * Generate master.bib content
   *
   * Strategy (V8.1):
   * - INSPIRE entries: Use original bibtex as-is (no modifications)
   * - Fallback entries: Generate minimal @misc entry
   */
  generateMasterBib(): string {
    const bibtexEntries: string[] = [];

    const entries = Array.from(this.entries.values()).sort((a, b) => {
      const byKey = a.bibtex_key.localeCompare(b.bibtex_key);
      if (byKey !== 0) return byKey;
      return a.recid.localeCompare(b.recid);
    });

    for (const entry of entries) {
      if (entry.bibtex_content && entry.bibtex_source === 'inspire') {
        // Use INSPIRE's original bibtex unchanged
        bibtexEntries.push(entry.bibtex_content.trim());
      } else {
        // Generate fallback bibtex
        bibtexEntries.push(this.generateFallbackBibtex(entry));
      }
    }

    return bibtexEntries.join('\n\n');
  }

  // ===========================================================================
  // Lookup Methods
  // ===========================================================================

  /**
   * Get BibTeX key by recid
   */
  getKeyByRecid(recid: string): string | undefined {
    return this.entries.get(recid)?.bibtex_key;
  }

  /**
   * Get recid by BibTeX key
   */
  getRecidByKey(key: string): string | undefined {
    return this.keyToRecid.get(key);
  }

  /**
   * Get full entry by recid
   */
  getEntry(recid: string): ReferenceEntry | undefined {
    return this.entries.get(recid);
  }

  /**
   * Get all entries
   */
  getAllEntries(): ReferenceEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Check if recid is registered
   */
  hasRecid(recid: string): boolean {
    return this.entries.has(recid);
  }

  /**
   * Get count of references
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Get all BibTeX keys registered in this session
   */
  getAllKeys(): string[] {
    return Array.from(this.entries.values())
      .map(e => e.bibtex_key)
      .sort((a, b) => a.localeCompare(b));
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  /**
   * Load references from disk (for resume)
   */
  async loadFromDisk(): Promise<void> {
    if (!this.runDir) {
      throw new Error('ReferenceManager: runDir not configured for persistence');
    }

    const filePath = path.join(this.runDir, 'reference_map.json');

    try {
      const data = await atomicReadJson<ReferenceMapData>(filePath);

      // Restore entries
      for (const entry of Object.values(data.entries)) {
        this.entries.set(entry.recid, entry);
        this.keyToRecid.set(entry.bibtex_key, entry.recid);
      }
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) {
        // File doesn't exist, start fresh
        return;
      }
      throw error;
    }
  }

  /**
   * Save references to disk
   */
  async saveToDisk(): Promise<void> {
    if (!this.runDir) {
      throw new Error('ReferenceManager: runDir not configured for persistence');
    }

    const filePath = path.join(this.runDir, 'reference_map.json');

    const entriesSorted = Array.from(this.entries.entries()).sort(([a], [b]) => a.localeCompare(b));
    const keySorted = Array.from(this.keyToRecid.entries()).sort(([a], [b]) => a.localeCompare(b));

    const data: ReferenceMapData = {
      entries: Object.fromEntries(entriesSorted),
      key_to_recid: Object.fromEntries(keySorted),
      updated_at: this.clock.nowIso(),
    };

    // Ensure directory exists
    await fs.mkdir(this.runDir, { recursive: true });
    await atomicWriteJson(filePath, data);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Generate fallback BibTeX for entries without INSPIRE bibtex
   */
  private generateFallbackBibtex(entry: ReferenceEntry): string {
    // Author field: prefer authors, then collaborations
    let authorField: string;
    if (entry.authors && entry.authors.length > 0) {
      authorField = entry.authors.join(' and ');
    } else if (entry.collaborations && entry.collaborations.length > 0) {
      authorField = entry.collaborations
        .map(c => `{${c} Collaboration}`)
        .join(' and ');
    } else {
      authorField = 'Unknown';
    }

    const lines = [
      `@misc{${entry.bibtex_key},`,
      `  title = {${this.escapeBibtex(entry.title)}},`,
      `  author = {${authorField}},`,
      `  year = {${entry.year}},`,
    ];

    if (entry.arxiv_id) {
      lines.push(`  eprint = {${entry.arxiv_id}},`);
    }

    if (entry.doi) {
      lines.push(`  doi = {${entry.doi}},`);
    }

    lines.push(`  note = {INSPIRE-HEP: ${entry.recid}}`);
    lines.push('}');

    return lines.join('\n');
  }

  /**
   * Escape special BibTeX characters in text
   */
  private escapeBibtex(text: string): string {
    return text.replace(/[{}]/g, '');
  }
}
