import fs from 'node:fs';
import path from 'node:path';

import { discoveryDir, searchLogPath } from './storage.js';

export const HEP_DISCOVERY_TTL_HOURS_ENV = 'HEP_DISCOVERY_TTL_HOURS';

const DEFAULT_TTL_HOURS = 24;

// Per-request discovery artifact filename pattern: discovery_<step>_<NNN>_v1.json
// where step ∈ {query_plan, query_reformulation, candidate_generation,
// canonical_papers, dedup, rerank} and NNN is the zero-padded request index.
// The append-only audit log `discovery_search_log_v1.jsonl` (no NNN suffix) is
// intentionally NOT a deletion target — it is the provenance trail.
const PER_REQUEST_ARTIFACT_RE = /^discovery_(?:query_plan|query_reformulation|candidate_generation|canonical_papers|dedup|rerank)_\d+_v1\.json$/;

export type DiscoveryTtlSource = 'default' | 'env' | 'disabled' | 'invalid';

export interface DiscoveryTtlResult {
  discovery_dir: string;
  ttl_hours: number | null;
  ttl_source: DiscoveryTtlSource;
  scanned_files: number;
  deleted_files: number;
  preserved_search_log: boolean;
}

function parseTtlHoursFromEnv(): { ttlHours: number | null; source: DiscoveryTtlSource } {
  const raw = process.env[HEP_DISCOVERY_TTL_HOURS_ENV];
  if (raw === undefined) return { ttlHours: DEFAULT_TTL_HOURS, source: 'default' };
  const v = raw.trim().toLowerCase();
  if (v === '') return { ttlHours: DEFAULT_TTL_HOURS, source: 'default' };
  if (v === '0' || v === 'off' || v === 'false' || v === 'disable' || v === 'disabled') {
    return { ttlHours: null, source: 'disabled' };
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ttlHours: null, source: 'invalid' };
  if (n === 0) return { ttlHours: null, source: 'disabled' };
  return { ttlHours: n, source: 'env' };
}

/**
 * Delete per-request discovery artifacts older than the configured TTL.
 *
 * Discovery writes 6 per-request JSON files per `hep_research_*` discovery
 * invocation (query_plan, query_reformulation, candidate_generation,
 * canonical_papers, dedup, rerank). Each is named
 * `discovery_<step>_<NNN>_v1.json` with NNN being the monotonic request index.
 * Without cleanup these files accumulate forever (the user audit found 949+
 * files on one machine). 24h is sufficient for "look up what just happened";
 * longer-term origin records live in the append-only `discovery_search_log_v1.jsonl`
 * which this cleanup deliberately preserves.
 *
 * Best-effort: ignores individual filesystem errors. Returns a summary the
 * caller can log.
 */
export function cleanupOldDiscoveryArtifacts(): DiscoveryTtlResult {
  const dir = discoveryDir();
  const { ttlHours, source } = parseTtlHoursFromEnv();

  if (!fs.existsSync(dir)) {
    return {
      discovery_dir: dir,
      ttl_hours: ttlHours,
      ttl_source: source,
      scanned_files: 0,
      deleted_files: 0,
      preserved_search_log: false,
    };
  }

  if (ttlHours === null) {
    return {
      discovery_dir: dir,
      ttl_hours: null,
      ttl_source: source,
      scanned_files: 0,
      deleted_files: 0,
      preserved_search_log: fs.existsSync(searchLogPath(dir)),
    };
  }

  const ttlMs = ttlHours * 60 * 60 * 1000;
  const now = Date.now();
  let scanned = 0;
  let deleted = 0;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!PER_REQUEST_ARTIFACT_RE.test(entry.name)) continue; // never touch the audit log
    scanned += 1;
    const filePath = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs <= ttlMs) continue;
      fs.rmSync(filePath, { force: true });
      deleted += 1;
    } catch {
      // best-effort; skip files we can't stat or delete
    }
  }

  return {
    discovery_dir: dir,
    ttl_hours: ttlHours,
    ttl_source: source,
    scanned_files: scanned,
    deleted_files: deleted,
    preserved_search_log: fs.existsSync(searchLogPath(dir)),
  };
}
