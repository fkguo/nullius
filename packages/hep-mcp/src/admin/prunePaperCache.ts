/**
 * prunePaperCache — find and delete cache entries no longer referenced by any
 * known project's paper.json catalog.
 *
 * The caller supplies one or more `project_roots` as the scan boundary: each
 * project's `<hep_data_root>/projects/<id>/papers/<paper_id>/paper.json` is
 * read and the union of canonical identifiers forms the "live set". Any cache
 * entry whose canonical_id is NOT in the live set is an orphan and eligible
 * for deletion.
 *
 * Cache entries WITHOUT a readable meta.json are NOT auto-deleted (treated as
 * `keep_unrecognized`) so a user can inspect / hand-clean. The dispatcher
 * preserves them by design.
 *
 * Tmp staging dirs (`<key>.tmp-<suffix>`) left by interrupted materializations
 * are explicitly cleaned with a separate action class, so the prune tool also
 * doubles as the "drop SIGKILL leftovers" sweep.
 *
 * Safety:
 *   - Dry-run by default; caller must pass apply=true (and, at the MCP layer,
 *     _confirm=true) for any filesystem mutation.
 *   - Empty `project_roots` list is rejected — without a scan boundary, every
 *     cache entry would be an orphan, which is almost certainly NOT what the
 *     caller wants.
 *   - Path containment guard: only delete entries under the resolved
 *     papers_cache root.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ARXIV_ID_REGEX } from '@autoresearch/arxiv-mcp/tooling';

import {
  cacheEntryPaths,
  computeCacheKey,
  getPapersCacheRoot,
} from '../data/papersCache.js';

export const PRUNE_REPORT_SCHEMA_VERSION = 1 as const;

export type PruneAction =
  | 'delete_orphan'
  | 'delete_tmp_staging'
  | 'keep_referenced'
  | 'keep_unrecognized';

export interface PrunePlan {
  cache_key: string;
  cache_entry_dir: string;
  canonical_id?: string;
  size_bytes: number;
  action: PruneAction;
  reason: string;
  referenced_by?: string[];
  applied?: boolean;
  error?: string;
}

export interface PruneSummary {
  total_cache_entries: number;
  total_orphans: number;
  total_referenced: number;
  total_unrecognized: number;
  total_tmp_staging: number;
  total_to_free_bytes: number;
}

export interface PruneReport {
  schema_version: typeof PRUNE_REPORT_SCHEMA_VERSION;
  project_roots: string[];
  cache_root: string;
  dry_run: boolean;
  plans: PrunePlan[];
  summary: PruneSummary;
}

export interface PruneOptions {
  project_roots: string[];
  /** Override <project_root>/artifacts/hep-mcp; applied per project_root if provided. */
  hep_data_root?: string;
  apply?: boolean;
}

/**
 * Same canonicalization logic as migratePapersCache so referenced sets match.
 * Defined locally (not imported) to avoid an admin↔admin import cycle.
 */
function canonicalizeIdentifier(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\s+/g, '');
  if (!trimmed) return null;
  if (trimmed.includes(':')) return trimmed;
  if (ARXIV_ID_REGEX.test(trimmed)) return `arxiv:${trimmed}`;
  if (/^10\.\d{4,9}\//.test(trimmed)) return `doi:${trimmed}`;
  if (/^\d+$/.test(trimmed)) return `inspire:recid:${trimmed}`;
  return null;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        // ignore
      }
    }
  }
  return total;
}

/**
 * For one project_root, walk paper.json files and extract canonical
 * identifiers. Returns the (canonical_id → project_root) reverse index.
 */
function collectProjectReferences(projectRoot: string, hepDataRoot: string): Map<string, string> {
  const refs = new Map<string, string>();
  const projectsDir = path.join(hepDataRoot, 'projects');
  if (!fs.existsSync(projectsDir)) return refs;
  for (const projectIdEntry of safeReaddir(projectsDir)) {
    if (!projectIdEntry.isDirectory()) continue;
    const papersDir = path.join(projectsDir, projectIdEntry.name, 'papers');
    if (!fs.existsSync(papersDir)) continue;
    for (const paperIdEntry of safeReaddir(papersDir)) {
      if (!paperIdEntry.isDirectory()) continue;
      const paperJsonPath = path.join(papersDir, paperIdEntry.name, 'paper.json');
      let raw: string;
      try {
        raw = fs.readFileSync(paperJsonPath, 'utf-8');
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const source = (parsed as Record<string, unknown>).source;
      const ident =
        source && typeof source === 'object'
          ? (source as Record<string, unknown>).identifier
          : (parsed as Record<string, unknown>).identifier;
      if (typeof ident !== 'string') continue;
      const canonical = canonicalizeIdentifier(ident);
      if (canonical) refs.set(canonical, projectRoot);
    }
  }
  return refs;
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Containment guard: the path MUST resolve under the resolved cacheRoot.
 * Used as a last-line defense against any future bug that produces an
 * unexpected entry path before we rmSync.
 */
function isWithin(parent: string, child: string): boolean {
  const p = path.resolve(parent) + path.sep;
  const c = path.resolve(child) + path.sep;
  return c.startsWith(p);
}

async function applyPlan(plan: PrunePlan, cacheRoot: string): Promise<void> {
  if (plan.action !== 'delete_orphan' && plan.action !== 'delete_tmp_staging') return;
  if (!isWithin(cacheRoot, plan.cache_entry_dir)) {
    throw new Error(`refusing to delete ${plan.cache_entry_dir}: not within cache root ${cacheRoot}`);
  }
  fs.rmSync(plan.cache_entry_dir, { recursive: true, force: true });
}

function computeSummary(plans: PrunePlan[]): PruneSummary {
  let total_orphans = 0;
  let total_referenced = 0;
  let total_unrecognized = 0;
  let total_tmp_staging = 0;
  let total_to_free_bytes = 0;
  for (const p of plans) {
    switch (p.action) {
      case 'delete_orphan':
        total_orphans += 1;
        total_to_free_bytes += p.size_bytes;
        break;
      case 'delete_tmp_staging':
        total_tmp_staging += 1;
        total_to_free_bytes += p.size_bytes;
        break;
      case 'keep_referenced':
        total_referenced += 1;
        break;
      case 'keep_unrecognized':
        total_unrecognized += 1;
        break;
    }
  }
  return {
    total_cache_entries: plans.length,
    total_orphans,
    total_referenced,
    total_unrecognized,
    total_tmp_staging,
    total_to_free_bytes,
  };
}

export async function prunePaperCache(opts: PruneOptions): Promise<PruneReport> {
  if (!Array.isArray(opts.project_roots) || opts.project_roots.length === 0) {
    throw new Error(
      'prunePaperCache: project_roots must include at least one absolute path. ' +
        'Calling with an empty list would mark every cache entry as orphan, which is almost certainly not what you want.',
    );
  }
  const projectRoots = opts.project_roots.map(r => path.resolve(r));
  const cacheRoot = getPapersCacheRoot();

  // 1. Build the live set of canonical identifiers across all supplied project roots.
  const referencedBy = new Map<string, Set<string>>(); // canonical_id → project_roots that reference it
  for (const projectRoot of projectRoots) {
    const hepDataRoot = opts.hep_data_root
      ? path.resolve(opts.hep_data_root)
      : path.join(projectRoot, 'artifacts', 'hep-mcp');
    const refs = collectProjectReferences(projectRoot, hepDataRoot);
    for (const [canonicalId, refRoot] of refs.entries()) {
      const existing = referencedBy.get(canonicalId);
      if (existing) existing.add(refRoot);
      else referencedBy.set(canonicalId, new Set([refRoot]));
    }
  }

  // 2. Enumerate cache root entries and classify.
  const plans: PrunePlan[] = [];
  if (fs.existsSync(cacheRoot)) {
    for (const entry of safeReaddir(cacheRoot)) {
      if (!entry.isDirectory()) continue;
      const entryDir = path.join(cacheRoot, entry.name);

      // tmp staging dirs follow the pattern <64hex>.tmp-<suffix>
      if (entry.name.includes('.tmp-')) {
        plans.push({
          cache_key: entry.name,
          cache_entry_dir: entryDir,
          size_bytes: dirSizeBytes(entryDir),
          action: 'delete_tmp_staging',
          reason: 'leftover staging dir from an interrupted materialization',
        });
        continue;
      }

      // Normal cache entry: 64-char lowercase hex.
      if (!/^[0-9a-f]{64}$/.test(entry.name)) {
        plans.push({
          cache_key: entry.name,
          cache_entry_dir: entryDir,
          size_bytes: dirSizeBytes(entryDir),
          action: 'keep_unrecognized',
          reason: 'entry name is not a 64-char lowercase hex; not a recognized cache key',
        });
        continue;
      }

      // Read meta.json directly via the cache key — we don't go through
      // readMetaJson() because that helper is keyed by canonical_id (which is
      // exactly what we're trying to recover from meta.json).
      const paths = cacheEntryPaths(entry.name);
      const size = dirSizeBytes(entryDir);
      let canonicalFromMeta: string | undefined;
      try {
        const raw = fs.readFileSync(paths.metaPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed.canonical_id === 'string') canonicalFromMeta = parsed.canonical_id;
      } catch {
        // unreadable / missing meta.json
      }

      if (!canonicalFromMeta) {
        plans.push({
          cache_key: entry.name,
          cache_entry_dir: entryDir,
          size_bytes: size,
          action: 'keep_unrecognized',
          reason: 'meta.json missing or unreadable; inspect manually before deleting',
        });
        continue;
      }

      // Verify meta.canonical_id hashes back to the directory name. If not,
      // the cache entry is corrupted/forged and we keep it for inspection.
      if (computeCacheKey(canonicalFromMeta) !== entry.name) {
        plans.push({
          cache_key: entry.name,
          cache_entry_dir: entryDir,
          size_bytes: size,
          canonical_id: canonicalFromMeta,
          action: 'keep_unrecognized',
          reason: 'meta.canonical_id does not hash to this directory name; possible corruption',
        });
        continue;
      }

      const refs = referencedBy.get(canonicalFromMeta);
      if (refs && refs.size > 0) {
        plans.push({
          cache_key: entry.name,
          cache_entry_dir: entryDir,
          size_bytes: size,
          canonical_id: canonicalFromMeta,
          action: 'keep_referenced',
          reason: `referenced by ${refs.size} project root(s)`,
          referenced_by: Array.from(refs).sort(),
        });
      } else {
        plans.push({
          cache_key: entry.name,
          cache_entry_dir: entryDir,
          size_bytes: size,
          canonical_id: canonicalFromMeta,
          action: 'delete_orphan',
          reason: 'no supplied project_root references this canonical_id',
        });
      }
    }
  }

  if (opts.apply) {
    for (const plan of plans) {
      if (plan.action === 'delete_orphan' || plan.action === 'delete_tmp_staging') {
        try {
          await applyPlan(plan, cacheRoot);
          plan.applied = true;
        } catch (err) {
          plan.applied = false;
          plan.error = (err as Error).message;
        }
      }
    }
  }

  return {
    schema_version: PRUNE_REPORT_SCHEMA_VERSION,
    project_roots: projectRoots,
    cache_root: cacheRoot,
    dry_run: !opts.apply,
    plans,
    summary: computeSummary(plans),
  };
}

export function formatPruneReport(report: PruneReport): string {
  const human = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  };
  const lines: string[] = [];
  lines.push(`${report.dry_run ? '[dry-run]' : '[applied]'} prune papers_cache at ${report.cache_root}`);
  lines.push(`scan boundary: ${report.project_roots.length} project_root(s)`);
  for (const p of report.project_roots) lines.push(`  · ${p}`);
  lines.push(
    `entries=${report.summary.total_cache_entries} orphan=${report.summary.total_orphans} ` +
      `referenced=${report.summary.total_referenced} unrecognized=${report.summary.total_unrecognized} ` +
      `tmp_staging=${report.summary.total_tmp_staging}`,
  );
  lines.push(`bytes to free: ${human(report.summary.total_to_free_bytes)}`);
  for (const p of report.plans) {
    const tag = p.applied === false ? '✗' : p.applied === true ? '✓' : '·';
    const id = p.canonical_id ?? '(no canonical_id)';
    const err = p.error ? ` err=${p.error}` : '';
    lines.push(`  ${tag} ${p.action.padEnd(22)} ${p.cache_key.slice(0, 12)}.. ${id} ${human(p.size_bytes)} — ${p.reason}${err}`);
  }
  return lines.join('\n');
}
