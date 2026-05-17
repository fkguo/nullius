/**
 * papersCacheFetch — dispatcher that routes a paper identifier to the right
 * provider and populates the user-global Tier 3 cache (see papersCache.ts).
 *
 * Identifier scheme dispatch:
 *   arxiv:<id>[v<n>]       → in-process arxiv-mcp.getPaperContent
 *   inspire:recid:<n>      → INSPIRE lookup → resolves to arxiv → recurse
 *   doi:<doi>              → INSPIRE-by-DOI lookup → resolves to recid → recurse
 *                            (if INSPIRE has no record, throw a cache-miss error
 *                             and ask the agent to import a local PDF instead)
 *   zotero:<lib>/<key>     → in-process zotero-mcp tooling (Step 2; throws "not
 *                            yet implemented" stub for Step 1)
 *
 * This module deliberately does NOT know about DOI→PDF direct fetch. Any DOI
 * not resolvable via INSPIRE → arxiv must be supplied as a local PDF path by
 * the caller (typically the agent, using whatever skill it has available).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ARXIV_ID_REGEX } from '@autoresearch/arxiv-mcp/tooling';

import { getPaperContent } from '../utils/arxivCompat.js';
import { resolveArxivId } from '../utils/resolveArxivId.js';
import { inspireLookupByDOI } from '../tools/research/stance/resolver.js';
import {
  type Fetcher,
  type PaperFetchedVia,
  cacheEntryPaths,
  computeCacheKey,
  existsInCache,
  materializeCacheEntry,
  readMetaJson,
} from './papersCache.js';

// Anchored variant of arxiv-mcp's SSOT ARXIV_ID_REGEX with explicit capture
// groups for (bare_id, version). The SSOT regex already includes `^...$` and
// the sub-archive form `[a-z-]+(\.[a-z-]+)?` for legacy hep-ph/cond-mat ids.
const ARXIV_ID_WITH_VERSION_RE = /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(v\d+)?$/i;
const INSPIRE_RECID_RE = /^\d+$/;
const DOI_RE = /^10\.\d{4,9}\/[-._;()/:A-Z0-9]+$/i;
const ZOTERO_REF_RE = /^[^/]+\/[A-Z0-9]+$/i;

export type ParsedIdentifier =
  | { scheme: 'arxiv'; arxiv_id: string; version: string | null; raw: string }
  | { scheme: 'doi'; doi: string; raw: string }
  | { scheme: 'inspire'; recid: string; raw: string }
  | { scheme: 'zotero'; library: string; key: string; raw: string };

export class CacheMissError extends Error {
  public readonly canonical_id: string;
  public readonly reason: string;
  public readonly suggestion: string;
  constructor(canonical_id: string, reason: string, suggestion: string) {
    super(`cache miss for ${canonical_id}: ${reason}. ${suggestion}`);
    this.name = 'CacheMissError';
    this.canonical_id = canonical_id;
    this.reason = reason;
    this.suggestion = suggestion;
  }
}

/**
 * Parse an opaque identifier string into a structured form.
 *
 * Accepts the URI-style canonical forms emitted by hep-mcp tooling:
 *   "arxiv:2401.09012", "arxiv:2401.09012v3", "arxiv:hep-ph/9501234v2"
 *   "doi:10.1103/PhysRevD.108.052006"
 *   "inspire:recid:1234567"
 *   "zotero:<libraryID>/<itemKey>"
 */
export function parseCacheableIdentifier(input: string): ParsedIdentifier {
  if (!input || typeof input !== 'string') {
    throw new Error(`parseCacheableIdentifier: identifier must be a non-empty string, got ${JSON.stringify(input)}`);
  }
  const trimmed = input.trim();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx <= 0) {
    throw new Error(
      `parseCacheableIdentifier: missing scheme prefix in ${JSON.stringify(input)}. Expected one of "arxiv:", "doi:", "inspire:recid:", "zotero:".`,
    );
  }
  const scheme = trimmed.slice(0, colonIdx).toLowerCase();
  const value = trimmed.slice(colonIdx + 1);

  switch (scheme) {
    case 'arxiv': {
      // Use arxiv-mcp's SSOT ARXIV_ID_REGEX to validate (anchored already);
      // we use our local capture-group variant only for splitting version off.
      if (!ARXIV_ID_REGEX.test(value)) {
        throw new Error(`parseCacheableIdentifier: unrecognized arxiv id ${JSON.stringify(value)}`);
      }
      const m = ARXIV_ID_WITH_VERSION_RE.exec(value);
      if (!m) {
        // Shouldn't happen given the SSOT regex passed, but guard anyway.
        throw new Error(`parseCacheableIdentifier: arxiv id failed capture-group extraction for ${JSON.stringify(value)}`);
      }
      return { scheme: 'arxiv', arxiv_id: m[1]!, version: m[2] ?? null, raw: trimmed };
    }
    case 'doi': {
      if (!DOI_RE.test(value)) {
        throw new Error(`parseCacheableIdentifier: unrecognized doi ${JSON.stringify(value)}`);
      }
      return { scheme: 'doi', doi: value, raw: trimmed };
    }
    case 'inspire': {
      if (!value.startsWith('recid:')) {
        throw new Error(`parseCacheableIdentifier: inspire scheme requires "recid:" sub-prefix, got ${JSON.stringify(value)}`);
      }
      const recid = value.slice('recid:'.length);
      if (!INSPIRE_RECID_RE.test(recid)) {
        throw new Error(`parseCacheableIdentifier: inspire recid must be numeric, got ${JSON.stringify(recid)}`);
      }
      return { scheme: 'inspire', recid, raw: trimmed };
    }
    case 'zotero': {
      if (!ZOTERO_REF_RE.test(value)) {
        throw new Error(`parseCacheableIdentifier: zotero ref must be "<libraryID>/<itemKey>", got ${JSON.stringify(value)}`);
      }
      const slashIdx = value.indexOf('/');
      return { scheme: 'zotero', library: value.slice(0, slashIdx), key: value.slice(slashIdx + 1), raw: trimmed };
    }
    default:
      throw new Error(`parseCacheableIdentifier: unknown scheme ${JSON.stringify(scheme)} in ${JSON.stringify(input)}`);
  }
}

/**
 * Fetcher: arxiv. Calls arxiv-mcp's getPaperContent via the hep-mcp INSPIRE-
 * aware wrapper and reorganizes the output into the cache's content layout:
 *
 *   <tmpContentDir>/latex/extracted/<paper source tree>
 */
function buildArxivFetcher(parsed: ParsedIdentifier & { scheme: 'arxiv' }, fetchedVia: PaperFetchedVia): Fetcher {
  return async (tmpContentDir: string) => {
    const identifier = parsed.version ? `${parsed.arxiv_id}${parsed.version}` : parsed.arxiv_id;
    // arxiv-mcp writes to <output_dir>/arxiv-<id>/ with extracted source.
    const stagingDir = path.join(tmpContentDir, '.staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    const result = await getPaperContent({
      identifier,
      prefer: 'latex',
      extract: true,
      output_dir: stagingDir,
    });
    if (!result.success) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`arxiv fetch failed for ${identifier}: ${result.error ?? result.fallback_reason ?? 'unknown'}`);
    }
    if (result.source_type !== 'latex' || !result.main_tex) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`arxiv fetch for ${identifier} returned non-latex source (${result.source_type}); cache writer requires latex source.`);
    }
    // The arxiv-mcp staging contains an `arxiv-<id>/` subdir holding the
    // extracted tree. Legacy ids of the form `hep-ph/9501234` are stored by
    // arxiv-mcp as `arxiv-hep-ph-9501234/` (slash → dash) — see
    // packages/arxiv-mcp/src/source/paperContent.ts. Mirror that here.
    const arxivStagingName = `arxiv-${result.arxiv_id.replace('/', '-')}`;
    const arxivSubdir = path.join(stagingDir, arxivStagingName);
    const finalLatexDir = path.join(tmpContentDir, 'latex', 'extracted');
    fs.mkdirSync(path.dirname(finalLatexDir), { recursive: true });
    if (!fs.existsSync(arxivSubdir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`arxiv-mcp did not produce expected staging dir ${arxivSubdir}`);
    }
    // arxiv-mcp's `result.main_tex` is an ABSOLUTE path inside the staging
    // `arxiv-<id>/` dir (see packages/arxiv-mcp/src/source/paperContent.ts).
    // Compute its position relative to the staging dir BEFORE the rename, so
    // we can translate it to the cache-relative `latex/extracted/<rel>` form.
    const mainTexAbs = path.resolve(result.main_tex);
    const mainTexRelInExtracted = path.relative(arxivSubdir, mainTexAbs);
    if (mainTexRelInExtracted.startsWith('..') || path.isAbsolute(mainTexRelInExtracted)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(
        `arxiv-mcp main_tex ${mainTexAbs} is not inside the expected staging dir ${arxivSubdir}; cannot derive cache-relative main_path.`,
      );
    }
    fs.renameSync(arxivSubdir, finalLatexDir);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    const mainPathInCache = path.posix.join(
      'latex',
      'extracted',
      mainTexRelInExtracted.split(path.sep).join(path.posix.sep),
    );
    return {
      source_type: 'latex',
      fetched_via: fetchedVia,
      main_path: mainPathInCache,
      cross_refs: { arxiv: result.arxiv_id },
    };
  };
}

export interface EnsureInCacheResult {
  canonical_id: string;
  key: string;
  entry_root: string;
  cache_hit: boolean;
  source_type: 'latex' | 'pdf';
  meta_path: string;
  content_dir: string;
}

/**
 * High-level entry point: ensure the paper identified by `rawIdentifier` is
 * present in the cache, fetching it if necessary. Idempotent and concurrency-
 * safe (multiple processes racing on the same identifier converge).
 *
 * The returned `canonical_id` may differ from `rawIdentifier` in two cases:
 *   - INSPIRE recid resolved to arxiv: the result reports the arxiv canonical
 *     and `cross_refs.inspire_recid` is recorded in meta.json
 *   - DOI resolved to arxiv via INSPIRE: same; cross_refs.doi recorded
 *
 * The caller should use `canonical_id` for subsequent symlink construction so
 * downstream paths line up with the cache layout.
 */
export async function ensureInCache(rawIdentifier: string): Promise<EnsureInCacheResult> {
  const parsed = parseCacheableIdentifier(rawIdentifier);

  if (parsed.scheme === 'arxiv') {
    return ensureArxivInCache(parsed, /* fetchedVia */ 'arxiv', /* extraCrossRefs */ undefined);
  }

  if (parsed.scheme === 'inspire') {
    // Eagerly resolve recid → bare arxiv id so the cache canonical_id is the
    // arxiv form. This means two calls — one with `inspire:recid:X` and one
    // with the equivalent `arxiv:YYMM.NNNNN` — deduplicate to the same cache
    // entry. resolveArxivId accepts `inspire:N` (NOT `recid:N`).
    const arxivId = await resolveArxivId(`inspire:${parsed.recid}`);
    if (!arxivId) {
      throw new CacheMissError(
        parsed.raw,
        'INSPIRE record exists but has no associated arxiv preprint',
        'Provide a local PDF path via hep_admin_import_paper.',
      );
    }
    const arxivCanonical = parseCacheableIdentifier(`arxiv:${arxivId}`);
    if (arxivCanonical.scheme !== 'arxiv') {
      throw new Error(`internal: inspire resolution returned non-arxiv canonical ${arxivId}`);
    }
    return ensureArxivInCache(arxivCanonical, 'inspire-resolved-arxiv', { inspire_recid: parsed.recid });
  }

  if (parsed.scheme === 'doi') {
    const recid = await inspireLookupByDOI(parsed.doi);
    if (!recid) {
      throw new CacheMissError(
        parsed.raw,
        'INSPIRE has no record for this DOI and hep-mcp does not auto-fetch DOI PDFs',
        'Provide a local PDF path via hep_admin_import_paper, or use an arxiv:* / inspire:recid:* identifier if available.',
      );
    }
    const arxivId = await resolveArxivId(`inspire:${recid}`);
    if (!arxivId) {
      throw new CacheMissError(
        parsed.raw,
        `INSPIRE recid:${recid} exists for this DOI but has no associated arxiv preprint`,
        'Provide a local PDF path via hep_admin_import_paper.',
      );
    }
    const arxivCanonical = parseCacheableIdentifier(`arxiv:${arxivId}`);
    if (arxivCanonical.scheme !== 'arxiv') {
      throw new Error(`internal: doi→inspire→arxiv resolution returned non-arxiv canonical ${arxivId}`);
    }
    return ensureArxivInCache(arxivCanonical, 'inspire-resolved-arxiv', { inspire_recid: recid, doi: parsed.doi });
  }

  if (parsed.scheme === 'zotero') {
    throw new CacheMissError(
      parsed.raw,
      'zotero scheme is not yet wired into the cache dispatcher',
      'This is reserved for the Step 2 zotero integration; for now, supply the PDF via hep_admin_import_paper.',
    );
  }

  // Exhaustiveness check: if a new scheme is added to ParsedIdentifier, this
  // line forces a TS compile error here, prompting an `if (parsed.scheme === ...)`
  // branch above. We assign + reference to satisfy noUnusedLocals.
  const _exhaustive: never = parsed;
  throw new Error(`ensureInCache: unhandled scheme in ${rawIdentifier} (got ${String(_exhaustive)})`);
}

async function ensureArxivInCache(
  parsed: ParsedIdentifier & { scheme: 'arxiv' },
  fetchedVia: PaperFetchedVia,
  extraCrossRefs: Record<string, string> | undefined,
): Promise<EnsureInCacheResult> {
  const canonicalId = parsed.raw;
  // Fast path: cache hit (no network).
  if (existsInCache(canonicalId)) {
    const key = computeCacheKey(canonicalId);
    const paths = cacheEntryPaths(key);
    const meta = readMetaJson(canonicalId);
    return {
      canonical_id: canonicalId,
      key,
      entry_root: paths.root,
      cache_hit: true,
      source_type: meta?.source_type ?? 'latex',
      meta_path: paths.metaPath,
      content_dir: paths.contentDir,
    };
  }

  const fetcher = buildArxivFetcher(parsed, fetchedVia);
  const baseFetcher: Fetcher = async (tmpContentDir) => {
    const out = await fetcher(tmpContentDir);
    if (extraCrossRefs) {
      out.cross_refs = { ...(out.cross_refs ?? {}), ...extraCrossRefs };
    }
    return out;
  };

  const { key, entryRoot, alreadyExisted } = await materializeCacheEntry(canonicalId, baseFetcher);
  const paths = cacheEntryPaths(key);
  const meta = readMetaJson(canonicalId);
  return {
    canonical_id: canonicalId,
    key,
    entry_root: entryRoot,
    cache_hit: alreadyExisted,
    source_type: meta?.source_type ?? 'latex',
    meta_path: paths.metaPath,
    content_dir: paths.contentDir,
  };
}
