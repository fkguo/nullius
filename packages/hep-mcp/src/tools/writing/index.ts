/**
 * Writing Module - Phase 11
 *
 * Academic writing tools for generating RMP/PRL/Nature/PRD style reports.
 * Integrated as a separable submodule within hep-research-mcp.
 *
 * Key Features:
 * - Claims Table as Single Source of Truth (SSOT)
 * - INSPIRE cite key integration with run-stable references
 * - Two-phase generation with QA gates
 * - Citation verification and traceability
 *
 * @module writing
 */

// Phase 11: Unified tool handlers (use specific exports to avoid conflicts)
export {
  handleClaimsTable,
  handleVerifyCitations,
  handleCheckOriginality,
  getReferenceManager,
  resetReferenceManager,
  resetAllSessions,
  getSessionCount,
  type ClaimsTableInput,
  type VerifyCitationsInput,
  type CheckOriginalityInput,
} from './writingToolHandlers.js';

// Phase 11: State management
export * from './state/index.js';

// Phase 11: Reference management
export * from './reference/index.js';

// Phase 10 V2.0 modules - export types explicitly to avoid conflicts
export * from './types.js';
export * from './contentIndex/index.js';
export * from './claimsTable/index.js';
export * from './outline/index.js';
export {
  writeSection,
  buildWritingPacket,
  type WriteSectionParams,
  type WriteSectionResult,
} from './deepWriter/index.js';
export * from './verifier/index.js';
export * from './originality/index.js';

// Phase 12: LaTeX-Native RAG
export * as rag from './rag/index.js';

// Module version
export const WRITING_MODULE_VERSION = '11.2.0';

export const SUPPORTED_JOURNAL_STYLES = [
  'rmp',            // Rev. Mod. Phys.
  'prl',            // Phys. Rev. Lett.
  'nature',         // Nature
  'nature-physics', // Nature Physics
  'prd',            // Phys. Rev. D
] as const;

export type JournalStyle = typeof SUPPORTED_JOURNAL_STYLES[number];
