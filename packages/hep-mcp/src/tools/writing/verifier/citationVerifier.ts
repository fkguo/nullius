/**
 * Citation Verifier
 */

import type { VerifyCitationsParams, VerifyCitationsResult, CitationIssue } from './types.js';
import type { SectionOutput, SentenceAttribution } from '../types.js';
import { checkCitationDensity } from './citationDensityChecker.js';

/** Extract all citations from LaTeX content */
function extractAllCitations(content: string): string[] {
  const cites: string[] = [];
  // Support \cite, \citep, \citet, \citealt, etc.
  const pattern = /\\cite[a-zA-Z*]*\{([^}]+)\}/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const keys = match[1].split(',').map(k => k.trim());
    cites.push(...keys);
  }
  return cites;
}

function normalizeCitationToken(token: string): string {
  return token.trim();
}

function stripInspirePrefix(token: string): string {
  return token.startsWith('inspire:') ? token.slice('inspire:'.length) : token;
}

function looksLikeRecid(token: string): boolean {
  return /^\d+$/.test(token);
}

function isCitationRequired(attr: SentenceAttribution): boolean {
  if (!attr) return false;
  if (attr.is_grounded === false) return false;
  // Keep minimal and strict to avoid false positives for transition/interpretation sentences.
  return attr.type === 'fact' || attr.type === 'definition';
}

function extractAllowedRecidsFromClaimsTable(claimsTable: unknown): Set<string> {
  const recids = new Set<string>();
  if (!claimsTable || typeof claimsTable !== 'object') return recids;

  const ct = claimsTable as {
    corpus_snapshot?: { recids?: unknown };
    claims?: unknown;
  };

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

  return recids;
}

function buildAllowedCitationSet(params: VerifyCitationsParams): {
  allowedSet: Set<string>;
  enforced: boolean;
} {
  const allowedSet = new Set<string>();

  const allowedProvided = Array.isArray(params.allowed_citations);
  if (allowedProvided) {
    for (const raw of params.allowed_citations ?? []) {
      if (typeof raw !== 'string') continue;
      const token = normalizeCitationToken(raw);
      if (!token) continue;
      allowedSet.add(token);

      const recid = stripInspirePrefix(token);
      if (looksLikeRecid(recid)) {
        allowedSet.add(recid);
        allowedSet.add(`inspire:${recid}`);
      }
    }

    // If caller provided allowlist (even empty), enforce it.
    return { allowedSet, enforced: true };
  }

  // Fallback: derive allowlist from claims_table (global allowlist)
  const recids = extractAllowedRecidsFromClaimsTable(params.claims_table);
  for (const recid of recids) {
    allowedSet.add(recid);
    allowedSet.add(`inspire:${recid}`);
  }

  // If we derived anything, enforce; otherwise we can't make an authorization decision.
  return { allowedSet, enforced: allowedSet.size > 0 };
}

export function verifyCitations(params: VerifyCitationsParams): VerifyCitationsResult {
  const { section_output } = params;
  const output = section_output as SectionOutput;
  const issues: CitationIssue[] = [];

  // Extract all citations from content
  const content = output.content || '';
  const allCites = extractAllCitations(content)
    .map(normalizeCitationToken)
    .filter(Boolean);

  const { allowedSet, enforced: enforceAllowlist } = buildAllowedCitationSet(params);

  // Defensive check: ensure attributions is an array
  const attributions = Array.isArray(output.attributions) ? output.attributions : [];
  const allAttributedCites = new Set(
    attributions
      .flatMap((a: SentenceAttribution) => Array.isArray(a.citations) ? a.citations : [])
      .map(normalizeCitationToken)
      .filter(Boolean)
  );

  // Check for orphan citations
  for (const cite of allCites) {
    const recid = stripInspirePrefix(cite);
    const hasAttribution =
      allAttributedCites.has(cite)
      || (recid !== cite && allAttributedCites.has(recid))
      || (looksLikeRecid(recid) && allAttributedCites.has(`inspire:${recid}`));

    if (!hasAttribution) {
      issues.push({
        type: 'orphan_citation',
        citation: cite,
        severity: 'error',
        message: `Citation ${cite} appears in text but not in any attribution`,
      });
    }
  }

  // Check for missing citations (factual sentences must have citations)
  let requiredSentenceCount = 0;
  for (const attr of attributions as SentenceAttribution[]) {
    if (!isCitationRequired(attr)) continue;
    requiredSentenceCount++;

    const cites = Array.isArray(attr.citations)
      ? attr.citations.map(normalizeCitationToken).filter(Boolean)
      : [];
    if (cites.length === 0) {
      issues.push({
        type: 'missing_citation',
        severity: 'error',
        sentence_index: attr.sentence_index,
        message: `Missing citation for factual sentence at index ${attr.sentence_index}`,
      });
    }
  }

  if (requiredSentenceCount > 0 && allCites.length === 0) {
    issues.push({
      type: 'missing_citation',
      severity: 'error',
      message: 'Content contains no \\cite{} commands, but attributions require citations for factual sentences',
    });
  }

  // Check for unauthorized citations (if allowlist is enforced)
  if (enforceAllowlist) {
    for (const cite of allCites) {
      const recid = stripInspirePrefix(cite);
      if (!allowedSet.has(cite) && !allowedSet.has(recid)) {
        issues.push({
          type: 'unauthorized_citation',
          citation: cite,
          severity: 'error',
          message: `Citation '${cite}' not in allowlist. Run hep_run_build_citation_mapping to rebuild.`,
        });
      }
    }

    for (const cite of allAttributedCites) {
      const recid = stripInspirePrefix(cite);
      if (!allowedSet.has(cite) && !allowedSet.has(recid)) {
        issues.push({
          type: 'unauthorized_citation',
          citation: cite,
          severity: 'error',
          message: `Citation '${cite}' not in allowlist. Run hep_run_build_citation_mapping to rebuild.`,
        });
      }
    }
  }

  // Check citation density (same cite repeated 3+ times per paragraph)
  const densityIssues = checkCitationDensity(content);
  issues.push(...densityIssues);

  const orphanCount = issues.filter(i => i.type === 'orphan_citation').length;
  const unauthorizedCount = issues.filter(i => i.type === 'unauthorized_citation').length;
  const missingCount = issues.filter(i => i.type === 'missing_citation').length;

  return {
    pass: issues.filter(i => i.severity === 'error').length === 0,
    issues,
    statistics: {
      total_citations: allCites.length,
      unique_citations: new Set(allCites).size,
      attributed_citations: allAttributedCites.size,
      unauthorized_count: unauthorizedCount,
      orphan_count: orphanCount,
      missing_count: missingCount,
    },
  };
}
