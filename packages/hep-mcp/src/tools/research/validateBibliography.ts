/**
 * Validate Bibliography Tool
 * Optional usability-first bibliography audit + optional INSPIRE cross-check.
 */

import { extractBibliography } from './extractBibliography.js';
import {
  validateBibliography as validateAgainstInspire,
  type ValidationResult,
  isValidTexkey,
} from './latex/inspireValidator.js';
import type { BibEntry } from './latex/bibliographyExtractor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type BibliographyAuditScope = 'manual_only' | 'all';

export interface ValidateBibliographyParams {
  /** Paper identifier: recid, arXiv ID, or DOI */
  identifier: string;
  /** Scope for audit (default: manual_only) */
  scope?: BibliographyAuditScope;
  /** Check discrepancies when INSPIRE cross-check is enabled (default: true) */
  check_discrepancies?: boolean;
  /** Enable INSPIRE cross-check (default: false; usability-first mode only inspects locatability) */
  validate_against_inspire?: boolean;
  /** Enforce minimum locatability check (default: true) */
  require_locatable?: boolean;
  /** Maximum entries to audit (default: all) */
  max_entries?: number;
}

export interface BibliographyUsabilityWarning {
  key: string;
  level: 'warning';
  issue: 'missing_locator';
  message: string;
  locator: {
    has_doi: boolean;
    has_arxiv_id: boolean;
    has_journal_volume_pages: boolean;
  };
}

export interface ValidateBibliographyResult {
  /** Validation results for each entry (non-empty only when validate_against_inspire=true) */
  results: ValidationResult[];
  /** Summary statistics */
  summary: {
    total: number;
    matched: number;
    not_found: number;
    errors: number;
    with_discrepancies: number;
  };
  /** Match method breakdown */
  match_methods: Record<string, number>;
  /** Usability-first audit summary (non-blocking warnings) */
  usability: {
    scope: BibliographyAuditScope;
    checked_entries: number;
    skipped_inspire_managed: number;
    locatable: number;
    not_locatable: number;
    warnings: BibliographyUsabilityWarning[];
    policy: {
      quality_gate: 'none';
      note: string;
    };
  };
  /** Source file path */
  source_file: string;
  /** arXiv ID */
  arxiv_id: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hasJournalVolumePages(entry: BibEntry): boolean {
  return Boolean(
    entry.journal
    && String(entry.journal).trim().length > 0
    && entry.volume
    && String(entry.volume).trim().length > 0
    && entry.pages
    && String(entry.pages).trim().length > 0
  );
}

function isLocatable(entry: BibEntry): {
  pass: boolean;
  has_doi: boolean;
  has_arxiv_id: boolean;
  has_journal_volume_pages: boolean;
} {
  const hasDoi = Boolean(entry.doi && String(entry.doi).trim().length > 0);
  const hasArxiv = Boolean(entry.arxiv_id && String(entry.arxiv_id).trim().length > 0);
  const hasJvp = hasJournalVolumePages(entry);
  return {
    pass: hasDoi || hasArxiv || hasJvp,
    has_doi: hasDoi,
    has_arxiv_id: hasArxiv,
    has_journal_volume_pages: hasJvp,
  };
}

function isLikelyInspireManaged(entry: BibEntry): boolean {
  if (entry.inspire_recid && String(entry.inspire_recid).trim().length > 0) return true;
  return isValidTexkey(String(entry.key ?? '').trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function validateBibliography(
  params: ValidateBibliographyParams
): Promise<ValidateBibliographyResult> {
  const {
    identifier,
    scope = 'manual_only',
    check_discrepancies = true,
    validate_against_inspire = false,
    require_locatable = true,
    max_entries,
  } = params;

  const bibResult = await extractBibliography({ identifier });

  const scopeFilteredEntries = scope === 'manual_only'
    ? bibResult.entries.filter(entry => !isLikelyInspireManaged(entry))
    : bibResult.entries;

  const entriesToAudit = max_entries
    ? scopeFilteredEntries.slice(0, Math.max(0, Math.trunc(max_entries)))
    : scopeFilteredEntries;

  const inspireManaged = scope === 'manual_only'
    ? bibResult.entries.filter(isLikelyInspireManaged)
    : [];

  const warnings: BibliographyUsabilityWarning[] = [];
  let locatable = 0;
  let notLocatable = 0;

  for (const entry of entriesToAudit) {
    const locator = isLocatable(entry);
    if (locator.pass) {
      locatable += 1;
      continue;
    }

    notLocatable += 1;
    if (!require_locatable) continue;

    warnings.push({
      key: entry.key,
      level: 'warning',
      issue: 'missing_locator',
      message:
        `Manual bibliography entry '${entry.key}' is not locatable. Add DOI/arXiv, or journal+volume+pages.`,
      locator,
    });
  }

  const results = validate_against_inspire
    ? await validateAgainstInspire(entriesToAudit, {
        check_discrepancies,
      })
    : [];

  const matched = results.filter(r => r.status === 'matched').length;
  const notFound = results.filter(r => r.status === 'not_found').length;
  const errors = results.filter(r => r.status === 'error').length;
  const withDiscrepancies = results.filter(r => r.discrepancies?.length).length;

  const matchMethods: Record<string, number> = {};
  for (const r of results) {
    if (!r.match_method) continue;
    matchMethods[r.match_method] = (matchMethods[r.match_method] || 0) + 1;
  }

  return {
    results,
    summary: {
      total: validate_against_inspire ? results.length : entriesToAudit.length,
      matched,
      not_found: notFound,
      errors,
      with_discrepancies: withDiscrepancies,
    },
    match_methods: matchMethods,
    usability: {
      scope,
      checked_entries: entriesToAudit.length,
      skipped_inspire_managed: scope === 'manual_only' ? inspireManaged.length : 0,
      locatable,
      not_locatable: notLocatable,
      warnings,
      policy: {
        quality_gate: 'none',
        note: 'Usability-first audit only. Warnings do not block research conclusions.',
      },
    },
    source_file: bibResult.source_file,
    arxiv_id: bibResult.arxiv_id,
  };
}
