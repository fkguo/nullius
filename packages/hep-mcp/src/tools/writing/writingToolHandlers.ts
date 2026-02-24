/**
 * Writing Tool Handlers (internal)
 *
 * This module provides runtime-validated helper entry points used by the
 * consolidated research pipelines (e.g., `inspire_deep_research`) and vNext
 * writing flows.
 *
 * Key features:
 * - INSPIRE cite key priority strategy
 * - Run-stable references within session
 * - Integration with state/ and reference/ modules
 * - Parallel API calls for performance
 * - Zod runtime validation for type safety
 */

import { generateClaimsTable } from './claimsTable/generator.js';
import { verifyCitations } from './verifier/citationVerifier.js';
import { checkOriginality } from './originality/overlapDetector.js';
import { ReferenceManager } from './reference/referenceManager.js';
import { extractKeyFromBibtex } from './reference/bibtexUtils.js';
import * as api from '../../api/client.js';
import type {
  EnhancedClaimsTable,
  SectionOutput,
} from './types.js';
import type { VerifyCitationsResult } from './verifier/types.js';
import type { CheckOriginalityResult } from './originality/types.js';
import { z } from 'zod';
import {
  ClaimsTableInputSchema,
  VerifyCitationsInputSchema,
  CheckOriginalityInputSchema,
} from './inputSchemas.js';

// =============================================================================
// Types (derived from Zod schemas)
// =============================================================================

export type ClaimsTableInput = z.infer<typeof ClaimsTableInputSchema>;
export type VerifyCitationsInput = z.infer<typeof VerifyCitationsInputSchema>;
export type CheckOriginalityInput = z.infer<typeof CheckOriginalityInputSchema>;

// =============================================================================
// Session-Scoped Reference Manager
// =============================================================================

/**
 * Session-isolated ReferenceManager storage
 *
 * Design notes:
 * - Each session gets its own ReferenceManager
 * - Session ID should be passed from MCP client
 * - Default session for backward compatibility
 * - Automatic cleanup after MAX_SESSION_AGE_MS
 */
const SESSION_MANAGERS = new Map<string, { manager: ReferenceManager; lastAccess: number }>();
const DEFAULT_SESSION_ID = '__default__';
const MAX_SESSION_AGE_MS = 30 * 60 * 1000;  // 30 minutes
const MAX_SESSIONS = 100;  // Prevent unbounded growth

/**
 * Get or create the session-scoped ReferenceManager
 *
 * @param sessionId - Optional session ID for isolation. Defaults to shared session.
 */
export function getReferenceManager(sessionId: string = DEFAULT_SESSION_ID): ReferenceManager {
  // Cleanup old sessions periodically
  cleanupOldSessions();

  const entry = SESSION_MANAGERS.get(sessionId);
  if (entry) {
    entry.lastAccess = Date.now();
    return entry.manager;
  }

  // Create new session
  const manager = new ReferenceManager();
  SESSION_MANAGERS.set(sessionId, { manager, lastAccess: Date.now() });
  return manager;
}

/**
 * Reset the reference manager for a session (for testing or explicit cleanup)
 *
 * @param sessionId - Session to reset. If not provided, resets default session.
 */
export function resetReferenceManager(sessionId: string = DEFAULT_SESSION_ID): void {
  SESSION_MANAGERS.delete(sessionId);
}

/**
 * Reset all sessions (for testing)
 */
export function resetAllSessions(): void {
  SESSION_MANAGERS.clear();
}

/**
 * Get current session count (for monitoring)
 */
export function getSessionCount(): number {
  return SESSION_MANAGERS.size;
}

/**
 * Cleanup sessions older than MAX_SESSION_AGE_MS
 */
function cleanupOldSessions(): void {
  const now = Date.now();
  const cutoff = now - MAX_SESSION_AGE_MS;

  for (const [sessionId, entry] of SESSION_MANAGERS.entries()) {
    if (entry.lastAccess < cutoff) {
      SESSION_MANAGERS.delete(sessionId);
    }
  }

  // If still too many sessions, remove oldest
  if (SESSION_MANAGERS.size > MAX_SESSIONS) {
    const sorted = [...SESSION_MANAGERS.entries()]
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const toRemove = sorted.slice(0, sorted.length - MAX_SESSIONS);
    for (const [sessionId] of toRemove) {
      SESSION_MANAGERS.delete(sessionId);
    }
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Parse batch bibtex response into a map of recid -> bibtex entry
 */
function parseBibtexToMap(bibtexContent: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!bibtexContent) return result;

  // Split by @ to get individual entries
  const entries = bibtexContent.split(/(?=@)/);

  for (const entry of entries) {
    if (!entry.trim()) continue;

    // Try to extract the key and match to recid
    const keyMatch = extractKeyFromBibtex(entry);
    if (keyMatch) {
      // The INSPIRE key format is usually Author:YYYYxxx
      // We need to find the recid from the entry itself
      // Look for note field with recid or url with recid
      const recidMatch = entry.match(/inspirehep\.net\/(?:literature|record)\/(\d+)/i)
        || entry.match(/\brecid\s*=\s*["']?(\d+)/i);

      if (recidMatch) {
        result.set(recidMatch[1], entry.trim());
      }
    }
  }

  return result;
}

// =============================================================================
// Tool Handlers
// =============================================================================

/**
 * Handle inspire_claims_table
 *
 * Enhanced with:
 * - Batch bibtex fetching (single API call)
 * - Parallel paper info fetching
 * - Session-isolated ReferenceManager
 */
export async function handleClaimsTable(
  params: unknown,
  opts?: { referenceManager?: ReferenceManager }
): Promise<{
  claims_table: EnhancedClaimsTable;
  processing_time_ms: number;
  warnings: string[];
  references_added: number;
  ref_id?: string;  // For disk-stored tables
  storage_path?: string;  // For debugging
}> {
  // Validate input
  const validated = ClaimsTableInputSchema.parse(params);
  const { recids, topic, include_visual_assets = true, use_disk_storage = true } = validated;

  // Generate claims table using existing generator (no limit)
  const result = await generateClaimsTable({
    recids,
    topic,
    include_visual_assets,
    use_disk_storage,
  });

  // Register references with ReferenceManager
  const refManager = opts?.referenceManager ?? getReferenceManager();

  // Filter out already registered recids
  const newRecids = recids.filter(recid => !refManager.hasRecid(recid));

  if (newRecids.length === 0) {
    return {
      claims_table: result.claims_table,
      processing_time_ms: result.processing_time_ms,
      warnings: result.warnings,
      references_added: 0,
      ref_id: result.reference?.ref_id,  // Include ref_id even on early return
      storage_path: result.reference?.storage_path,
    };
  }

  // OPTIMIZATION: Batch fetch bibtex for all new recids (single API call)
  let bibtexMap = new Map<string, string>();
  try {
    const allBibtex = await api.getBibtex(newRecids);
    bibtexMap = parseBibtexToMap(allBibtex);
  } catch (error) {
    result.warnings.push(`Failed to batch fetch bibtex: ${error instanceof Error ? error.message : String(error)}`);
  }

  // OPTIMIZATION: Parallel fetch paper info with concurrency limit
  const CONCURRENCY_LIMIT = 5;
  let referencesAdded = 0;

  // Process in batches for controlled concurrency
  for (let i = 0; i < newRecids.length; i += CONCURRENCY_LIMIT) {
    const batch = newRecids.slice(i, i + CONCURRENCY_LIMIT);

    const results = await Promise.allSettled(
      batch.map(async (recid) => {
        const paper = await api.getPaper(recid);
        return { recid, paper };
      })
    );

    for (const settledResult of results) {
      if (settledResult.status === 'fulfilled') {
        const { recid, paper } = settledResult.value;

        // Get bibtex from pre-fetched map or try individual fetch
        let bibtex = bibtexMap.get(recid);
        if (!bibtex) {
          // Fallback: individual fetch (rare case)
          try {
            bibtex = await api.getBibtex([recid]);
          } catch {
            // Will use fallback key
          }
        }

        const addResult = refManager.addReference(
          recid,
          {
            title: paper.title,
            authors: paper.authors || [],
            collaborations: paper.collaborations,
            year: paper.year || new Date().getFullYear(),
            arxiv_id: paper.arxiv_id,
            doi: paper.doi,
          },
          bibtex
        );

        if (addResult.is_new) {
          referencesAdded++;
        }
      } else {
        const recid = batch[results.indexOf(settledResult)];
        result.warnings.push(
          `Failed to register reference for ${recid}: ${settledResult.reason instanceof Error ? settledResult.reason.message : String(settledResult.reason)}`
        );
      }
    }
  }

  return {
    claims_table: result.claims_table,
    processing_time_ms: result.processing_time_ms,
    warnings: result.warnings,
    references_added: referencesAdded,
    ref_id: result.reference?.ref_id,  // For disk-stored tables
    storage_path: result.reference?.storage_path,  // For debugging
  };
}

// =============================================================================
// Phase 11.3: Verification Tool Handlers
// =============================================================================

/**
 * Handle inspire_verify_citations
 *
 * Verifies citation completeness and sentence-level attribution:
 * - Checks for orphan citations (in text but not in attributions)
 * - Checks for unauthorized citations
 * - Validates citation consistency
 */
export function handleVerifyCitations(
  params: unknown,
  opts?: { referenceManager?: ReferenceManager }
): VerifyCitationsResult & {
  bibtex_keys_verified: string[];
} {
  // Validate input
  const validated = VerifyCitationsInputSchema.parse(params);

  // Resolve citation keys to bibtex keys for reference
  const refManager = opts?.referenceManager ?? getReferenceManager();
  const looksLikeRecid = (s: string) => /^\d+$/.test(s);

  const expandCitationAliases = (cite: string): string[] => {
    const token = cite.trim();
    if (!token) return [];
    const out = new Set<string>([token]);

    const stripped = token.startsWith('inspire:') ? token.slice('inspire:'.length) : token;
    if (looksLikeRecid(stripped)) {
      out.add(stripped);
      out.add(`inspire:${stripped}`);
      const key = refManager.getKeyByRecid(stripped);
      if (key) out.add(key);
      return Array.from(out);
    }

    const recidFromKey = refManager.getRecidByKey(token);
    if (recidFromKey) {
      out.add(recidFromKey);
      out.add(`inspire:${recidFromKey}`);
      const key = refManager.getKeyByRecid(recidFromKey);
      if (key) out.add(key);
    }

    return Array.from(out);
  };

  const buildAllowedCitations = (): string[] | undefined => {
    // If caller explicitly provides an allowlist (even empty), respect and enforce it.
    if (Array.isArray(validated.allowed_citations)) {
      const expanded = new Set<string>();
      for (const c of validated.allowed_citations) {
        for (const alias of expandCitationAliases(c)) {
          expanded.add(alias);
        }
      }
      return Array.from(expanded);
    }

    // Fallback: derive global allowlist from claims_table.
    const ct = validated.claims_table as unknown as {
      corpus_snapshot?: { recids?: unknown };
      claims?: unknown;
    };
    const recids = new Set<string>();

    if (ct.corpus_snapshot && Array.isArray(ct.corpus_snapshot.recids)) {
      for (const r of ct.corpus_snapshot.recids) {
        if (typeof r === 'string' && looksLikeRecid(r)) recids.add(r);
      }
    }
    if (Array.isArray(ct.claims)) {
      for (const claim of ct.claims as Array<{ paper_ids?: unknown }>) {
        if (!claim || typeof claim !== 'object') continue;
        if (!Array.isArray(claim.paper_ids)) continue;
        for (const pid of claim.paper_ids) {
          if (typeof pid === 'string' && looksLikeRecid(pid)) recids.add(pid);
        }
      }
    }

    if (recids.size === 0) {
      return undefined;
    }

    const expanded = new Set<string>();
    for (const recid of recids) {
      for (const alias of expandCitationAliases(`inspire:${recid}`)) {
        expanded.add(alias);
      }
    }
    return Array.from(expanded);
  };

  const normalizedSectionOutput = (() => {
    const raw = validated.section_output as unknown as { attributions?: unknown } & SectionOutput;
    if (!Array.isArray(raw.attributions)) return raw as unknown as SectionOutput;

    const normalizedAttributions = raw.attributions.map((a: any) => {
      const citations = Array.isArray(a?.citations) ? a.citations.flatMap((c: any) => typeof c === 'string' ? expandCitationAliases(c) : []) : [];
      const unique = Array.from(new Set(citations));
      return { ...a, citations: unique };
    });

    return { ...raw, attributions: normalizedAttributions } as unknown as SectionOutput;
  })();

  const allowedCitations = buildAllowedCitations();

  const result = verifyCitations({
    section_output: normalizedSectionOutput,
    claims_table: validated.claims_table as unknown as EnhancedClaimsTable,
    allowed_citations: allowedCitations,
  });

  // Collect BibTeX keys that appear in citations (either directly or via recid mapping)
  const bibtexKeySet = new Set<string>();
  const attributions = Array.isArray(normalizedSectionOutput.attributions) ? normalizedSectionOutput.attributions : [];
  for (const attr of attributions as Array<{ citations?: string[] }>) {
    for (const cite of (attr.citations || [])) {
      const token = String(cite).trim();
      if (!token) continue;

      const stripped = token.startsWith('inspire:') ? token.slice('inspire:'.length) : token;
      if (looksLikeRecid(stripped)) {
        const key = refManager.getKeyByRecid(stripped);
        if (key) bibtexKeySet.add(key);
        continue;
      }

      // Assume bibtex key
      bibtexKeySet.add(token);
    }
  }

  const bibtexKeysVerified = Array.from(bibtexKeySet);

  return {
    ...result,
    bibtex_keys_verified: bibtexKeysVerified,
  };
}

/**
 * Handle inspire_check_originality
 *
 * Checks generated content for excessive overlap with source material:
 * - Uses 5-gram Jaccard similarity
 * - Critical threshold: >50% (hard fail)
 * - Warning threshold: >20% (soft warning)
 */
export function handleCheckOriginality(params: unknown): CheckOriginalityResult & {
  recommendation: string;
} {
  // Validate input
  const validated = CheckOriginalityInputSchema.parse(params);

  const result = checkOriginality({
    generated_text: validated.generated_text,
    source_evidences: validated.source_evidences,
    threshold: validated.threshold,
  });

  // Add human-readable recommendation
  let recommendation: string;
  switch (result.level) {
    case 'critical':
      recommendation = 'Content has excessive overlap (>50%). Must be rewritten to add original synthesis.';
      break;
    case 'warning':
      recommendation = 'Content has moderate overlap (>20%). Consider adding more analysis and synthesis.';
      break;
    case 'acceptable':
      recommendation = 'Content originality is acceptable. Proceed with publication.';
      break;
  }

  return {
    ...result,
    recommendation,
  };
}
