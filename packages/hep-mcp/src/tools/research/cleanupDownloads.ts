/**
 * Cleanup Downloads Tool
 * Cleans up downloaded LaTeX source files
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDownloadsDir } from '../../data/dataDir.js';
import { isMarkedDirectory } from '../../data/markers.js';

export interface CleanupDownloadsParams {
  /** Clean specific paper by arXiv ID */
  arxiv_id?: string;
  /** Clean files older than N hours (default: all) */
  older_than_hours?: number;
  /** Dry run mode - only report what would be deleted */
  dry_run?: boolean;
}

export interface CleanupDownloadsResult {
  deleted_count: number;
  freed_bytes: number;
  deleted_paths: string[];
  dry_run: boolean;
  skipped_unmarked: number;
}

export async function cleanupDownloads(params: CleanupDownloadsParams): Promise<CleanupDownloadsResult> {
  const { arxiv_id, older_than_hours, dry_run = false } = params;
  const baseDir = getDownloadsDir();

  const result: CleanupDownloadsResult = {
    deleted_count: 0,
    freed_bytes: 0,
    deleted_paths: [],
    dry_run,
    skipped_unmarked: 0,
  };

  // Find arxiv-* directories
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  const arxivDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('arxiv-'));

  for (const dir of arxivDirs) {
    const dirPath = path.join(baseDir, dir.name);
    if (!isMarkedDirectory(dirPath, 'download_dir')) {
      result.skipped_unmarked++;
      continue;
    }

    // Filter by arxiv_id if provided
    if (arxiv_id) {
      const normalizedId = arxiv_id.replace('/', '-');
      if (!dir.name.includes(normalizedId)) continue;
    }

    // Filter by age if provided
    if (older_than_hours !== undefined) {
      const stat = fs.statSync(dirPath);
      const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
      if (ageHours < older_than_hours) continue;
    }

    // Calculate size
    const size = getDirSize(dirPath);
    result.freed_bytes += size;
    result.deleted_paths.push(dirPath);
    result.deleted_count++;

    // Delete if not dry run
    if (!dry_run) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  }

  return result;
}

function getDirSize(dirPath: string): number {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += getDirSize(fullPath);
      } else {
        size += fs.statSync(fullPath).size;
      }
    }
  } catch {
    // Ignore errors
  }
  return size;
}
