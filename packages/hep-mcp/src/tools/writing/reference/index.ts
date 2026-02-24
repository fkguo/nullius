/**
 * Reference management module exports
 *
 * This module handles BibTeX reference management for Phase 11 writing tools:
 * - Extract citation keys from INSPIRE BibTeX
 * - Manage references with run-stable keys
 * - Generate master.bib output
 */

// BibTeX utilities
export {
  extractKeyFromBibtex,
  isValidBibtexKey,
  generateFallbackKey,
  isFallbackKey,
} from './bibtexUtils.js';

// Reference manager
export {
  ReferenceManager,
  type ReferenceEntry,
  type PaperInfo,
  type AddReferenceResult,
} from './referenceManager.js';
