import * as fs from 'node:fs';
import * as path from 'node:path';

/** Run-directory enumeration and the slug family stem — extracted from the
 *  traceability view so the run-index renderer shares ONE definition of
 *  "which run directories exist" and "which family a run id belongs to".
 *  Two definitions of either is how an index disagrees with the status
 *  surface about the same project. */

export const RUN_ROOTS = [path.join('artifacts', 'runs'), path.join('team', 'runs')] as const;

export type RunDirEntry = {
  run_id: string;
  /** Canonical location: artifacts/runs when present there, else team/runs. */
  canonical_root: string;
  mirrored: boolean;
};

export function listRunDirectories(projectRoot: string): RunDirEntry[] {
  const seen = new Map<string, RunDirEntry>();
  for (const relRoot of RUN_ROOTS) {
    const absRoot = path.join(projectRoot, relRoot);
    if (!fs.existsSync(absRoot)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const existing = seen.get(entry.name);
      if (existing) {
        // Same run id in both roots: ONE logical run; artifacts/runs is the
        // canonical location (it is scanned first), team/runs the mirror.
        existing.mirrored = true;
        continue;
      }
      seen.set(entry.name, { run_id: entry.name, canonical_root: relRoot, mirrored: false });
    }
  }
  // Code-point order, never localeCompare: downstream renders are
  // byte-compared for freshness, and locale collation differs across
  // machines' ICU data — identical state must render identical bytes.
  return [...seen.values()].sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0));
}

/** Slug stem family (first two hyphen-separated words of the slug, after
 *  stripping the date/milestone/round prefixes): a DISPLAY grouping of an
 *  exploratory chain's many one-off slugs into concept families.
 *  Heuristic, for orientation only; feeds no gate and no validity
 *  decision. */
const SLUG_STEM_FROM_ID = /^(?:\d{8}(?:T\d{6}Z)?)[-_.](?:m\d+-)?(?:r\d+-)?(.+?)(?:-r\d+)?$/;

export function slugFamilyOf(runId: string): string {
  const slug = SLUG_STEM_FROM_ID.exec(runId)?.[1] ?? runId;
  return slug.split('-').slice(0, 2).join('-');
}
