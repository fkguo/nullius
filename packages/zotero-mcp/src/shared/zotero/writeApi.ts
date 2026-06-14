import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { invalidParams, upstreamError } from '@autoresearch/shared';

import { getZoteroConfig } from './config.js';

/**
 * Client for the zotero-inspire plugin write endpoint.
 *
 * Zotero's built-in Local API (`/api/...` on 127.0.0.1:23119) is GET-only: any
 * POST/PUT/DELETE is rejected with `400 "Endpoint does not support method"`. The
 * connector save endpoints can create bare items but cannot attach a local file
 * to an existing item, nor trash/erase items.
 *
 * The zotero-inspire plugin (>= 3.0.3) registers an authenticated POST endpoint
 * on the same connector server — `POST /connector/zinspireWrite` — that performs
 * the writes the native Local API cannot. This module is the typed client for it.
 *
 * Auth: every request carries an `x-zinspire-token` header. The token is the
 * plugin pref `extensions.zotero.inspiremeta.external_token`. We resolve it from
 * `ZOTERO_WRITE_TOKEN` (explicit override) or, failing that, by reading the
 * Zotero profile `prefs.js` directly (the MCP runs on the same machine).
 */

const WRITE_ENDPOINT_PATH = '/connector/zinspireWrite';
const TOKEN_PREF_KEY = 'extensions.zotero.inspiremeta.external_token';

export type ZoteroWriteOp = 'ping' | 'attach_file' | 'trash_item' | 'erase_item';

function buildConnectorUrl(pathname: string): string {
  const { baseUrl } = getZoteroConfig();
  const url = new URL(baseUrl);
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Candidate Zotero profile parent directories per platform. */
function zoteroProfileParents(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'Zotero', 'Profiles')];
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA && process.env.APPDATA.trim()
      ? process.env.APPDATA
      : path.join(home, 'AppData', 'Roaming');
    return [path.join(appData, 'Zotero', 'Zotero', 'Profiles')];
  }
  // Linux / other
  return [path.join(home, '.zotero', 'zotero')];
}

const TOKEN_RE = /user_pref\("extensions\.zotero\.inspiremeta\.external_token",\s*"([^"]+)"\)/;

/** Best-effort read of the external token from any Zotero profile's prefs.js. */
function readTokenFromPrefs(): string | undefined {
  for (const parent of zoteroProfileParents()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const prefsPath = path.join(parent, entry.name, 'prefs.js');
      let content: string;
      try {
        content = fs.readFileSync(prefsPath, 'utf8');
      } catch {
        continue;
      }
      const match = content.match(TOKEN_RE);
      if (match && match[1].trim()) {
        return match[1].trim();
      }
    }
  }
  return undefined;
}

let cachedToken: string | undefined;

/**
 * Resolve the zotero-inspire write token: `ZOTERO_WRITE_TOKEN` env first, then
 * the Zotero profile prefs.js. Throws a clear, actionable error if neither is
 * available (most often: plugin not installed / Zotero never run).
 */
export function resolveZoteroWriteToken(): string {
  const fromEnv = process.env.ZOTERO_WRITE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (cachedToken) return cachedToken;

  const fromPrefs = readTokenFromPrefs();
  if (fromPrefs) {
    cachedToken = fromPrefs;
    return fromPrefs;
  }

  throw invalidParams(
    'Zotero write token not found. Install the zotero-inspire plugin (>= 3.0.3) so it can register the write endpoint, make sure Zotero has run at least once, or set ZOTERO_WRITE_TOKEN explicitly.',
    { pref_key: TOKEN_PREF_KEY, env: 'ZOTERO_WRITE_TOKEN' }
  );
}

/** Reset the in-process token cache (testing/refresh). */
export function resetZoteroWriteTokenCache(): void {
  cachedToken = undefined;
}

export interface ZoteroWriteResponse {
  ok: boolean;
  op?: string;
  [key: string]: unknown;
}

/**
 * Send an authenticated write op to the zotero-inspire endpoint and return the
 * parsed JSON body. Maps the common failure modes (endpoint missing, bad token,
 * op error) to clear MCP errors so attachment/delete never fail silently.
 */
export async function zoteroInspireWrite<T extends ZoteroWriteResponse = ZoteroWriteResponse>(
  op: ZoteroWriteOp,
  body: Record<string, unknown> = {}
): Promise<T> {
  const token = resolveZoteroWriteToken();
  const url = buildConnectorUrl(WRITE_ENDPOINT_PATH);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-zinspire-token': token,
        'zotero-allowed-request': 'true',
      },
      body: JSON.stringify({ op, ...body }),
      redirect: 'manual',
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.cause) : undefined;
    throw upstreamError(
      'Zotero write endpoint request failed (is Zotero running with the zotero-inspire plugin >= 3.0.3?)',
      { url, op, error: err instanceof Error ? err.message : String(err), cause }
    );
  }

  if (res.status === 404) {
    throw upstreamError(
      'Zotero write endpoint not found (HTTP 404). Install/enable the zotero-inspire plugin (>= 3.0.3), which registers POST /connector/zinspireWrite, then restart Zotero.',
      { url, op, status: 404 }
    );
  }
  if (res.status === 403) {
    // The cached prefs-derived token may be stale (e.g. token rotated in Zotero);
    // drop it so the next call re-reads prefs.js instead of looping on 403.
    cachedToken = undefined;
    throw invalidParams(
      'Zotero write endpoint rejected the token (HTTP 403). Verify ZOTERO_WRITE_TOKEN or the zotero-inspire external_token pref matches the running Zotero.',
      { url, op }
    );
  }

  const text = await res.text();
  let json: T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    throw upstreamError('Zotero write endpoint returned a non-JSON response', {
      url,
      op,
      status: res.status,
      body: text.length > 500 ? `${text.slice(0, 500)}…` : text,
    });
  }

  if (!res.ok || json.ok === false) {
    throw upstreamError('Zotero write op failed', {
      url,
      op,
      status: res.status,
      code: typeof json.code === 'string' ? json.code : undefined,
      error: typeof json.error === 'string' ? json.error : undefined,
    });
  }

  return json;
}

export interface ZoteroWriteEndpointStatus {
  available: boolean;
  version?: string;
  capabilities?: string[];
  error?: string;
}

/**
 * Best-effort availability probe for the write endpoint. Never throws — returns
 * `{ available: false, error }` so callers (e.g. zotero_add preview) can warn
 * without failing the whole operation.
 */
export async function pingZoteroWriteEndpoint(): Promise<ZoteroWriteEndpointStatus> {
  try {
    const res = await zoteroInspireWrite('ping');
    return {
      available: true,
      version: typeof res.version === 'string' ? res.version : undefined,
      capabilities: Array.isArray(res.capabilities) ? (res.capabilities as string[]) : undefined,
    };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}
