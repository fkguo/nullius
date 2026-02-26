import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

import { INSPIRE_API_URL } from '@autoresearch/shared';

import { getDataDir, getDownloadsDir } from '../../data/dataDir.js';
import { getToolUsageSnapshot } from './toolUsageTelemetry.js';
import { getTools, type ToolExposureMode } from '../registry.js';

export interface HepHealthParams {
  check_inspire: boolean;
  inspire_timeout_ms: number;
}

export interface HepHealthResult {
  ok: boolean;
  tool_catalog_hash: string;
  server: {
    name: string;
    version: string;
    node: string;
    platform: NodeJS.Platform;
    arch: string;
    pid: number;
    uptime_ms: number;
    now: string;
  };
  config: {
    tool_mode: 'standard' | 'full';
    hep_data_dir: { path: string; writable: boolean };
    downloads_dir: { path: string; writable: boolean };
    zotero: { enabled: boolean; base_url: string };
    pdg: { configured: boolean; db_path: string | null; data_dir: string; artifacts_dir: string };
  };
  telemetry: {
    enabled: boolean;
    started_at: string;
    total_calls: number;
    unique_tools: number;
    by_tool: Array<{ tool: string; calls: number; last_called_at: string }>;
  };
  inspire: {
    api_base: string;
    checked: boolean;
    ok?: boolean;
    latency_ms?: number;
    status?: number;
    error?: string;
  };
}

function isWritableDir(dirPath: string): boolean {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    const stat = fs.statSync(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function parseToolModeFromEnv(): 'standard' | 'full' {
  const raw = process.env.HEP_TOOL_MODE;
  if (raw === undefined) return 'standard';
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'standard') return 'standard';
  if (v === 'full') return 'full';
  // Server startup should have already validated this, but keep health robust.
  return 'standard';
}

function expandTilde(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function getPdgDataDir(): string {
  const explicit = process.env.PDG_DATA_DIR;
  if (explicit && explicit.trim().length > 0) {
    return path.resolve(expandTilde(explicit));
  }

  const hepDataDir = process.env.HEP_DATA_DIR;
  if (hepDataDir && hepDataDir.trim().length > 0) {
    return path.resolve(path.join(expandTilde(hepDataDir), 'pdg'));
  }

  return path.resolve(path.join(os.homedir(), '.hep-mcp', 'pdg'));
}

function getPdgArtifactsDir(): string {
  return path.join(getPdgDataDir(), 'artifacts');
}

function parseZoteroEnabledFromEnv(): boolean {
  const raw = process.env.HEP_ENABLE_ZOTERO;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === '') return true;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  // Server startup should have already validated this, but keep health robust.
  return true;
}

function readPackageInfo(): { name: string; version: string } {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, '..', '..', '..', 'package.json');
    const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as any;
    const name = typeof raw?.name === 'string' ? raw.name : 'hep-mcp';
    const version = typeof raw?.version === 'string' ? raw.version : '0.0.0';
    return { name, version };
  } catch {
    return { name: 'hep-mcp', version: '0.0.0' };
  }
}

async function checkInspire(params: { timeoutMs: number }): Promise<{ ok: boolean; latency_ms: number; status?: number; error?: string }> {
  const url = `${INSPIRE_API_URL}/literature?q=${encodeURIComponent('topcite:1+')}&size=1`;
  const controller = new AbortController();
  const started = Date.now();
  const timeout = setTimeout(() => controller.abort(), Math.max(100, params.timeoutMs));

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
      },
    });

    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { ok: false, latency_ms: latencyMs, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, latency_ms: latencyMs, status: res.status };
  } catch (err) {
    const latencyMs = Date.now() - started;
    return { ok: false, latency_ms: latencyMs, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compute SHA-256 hash of sorted tool names for the given exposure mode (H-17).
 * Stable across restarts as long as the tool registry is unchanged.
 */
export function computeToolCatalogHash(mode: ToolExposureMode = 'standard'): string {
  const names = getTools(mode).map(t => t.name).sort();
  return createHash('sha256').update(names.join('\n')).digest('hex');
}

export async function getHepHealth(params: HepHealthParams): Promise<HepHealthResult> {
  const pkg = readPackageInfo();

  const hepDataDir = getDataDir();
  const downloadsDir = getDownloadsDir();
  const hepDataWritable = isWritableDir(hepDataDir);
  const downloadsWritable = isWritableDir(downloadsDir);

  const pdgDataDir = getPdgDataDir();
  const pdgArtifactsDir = getPdgArtifactsDir();
  const pdgDbPathRaw = process.env.PDG_DB_PATH;
  const pdgDbPath = typeof pdgDbPathRaw === 'string' && pdgDbPathRaw.trim().length > 0 ? pdgDbPathRaw.trim() : null;
  const pdgConfigured = Boolean(pdgDbPath && fs.existsSync(pdgDbPath));

  const inspire = params.check_inspire
    ? await checkInspire({ timeoutMs: params.inspire_timeout_ms })
    : null;

  const ok = hepDataWritable && downloadsWritable && (!inspire || inspire.ok);
  const telemetry = getToolUsageSnapshot({ top_n: 50 });

  return {
    ok,
    tool_catalog_hash: computeToolCatalogHash(parseToolModeFromEnv()),
    server: {
      name: pkg.name,
      version: pkg.version,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptime_ms: Math.round(process.uptime() * 1000),
      now: new Date().toISOString(),
    },
    config: {
      tool_mode: parseToolModeFromEnv(),
      hep_data_dir: { path: hepDataDir, writable: hepDataWritable },
      downloads_dir: { path: downloadsDir, writable: downloadsWritable },
      zotero: {
        enabled: parseZoteroEnabledFromEnv(),
        base_url: process.env.ZOTERO_BASE_URL?.trim() || 'http://127.0.0.1:23119',
      },
      pdg: {
        configured: pdgConfigured,
        db_path: pdgDbPath,
        data_dir: pdgDataDir,
        artifacts_dir: pdgArtifactsDir,
      },
    },
    telemetry,
    inspire: inspire
      ? {
          api_base: INSPIRE_API_URL,
          checked: true,
          ok: inspire.ok,
          latency_ms: inspire.latency_ms,
          status: inspire.status,
          error: inspire.error,
        }
      : {
          api_base: INSPIRE_API_URL,
          checked: false,
        },
  };
}

