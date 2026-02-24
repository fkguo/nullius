/**
 * Response Compression Utilities
 *
 * Removes empty arrays and null/undefined fields to reduce token usage.
 * Only removes fields that have no information value.
 */

import type { EnhancedClaimsTable, Claim } from '../types.js';
import type { VerifyCitationsResult } from '../verifier/types.js';
import type { CheckOriginalityResult } from '../originality/types.js';

/**
 * Compress a single claim by removing empty fields
 */
function compressClaim(claim: Claim): Partial<Claim> {
  const result: Partial<Claim> = {
    claim_id: claim.claim_id,
    claim_text: claim.claim_text,
    paper_ids: claim.paper_ids,
  };

  // Only include non-default category
  if (claim.category && claim.category !== 'summary') {
    result.category = claim.category;
  }

  // Only include non-consensus status
  if (claim.status && claim.status !== 'consensus') {
    result.status = claim.status;
  }

  // Only include non-empty keywords (limit to 5)
  if (claim.keywords && claim.keywords.length > 0) {
    result.keywords = claim.keywords.slice(0, 5);
  }

  // Only include non-empty arrays
  if (claim.supporting_evidence && claim.supporting_evidence.length > 0) {
    result.supporting_evidence = claim.supporting_evidence;
  }
  if (claim.refuting_evidence && claim.refuting_evidence.length > 0) {
    result.refuting_evidence = claim.refuting_evidence;
  }

  // Only include non-empty source_context
  if (claim.source_context?.before || claim.source_context?.after) {
    result.source_context = claim.source_context;
  }

  return result;
}

/**
 * Compress claims table by removing empty fields
 */
export function compressClaimsTable(
  claimsTable: EnhancedClaimsTable
): EnhancedClaimsTable {
  return {
    ...claimsTable,
    claims: claimsTable.claims.map(c => compressClaim(c) as Claim),
    // Remove empty disagreement graph
    disagreement_graph: {
      edges: claimsTable.disagreement_graph?.edges?.length > 0
        ? claimsTable.disagreement_graph.edges
        : [],
      clusters: claimsTable.disagreement_graph?.clusters?.length > 0
        ? claimsTable.disagreement_graph.clusters
        : [],
    },
    // Remove empty notation/glossary
    notation_table: claimsTable.notation_table?.length > 0
      ? claimsTable.notation_table
      : [],
    glossary: claimsTable.glossary?.length > 0
      ? claimsTable.glossary
      : [],
  };
}

/** Extended verification result with bibtex_keys */
type VerificationWithKeys = VerifyCitationsResult & { bibtex_keys_verified: string[] };

/**
 * Compress verification result: remove empty issues array
 */
export function compressVerification(v: VerificationWithKeys): VerificationWithKeys {
  if (v.pass && v.issues.length === 0) {
    return {
      pass: true,
      issues: [],
      statistics: v.statistics,
      bibtex_keys_verified: v.bibtex_keys_verified,
    };
  }
  return v;
}

/** Extended originality result with recommendation */
type OriginalityWithRec = CheckOriginalityResult & { recommendation: string };

/**
 * Compress originality result: when acceptable, keep minimal fields
 */
export function compressOriginality(o: OriginalityWithRec): OriginalityWithRec {
  if (o.is_acceptable && o.flagged_count === 0) {
    return {
      is_acceptable: true,
      level: o.level,
      max_overlap: o.max_overlap,
      needs_review: false,
      flagged_count: 0,
      recommendation: o.recommendation,
    };
  }
  return o;
}
