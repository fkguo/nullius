/**
 * importPaper — generic "agent already has the PDF locally" intake path.
 *
 * Inputs a canonical identifier (e.g. `doi:10.1103/X`, `manual:my-paper-2024`,
 * or even `arxiv:1234.5678v1` for offline-imported preprints) and an absolute
 * path to a local PDF. Copies the PDF into the Tier 3 cache under the
 * sha256(identifier) key and records `source_type: 'pdf'` in meta.json. The
 * tool deliberately does NOT know how the agent obtained the PDF — any user-
 * local skill or workflow (institutional access, hand download, etc.) is
 * outside hep-mcp's surface.
 *
 * Conflict policy when a cache entry already exists for the identifier:
 *   - default: refuse with `status: 'already_cached'`
 *   - overwrite=true: delete existing entry and re-materialize from the new PDF
 *
 * The overwrite path is the destructive case; the MCP tool wrapper enforces
 * `_confirm: true` on overwrite at the handler layer.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ARXIV_ID_REGEX } from '@autoresearch/arxiv-mcp/tooling';

import {
  type Fetcher,
  cacheEntryPaths,
  computeCacheKey,
  existsInCache,
  materializeCacheEntry,
  readMetaJson,
} from '../data/papersCache.js';

export const IMPORT_REPORT_SCHEMA_VERSION = 1 as const;

export type ImportStatus = 'imported' | 'already_cached' | 'overwritten' | 'rejected';

export interface ImportReport {
  schema_version: typeof IMPORT_REPORT_SCHEMA_VERSION;
  identifier: string;
  canonical_id: string;
  cache_key: string;
  cache_entry_dir: string;
  status: ImportStatus;
  reason: string;
  pdf_path?: string;
  pdf_sha256?: string;
  size_bytes?: number;
}

export interface ImportOptions {
  /** User-supplied identifier; will be canonicalized. */
  identifier: string;
  /** Absolute path to the local PDF to import. */
  pdf_path: string;
  /**
   * When true and an entry already exists for the identifier, the existing
   * entry is deleted and replaced by the supplied PDF. Default false: a
   * pre-existing entry causes status='already_cached' with no mutation.
   */
  overwrite?: boolean;
}

/**
 * Same canonicalization rule as migratePapersCache / prunePaperCache. Restricts
 * the schemes hep-mcp's dispatcher understands (arxiv/doi/inspire/zotero) so
 * downstream reads can route the same canonical id back into ensureInCache().
 * The dispatcher does not yet support a `manual:` scheme; if you have a PDF
 * with no canonical identifier upstream, use `doi:<doi>` for the published
 * version even when you sourced it locally.
 */
function canonicalizeIdentifier(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\s+/g, '');
  if (!trimmed) return null;
  if (trimmed.includes(':')) {
    const scheme = trimmed.slice(0, trimmed.indexOf(':')).toLowerCase();
    if (scheme === 'arxiv' || scheme === 'doi' || scheme === 'inspire' || scheme === 'zotero') {
      return trimmed;
    }
    return null;
  }
  // Order is load-bearing: ARXIV_ID_REGEX accepts legacy `hep-ph/9501234`,
  // which would also match the bare-DOI test `^10\.\d{4,9}\/` if the prefix
  // were `10.xxxx/`. Arxiv must be tested first so a legacy id like
  // `hep-ph/9501234` is not misclassified as DOI.
  if (ARXIV_ID_REGEX.test(trimmed)) return `arxiv:${trimmed}`;
  if (/^10\.\d{4,9}\//.test(trimmed)) return `doi:${trimmed}`;
  if (/^\d+$/.test(trimmed)) return `inspire:recid:${trimmed}`;
  return null;
}

function sha256OfFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export async function importPaper(opts: ImportOptions): Promise<ImportReport> {
  // 1. Canonicalize identifier.
  const canonicalId = canonicalizeIdentifier(opts.identifier);
  if (!canonicalId) {
    throw new Error(
      `importPaper: cannot canonicalize identifier ${JSON.stringify(opts.identifier)}. ` +
        `Use a URI-prefixed form: "arxiv:<id>", "doi:<doi>", "inspire:recid:<n>", "zotero:<lib>/<key>", or "manual:<your-id>".`,
    );
  }

  // 2. Validate pdf_path.
  if (!opts.pdf_path || !path.isAbsolute(opts.pdf_path)) {
    throw new Error(`importPaper: pdf_path must be an absolute path, got ${JSON.stringify(opts.pdf_path)}.`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(opts.pdf_path);
  } catch (err) {
    throw new Error(`importPaper: pdf_path not accessible: ${(err as Error).message}`);
  }
  if (!stat.isFile()) {
    throw new Error(`importPaper: pdf_path is not a regular file: ${opts.pdf_path}`);
  }

  const cacheKey = computeCacheKey(canonicalId);
  const entry = cacheEntryPaths(cacheKey);

  // 3. Conflict policy: refuse or overwrite when an entry already exists.
  if (existsInCache(canonicalId)) {
    if (!opts.overwrite) {
      const meta = readMetaJson(canonicalId);
      return {
        schema_version: IMPORT_REPORT_SCHEMA_VERSION,
        identifier: opts.identifier,
        canonical_id: canonicalId,
        cache_key: cacheKey,
        cache_entry_dir: entry.root,
        status: 'already_cached',
        reason:
          `cache already has an entry for ${canonicalId} (source_type=${meta?.source_type ?? 'unknown'}). ` +
          `Pass overwrite=true to replace it.`,
        pdf_path: opts.pdf_path,
      };
    }
    // overwrite=true: drop the existing entry first.
    //
    // This rm + materializeCacheEntry sequence is NOT atomic. A concurrent
    // reader can observe the cache missing the entry between the rmSync and
    // the materialize-then-rename. Two concurrent importers racing on the same
    // identifier with overwrite=true can also collide: materializeCacheEntry's
    // tmp-then-rename has its own EEXIST/ENOTEMPTY recovery, so the cache
    // never becomes inconsistent — but the "last writer wins" outcome is non-
    // deterministic. This is acceptable for a maintainer tool; if true atomic
    // overwrite is ever needed, push the policy down into papersCache.ts.
    fs.rmSync(entry.root, { recursive: true, force: true });
  }

  // 4. Materialize from the supplied PDF.
  const pdfSha256 = sha256OfFile(opts.pdf_path);
  const fetcher: Fetcher = async (tmpContentDir) => {
    const dstDir = path.join(tmpContentDir, 'pdf');
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(opts.pdf_path, path.join(dstDir, 'paper.pdf'));
    return {
      source_type: 'pdf',
      fetched_via: 'manual_import',
      main_path: 'pdf/paper.pdf',
      // imported_from is the caller-supplied path on the host that performed
      // the import (may be a symlink). It is recorded verbatim as audit data,
      // not for dedup — the content is already content-addressed by
      // content_sha256, and the entry by sha256(canonical_id). The paper-cache
      // is per-user, so this is not a multi-user PII concern.
      cross_refs: { imported_from: opts.pdf_path, content_sha256: pdfSha256 },
    };
  };
  await materializeCacheEntry(canonicalId, fetcher);

  return {
    schema_version: IMPORT_REPORT_SCHEMA_VERSION,
    identifier: opts.identifier,
    canonical_id: canonicalId,
    cache_key: cacheKey,
    cache_entry_dir: entry.root,
    status: opts.overwrite ? 'overwritten' : 'imported',
    reason:
      opts.overwrite
        ? `existing cache entry for ${canonicalId} replaced with PDF from ${opts.pdf_path} (sha256=${pdfSha256})`
        : `imported PDF (sha256=${pdfSha256}) into cache as ${canonicalId}`,
    pdf_path: opts.pdf_path,
    pdf_sha256: pdfSha256,
    size_bytes: stat.size,
  };
}

/**
 * Human-readable rendering for the CLI wrapper. Keeps shape stable enough for
 * tail-of-output assertions in the shell smoke tests.
 */
export function formatImportReport(r: ImportReport): string {
  const lines: string[] = [];
  lines.push(`hep_admin_import_paper — schema_version=${r.schema_version}`);
  lines.push(`  identifier   : ${r.identifier}`);
  lines.push(`  canonical_id : ${r.canonical_id}`);
  lines.push(`  cache_key    : ${r.cache_key}`);
  lines.push(`  cache_entry  : ${r.cache_entry_dir}`);
  lines.push(`  status       : ${r.status}`);
  if (r.pdf_sha256) lines.push(`  pdf_sha256   : ${r.pdf_sha256}`);
  if (typeof r.size_bytes === 'number') lines.push(`  size_bytes   : ${r.size_bytes}`);
  lines.push(`  reason       : ${r.reason}`);
  return lines.join('\n');
}
