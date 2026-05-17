/**
 * migratePapersCache — convert pre-Step-2 per-project LaTeX `extracted/` real
 * directories into the Tier 3 global cache + project-local symlinks.
 *
 * Walks `<HEP_DATA_DIR>/projects/<project_id>/papers/<paper_id>/` for the
 * given project root, and for each paper whose `sources/latex/extracted/` is
 * a REAL directory (pre-cache build):
 *
 *   1. Read `paper.json` to recover the canonical identifier.
 *   2. Compute the cache key.
 *   3. If the cache already has the entry → `replace_with_symlink` (delete the
 *      real dir, create a symlink pointing into the cache).
 *   4. If the cache does NOT have the entry → `move_to_cache` (atomically move
 *      the real dir into the cache + write meta.json + symlink the project
 *      paper dir back).
 *
 * Papers whose `extracted/` is absent, a symlink (already migrated), or a
 * non-directory get classified `skip` and reported in the plan.
 *
 * Dry-run by default. Caller must pass `apply: true` for any filesystem-side-
 * effect. The function is safe to run concurrently with build_evidence in
 * principle (build_evidence detects existing real dirs → legacy_copy, so it
 * won't race with migration), but operationally we recommend quiescent runs.
 *
 * Identifier discovery falls back through a small probe list:
 *   paperJson.source.identifier  (the canonical field)
 *   paperJson.identifier         (older shape, just in case)
 *   the paper_id directory name itself (if it starts with `arxiv-`)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ARXIV_ID_REGEX } from '@autoresearch/arxiv-mcp/tooling';

import {
  type Fetcher,
  cacheEntryPaths,
  computeCacheKey,
  existsInCache,
  materializeCacheEntry,
} from '../data/papersCache.js';

export type MigrationAction =
  | 'move_to_cache'
  | 'replace_with_symlink'
  | 'skip_absent'
  | 'skip_symlink'
  | 'skip_other'
  | 'error_no_identifier'
  | 'error_unparseable_paper_json'
  | 'error_pdf_source';

export interface MigrationPlan {
  project_id: string;
  paper_id: string;
  paper_dir: string;
  extracted_dir: string;
  action: MigrationAction;
  reason: string;
  canonical_id?: string;
  cache_key?: string;
  cache_entry_dir?: string;
  size_bytes?: number;
  applied?: boolean;
  error?: string;
}

export interface MigrationSummary {
  total_papers_scanned: number;
  total_eligible: number; // move_to_cache + replace_with_symlink
  total_skipped: number;
  total_errors: number;
  total_freed_bytes: number; // sum of size_bytes for replace_with_symlink (we delete real dir; bytes go away)
  total_relocated_bytes: number; // sum of size_bytes for move_to_cache (bytes move into cache; not freed but deduplicated)
}

export const MIGRATION_REPORT_SCHEMA_VERSION = 1 as const;

export interface MigrationReport {
  schema_version: typeof MIGRATION_REPORT_SCHEMA_VERSION;
  project_root: string;
  hep_data_root: string;
  dry_run: boolean;
  plans: MigrationPlan[];
  summary: MigrationSummary;
}

export interface MigrationOptions {
  /** Absolute path to the autoresearch project root containing artifacts/hep-mcp/. */
  project_root: string;
  /** Override HEP_DATA_DIR resolution; defaults to <project_root>/artifacts/hep-mcp/. */
  hep_data_root?: string;
  /** Default false: emit plan only, no filesystem side effects. */
  apply?: boolean;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        // best-effort
      }
    }
  }
  return total;
}

/**
 * Identifier extraction from paper.json.
 *
 * We deliberately do NOT fall back to deriving an identifier from the paper_id
 * directory name. Production paperIds use the `arxiv_2401_09012v3` convention
 * (underscores, lossy because slashes and dots collide) per
 * core/evidence.ts:makePaperId, so reverse-engineering would be ambiguous for
 * legacy `cond-mat.stat-mech/9501234`-style identifiers. Real legacy projects
 * always carry a valid paper.json with `source.identifier`, so the fallback
 * would be both unreachable and ambiguous.
 *
 * Returns the canonical URI form (`arxiv:<id>`, `doi:<doi>`, etc.) or null.
 */
function recoverCanonicalIdentifier(paperJson: unknown): string | null {
  if (!paperJson || typeof paperJson !== 'object') return null;
  const pj = paperJson as Record<string, unknown>;
  const source = pj.source && typeof pj.source === 'object' ? (pj.source as Record<string, unknown>) : undefined;
  const fromSource = typeof source?.identifier === 'string' ? source.identifier : undefined;
  const fromTop = typeof pj.identifier === 'string' ? pj.identifier : undefined;
  const raw = fromSource ?? fromTop;
  if (!raw) return null;
  // Normalize whitespace (defense against hand-edited paper.json with
  // `arxiv: 2401.09012` form).
  const trimmed = raw.trim().replace(/\s+/g, '');
  if (!trimmed) return null;
  if (trimmed.includes(':')) return trimmed; // already URI-prefixed
  if (ARXIV_ID_REGEX.test(trimmed)) return `arxiv:${trimmed}`;
  if (/^10\.\d{4,9}\//.test(trimmed)) return `doi:${trimmed}`;
  if (/^\d+$/.test(trimmed)) return `inspire:recid:${trimmed}`;
  return null;
}

function readPaperJson(paperDir: string): { ok: true; data: unknown } | { ok: false; error: string } {
  const paperJsonPath = path.join(paperDir, 'paper.json');
  try {
    const raw = fs.readFileSync(paperJsonPath, 'utf-8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function buildPlan(opts: { project_id: string; paper_id: string; paper_dir: string }): MigrationPlan {
  const extracted_dir = path.join(opts.paper_dir, 'sources', 'latex', 'extracted');

  // Classify state of extracted_dir.
  let mode: 'absent' | 'symlink' | 'real-dir' | 'other' = 'absent';
  try {
    const lst = fs.lstatSync(extracted_dir);
    if (lst.isSymbolicLink()) mode = 'symlink';
    else if (lst.isDirectory()) mode = 'real-dir';
    else mode = 'other';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        project_id: opts.project_id,
        paper_id: opts.paper_id,
        paper_dir: opts.paper_dir,
        extracted_dir,
        action: 'skip_other',
        reason: `lstat failed: ${(err as Error).message}`,
      };
    }
  }

  if (mode === 'absent') {
    return {
      project_id: opts.project_id,
      paper_id: opts.paper_id,
      paper_dir: opts.paper_dir,
      extracted_dir,
      action: 'skip_absent',
      reason: 'sources/latex/extracted/ does not exist',
    };
  }
  if (mode === 'symlink') {
    return {
      project_id: opts.project_id,
      paper_id: opts.paper_id,
      paper_dir: opts.paper_dir,
      extracted_dir,
      action: 'skip_symlink',
      reason: 'already a symlink (likely already migrated or fresh build)',
    };
  }
  if (mode === 'other') {
    return {
      project_id: opts.project_id,
      paper_id: opts.paper_id,
      paper_dir: opts.paper_dir,
      extracted_dir,
      action: 'skip_other',
      reason: 'sources/latex/extracted/ exists but is neither symlink nor directory',
    };
  }

  // real-dir: read paper.json
  const paperJson = readPaperJson(opts.paper_dir);
  if (!paperJson.ok) {
    return {
      project_id: opts.project_id,
      paper_id: opts.paper_id,
      paper_dir: opts.paper_dir,
      extracted_dir,
      action: 'error_unparseable_paper_json',
      reason: `paper.json unreadable: ${paperJson.error}`,
    };
  }
  const sourceKind = ((paperJson.data as Record<string, unknown> | undefined)?.source as Record<string, unknown> | undefined)?.kind;
  if (sourceKind && sourceKind !== 'latex') {
    return {
      project_id: opts.project_id,
      paper_id: opts.paper_id,
      paper_dir: opts.paper_dir,
      extracted_dir,
      action: 'error_pdf_source',
      reason: `paper.json source.kind=${JSON.stringify(sourceKind)} is not 'latex'; migration tool handles latex only`,
    };
  }
  const canonical_id = recoverCanonicalIdentifier(paperJson.data);
  if (!canonical_id) {
    return {
      project_id: opts.project_id,
      paper_id: opts.paper_id,
      paper_dir: opts.paper_dir,
      extracted_dir,
      action: 'error_no_identifier',
      reason: 'could not recover canonical identifier from paper.json source.identifier or paper_id',
    };
  }
  const cache_key = computeCacheKey(canonical_id);
  const cache_entry_dir = cacheEntryPaths(cache_key).root;
  const action: MigrationAction = existsInCache(canonical_id) ? 'replace_with_symlink' : 'move_to_cache';
  const size_bytes = dirSizeBytes(extracted_dir);
  return {
    project_id: opts.project_id,
    paper_id: opts.paper_id,
    paper_dir: opts.paper_dir,
    extracted_dir,
    action,
    reason:
      action === 'replace_with_symlink'
        ? 'cache already has this paper; delete the real dir and create symlink'
        : 'move the real dir into the cache and create symlink',
    canonical_id,
    cache_key,
    cache_entry_dir,
    size_bytes,
  };
}

/**
 * Sanitize a paper.json-supplied relative path so it cannot escape the cache
 * (rejects absolute paths and `..` traversal). Returns the cleaned posix path,
 * or null if the input was unsafe / empty after cleaning.
 */
function safeRelMainTex(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject absolute paths (both posix and Windows-style).
  if (path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) return null;
  const parts = trimmed.replace(/\\/g, '/').split('/').filter(p => p !== '' && p !== '.');
  if (parts.some(p => p === '..')) return null;
  if (parts.length === 0) return null;
  return parts.join('/');
}

function recoverMainPath(extractedDir: string, paperJson: unknown): string {
  // Try to recover the main.tex relative path from paper.json's source.main_tex.
  if (paperJson && typeof paperJson === 'object') {
    const source = (paperJson as Record<string, unknown>).source;
    if (source && typeof source === 'object') {
      const mainTex = (source as Record<string, unknown>).main_tex;
      if (typeof mainTex === 'string') {
        const safe = safeRelMainTex(mainTex);
        if (safe) {
          return path.posix.join('latex', 'extracted', safe);
        }
        // Unsafe path falls through to probe fallback; we never silently honor
        // an absolute or .. -laden hand-edited paper.json entry.
      }
    }
  }
  // Fallback: probe common names in extractedDir.
  for (const candidate of ['main.tex', 'paper.tex', 'manuscript.tex']) {
    if (fs.existsSync(path.join(extractedDir, candidate))) {
      return path.posix.join('latex', 'extracted', candidate);
    }
  }
  // Last resort: pick the first .tex file at the top level.
  try {
    for (const entry of fs.readdirSync(extractedDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.tex')) {
        return path.posix.join('latex', 'extracted', entry.name);
      }
    }
  } catch {
    // ignore
  }
  return path.posix.join('latex', 'extracted', 'main.tex'); // best guess; let downstream fail loudly if wrong
}

async function applyPlan(plan: MigrationPlan): Promise<void> {
  if (plan.action !== 'move_to_cache' && plan.action !== 'replace_with_symlink') return;
  if (!plan.canonical_id || !plan.cache_key) {
    throw new Error(`applyPlan: plan ${plan.paper_id} missing canonical_id/cache_key`);
  }

  if (plan.action === 'replace_with_symlink') {
    // Cache already has the entry. Remove the real dir and create the symlink.
    const targetEntry = cacheEntryPaths(plan.cache_key);
    const cacheLatexExtracted = path.join(targetEntry.contentDir, 'latex', 'extracted');
    fs.rmSync(plan.extracted_dir, { recursive: true, force: true });
    fs.symlinkSync(cacheLatexExtracted, plan.extracted_dir);
    return;
  }

  // move_to_cache: stage the cache entry by COPYING the real dir contents into
  // a tmp cache slot, then atomic-rename into the final cache key. Don't move-
  // rename the real dir directly across filesystems (rename would EXDEV). After
  // the cache is committed, swap the real dir for a symlink.
  const paperJsonProbe = readPaperJson(plan.paper_dir);
  const mainPathInCache = recoverMainPath(plan.extracted_dir, paperJsonProbe.ok ? paperJsonProbe.data : undefined);

  const fetcher: Fetcher = async (tmpContentDir) => {
    // Copy plan.extracted_dir → tmpContentDir/latex/extracted/
    const destLatexExtracted = path.join(tmpContentDir, 'latex', 'extracted');
    fs.mkdirSync(path.dirname(destLatexExtracted), { recursive: true });
    fs.cpSync(plan.extracted_dir, destLatexExtracted, { recursive: true, dereference: false, errorOnExist: false });
    return {
      source_type: 'latex',
      fetched_via: 'manual_import', // migration is a form of pre-known-content import
      main_path: mainPathInCache,
      cross_refs: { migrated_from: plan.extracted_dir, migrated_at: new Date().toISOString() },
    };
  };

  await materializeCacheEntry(plan.canonical_id, fetcher);

  // Now swap real dir → symlink.
  const targetEntry = cacheEntryPaths(plan.cache_key);
  const cacheLatexExtracted = path.join(targetEntry.contentDir, 'latex', 'extracted');
  fs.rmSync(plan.extracted_dir, { recursive: true, force: true });
  fs.symlinkSync(cacheLatexExtracted, plan.extracted_dir);
}

function computeSummary(plans: MigrationPlan[]): MigrationSummary {
  let total_eligible = 0;
  let total_skipped = 0;
  let total_errors = 0;
  let total_freed_bytes = 0;
  let total_relocated_bytes = 0;
  for (const p of plans) {
    switch (p.action) {
      case 'move_to_cache':
        total_eligible += 1;
        total_relocated_bytes += p.size_bytes ?? 0;
        break;
      case 'replace_with_symlink':
        total_eligible += 1;
        total_freed_bytes += p.size_bytes ?? 0;
        break;
      case 'skip_absent':
      case 'skip_symlink':
      case 'skip_other':
        total_skipped += 1;
        break;
      default:
        total_errors += 1;
        break;
    }
  }
  return {
    total_papers_scanned: plans.length,
    total_eligible,
    total_skipped,
    total_errors,
    total_freed_bytes,
    total_relocated_bytes,
  };
}

export async function migratePapersCache(opts: MigrationOptions): Promise<MigrationReport> {
  const projectRoot = path.resolve(opts.project_root);
  const hepDataRoot = opts.hep_data_root
    ? path.resolve(opts.hep_data_root)
    : path.join(projectRoot, 'artifacts', 'hep-mcp');
  const projectsDir = path.join(hepDataRoot, 'projects');

  const plans: MigrationPlan[] = [];

  if (!fs.existsSync(projectsDir)) {
    return {
      schema_version: MIGRATION_REPORT_SCHEMA_VERSION,
      project_root: projectRoot,
      hep_data_root: hepDataRoot,
      dry_run: !opts.apply,
      plans,
      summary: computeSummary(plans),
    };
  }

  for (const projectIdEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectIdEntry.isDirectory()) continue;
    const projectId = projectIdEntry.name;
    const papersDir = path.join(projectsDir, projectId, 'papers');
    if (!fs.existsSync(papersDir)) continue;
    for (const paperIdEntry of fs.readdirSync(papersDir, { withFileTypes: true })) {
      if (!paperIdEntry.isDirectory()) continue;
      const paperId = paperIdEntry.name;
      const paperDir = path.join(papersDir, paperId);
      plans.push(buildPlan({ project_id: projectId, paper_id: paperId, paper_dir: paperDir }));
    }
  }

  if (opts.apply) {
    for (const plan of plans) {
      if (plan.action === 'move_to_cache' || plan.action === 'replace_with_symlink') {
        try {
          await applyPlan(plan);
          plan.applied = true;
        } catch (err) {
          plan.applied = false;
          plan.error = (err as Error).message;
        }
      }
    }
  }

  return {
    schema_version: MIGRATION_REPORT_SCHEMA_VERSION,
    project_root: projectRoot,
    hep_data_root: hepDataRoot,
    dry_run: !opts.apply,
    plans,
    summary: computeSummary(plans),
  };
}

/**
 * Format a MigrationReport for human-readable output (used by the CLI wrapper
 * and the MCP tool when caller asks for `format: 'text'`).
 */
export function formatMigrationReport(report: MigrationReport): string {
  const { summary } = report;
  const human = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  };
  const lines: string[] = [];
  lines.push(`${report.dry_run ? '[dry-run]' : '[applied]'} migrate papers_cache for ${report.project_root}`);
  lines.push(`HEP_DATA_DIR: ${report.hep_data_root}`);
  lines.push(`scanned=${summary.total_papers_scanned} eligible=${summary.total_eligible} skipped=${summary.total_skipped} errors=${summary.total_errors}`);
  lines.push(`bytes: freed=${human(summary.total_freed_bytes)} relocated=${human(summary.total_relocated_bytes)}`);
  for (const p of report.plans) {
    const tag = p.applied === false ? '✗' : p.applied === true ? '✓' : '·';
    const id = p.canonical_id ?? '(no id)';
    const size = p.size_bytes !== undefined ? ` ${human(p.size_bytes)}` : '';
    const err = p.error ? ` err=${p.error}` : '';
    lines.push(`  ${tag} ${p.action.padEnd(22)} ${p.project_id}/${p.paper_id} ${id}${size} — ${p.reason}${err}`);
  }
  return lines.join('\n');
}

