import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, getArtifactsDir } from './data/dataDir.js';

export const PDG_ARTIFACT_TTL_HOURS_ENV = 'PDG_ARTIFACT_TTL_HOURS';

const DEFAULT_PDG_ARTIFACT_TTL_HOURS = 24;

function parseTtlHoursFromEnv(): { ttlHours: number | null; source: 'default' | 'env' | 'disabled' | 'invalid' } {
  const raw = process.env[PDG_ARTIFACT_TTL_HOURS_ENV];
  if (raw === undefined) return { ttlHours: DEFAULT_PDG_ARTIFACT_TTL_HOURS, source: 'default' };

  const v = raw.trim().toLowerCase();
  if (v === '') return { ttlHours: DEFAULT_PDG_ARTIFACT_TTL_HOURS, source: 'default' };
  if (v === '0' || v === 'off' || v === 'false' || v === 'disable' || v === 'disabled') {
    return { ttlHours: null, source: 'disabled' };
  }

  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ttlHours: null, source: 'invalid' };
  if (n === 0) return { ttlHours: null, source: 'disabled' };

  return { ttlHours: n, source: 'env' };
}

export function cleanupOldPdgArtifacts(): {
  artifacts_dir: string;
  ttl_hours: number | null;
  ttl_source: 'default' | 'env' | 'disabled' | 'invalid';
  scanned_files: number;
  deleted_files: number;
} {
  const artifactsDir = getArtifactsDir();
  ensureDir(artifactsDir);

  const { ttlHours, source } = parseTtlHoursFromEnv();
  if (ttlHours === null) {
    return { artifacts_dir: artifactsDir, ttl_hours: null, ttl_source: source, scanned_files: 0, deleted_files: 0 };
  }

  const ttlMs = ttlHours * 60 * 60 * 1000;
  const now = Date.now();
  let scanned = 0;
  let deleted = 0;

  for (const entry of fs.readdirSync(artifactsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    scanned += 1;

    const filePath = path.join(artifactsDir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      const ageMs = now - stat.mtimeMs;
      if (ageMs <= ttlMs) continue;
      fs.rmSync(filePath, { force: true });
      deleted += 1;
    } catch {
      // ignore single-file errors; cleanup is best-effort
    }
  }

  return { artifacts_dir: artifactsDir, ttl_hours: ttlHours, ttl_source: source, scanned_files: scanned, deleted_files: deleted };
}
