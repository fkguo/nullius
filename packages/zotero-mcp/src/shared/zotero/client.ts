import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { notFound, upstreamError } from '@autoresearch/shared';

import { getZoteroConfig } from './config.js';

export interface ZoteroApiResponse<T> {
  data: T;
  meta: {
    url: string;
    status: number;
    total_results?: number;
  };
}

function buildZoteroUrl(pathname: string, query?: Record<string, string | number | boolean | undefined>): string {
  const { baseUrl } = getZoteroConfig();
  const url = new URL(baseUrl);

  // Zotero Local API endpoints live under `/api/` on the local HTTP server.
  // Tool callers pass paths as `/users/0/...`, mirroring the Web API URL shapes.
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  url.pathname = normalizedPath.startsWith('/api/') || normalizedPath === '/api' ? normalizedPath : `/api${normalizedPath}`;

  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }

  return url.toString();
}

function buildZoteroConnectorUrl(pathname: string, query?: Record<string, string | number | boolean | undefined>): string {
  const { baseUrl } = getZoteroConfig();
  const url = new URL(baseUrl);

  // Zotero Connector endpoints live at `/connector/*` and are not under `/api/`.
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  url.pathname = normalizedPath;

  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }

  return url.toString();
}

function parseTotalResults(res: Response): number | undefined {
  const raw = res.headers.get('Total-Results');
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

async function readErrorBody(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  } catch {
    return undefined;
  }
}

function isOutsideOf(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(parentDir, candidatePath);
  return relative === '..' || relative.startsWith(`..${path.sep}`);
}

function isPathInside(parentDir: string, candidatePath: string): boolean {
  const resolvedParent = path.resolve(parentDir);
  const resolvedCandidate = path.resolve(candidatePath);
  if (resolvedParent === resolvedCandidate) return true;
  if (isOutsideOf(resolvedParent, resolvedCandidate)) return false;
  return !path.isAbsolute(path.relative(resolvedParent, resolvedCandidate));
}

function isZoteroFileRedirectGuardEnabled(): boolean {
  const raw = process.env.ZOTERO_FILE_REDIRECT_GUARD;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  if (v === '' || v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return false;
}

function resolveZoteroDataDir(): string {
  const raw = process.env.ZOTERO_DATA_DIR;
  if (!raw || !raw.trim()) {
    return path.join(os.homedir(), 'Zotero');
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  if (trimmed === '~') {
    return os.homedir();
  }
  return trimmed;
}

function expandTilde(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  if (trimmed === '~') return os.homedir();
  return trimmed;
}

function parseAllowedFileRoots(): string[] {
  const raw = process.env.ZOTERO_FILE_REDIRECT_ALLOWED_ROOTS;
  if (!raw || !raw.trim()) return [];

  return raw
    .split(path.delimiter)
    .map(s => s.trim())
    .filter(Boolean)
    .map(expandTilde);
}

function realpathIfExists(p: string): string {
  if (!fs.existsSync(p)) return path.resolve(p);
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isFilePathAllowed(filePath: string, roots: string[]): boolean {
  const resolvedFile = path.resolve(filePath);
  const fileReal = realpathIfExists(resolvedFile);

  for (const root of roots) {
    if (!root.trim()) continue;
    const resolvedRoot = path.resolve(root);
    if (!isPathInside(resolvedRoot, resolvedFile)) continue;

    const rootReal = realpathIfExists(resolvedRoot);
    if (!isPathInside(rootReal, fileReal)) continue;
    return true;
  }

  return false;
}

function assertZoteroFileRedirectAllowed(params: {
  url: string;
  status: number;
  location: string;
  filePath: string;
}): void {
  if (!isZoteroFileRedirectGuardEnabled()) return;
  const allowedRoots = Array.from(new Set([resolveZoteroDataDir(), ...parseAllowedFileRoots()]));
  if (isFilePathAllowed(params.filePath, allowedRoots)) return;

  throw upstreamError('Zotero Local API file redirect path is outside allowed roots', {
    url: params.url,
    status: params.status,
    location: params.location,
    file_path: params.filePath,
    allowed_roots: allowedRoots,
    env: {
      guard: 'ZOTERO_FILE_REDIRECT_GUARD',
      allowlist: 'ZOTERO_FILE_REDIRECT_ALLOWED_ROOTS',
    },
  });
}

export async function zoteroGetJson<T>(
  pathname: string,
  query?: Record<string, string | number | boolean | undefined>
): Promise<ZoteroApiResponse<T>> {
  const url = buildZoteroUrl(pathname, query);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      redirect: 'manual',
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.cause) : undefined;
    throw upstreamError('Zotero Local API request failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
      cause,
    });
  }

  if (res.status >= 300 && res.status < 400) {
    throw upstreamError('Zotero Local API redirected unexpectedly', {
      url,
      status: res.status,
      location: res.headers.get('location'),
    });
  }
  if (res.status === 404) {
    throw notFound('Zotero resource not found', { url, status: res.status });
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw upstreamError('Zotero Local API request failed', {
      url,
      status: res.status,
      status_text: res.statusText,
      body,
    });
  }

  const data = (await res.json()) as T;
  return {
    data,
    meta: {
      url,
      status: res.status,
      total_results: parseTotalResults(res),
    },
  };
}

export async function zoteroGetText(
  pathname: string,
  query?: Record<string, string | number | boolean | undefined>
): Promise<ZoteroApiResponse<string> & { content_type: string | null }> {
  const url = buildZoteroUrl(pathname, query);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: '*/*',
      },
      redirect: 'manual',
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.cause) : undefined;
    throw upstreamError('Zotero Local API request failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
      cause,
    });
  }

  if (res.status >= 300 && res.status < 400) {
    throw upstreamError('Zotero Local API redirected unexpectedly', {
      url,
      status: res.status,
      location: res.headers.get('location'),
    });
  }
  if (res.status === 404) {
    throw notFound('Zotero resource not found', { url, status: res.status });
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw upstreamError('Zotero Local API request failed', {
      url,
      status: res.status,
      status_text: res.statusText,
      body,
    });
  }

  const data = await res.text();
  return {
    data,
    meta: {
      url,
      status: res.status,
      total_results: parseTotalResults(res),
    },
    content_type: res.headers.get('content-type'),
  };
}

export async function zoteroGetJsonAllow404<T>(
  pathname: string,
  query?: Record<string, string | number | boolean | undefined>
): Promise<ZoteroApiResponse<T> | { status: 404; meta: { url: string }; body?: string }> {
  const url = buildZoteroUrl(pathname, query);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      redirect: 'manual',
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.cause) : undefined;
    throw upstreamError('Zotero Local API request failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
      cause,
    });
  }

  if (res.status >= 300 && res.status < 400) {
    throw upstreamError('Zotero Local API redirected unexpectedly', {
      url,
      status: res.status,
      location: res.headers.get('location'),
    });
  }
  if (res.status === 404) {
    const body = await readErrorBody(res);
    return { status: 404, meta: { url }, body };
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw upstreamError('Zotero Local API request failed', {
      url,
      status: res.status,
      status_text: res.statusText,
      body,
    });
  }

  const data = (await res.json()) as T;
  return {
    data,
    meta: {
      url,
      status: res.status,
      total_results: parseTotalResults(res),
    },
  };
}

async function zoteroRequestJson<T>(params: {
  pathname: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string | undefined>;
}): Promise<ZoteroApiResponse<T>> {
  const url = buildZoteroUrl(params.pathname, params.query);

  let res: Response;
  try {
    res = await fetch(url, {
      method: params.method,
      headers: {
        Accept: 'application/json',
        ...(params.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...Object.fromEntries(Object.entries(params.headers ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>,
      },
      body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
      redirect: 'manual',
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.cause) : undefined;
    throw upstreamError('Zotero Local API request failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
      cause,
    });
  }

  if (res.status >= 300 && res.status < 400) {
    throw upstreamError('Zotero Local API redirected unexpectedly', {
      url,
      status: res.status,
      location: res.headers.get('location'),
    });
  }
  if (res.status === 404) {
    throw notFound('Zotero resource not found', { url, status: res.status });
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw upstreamError('Zotero Local API request failed', {
      url,
      status: res.status,
      status_text: res.statusText,
      body,
    });
  }

  const data = (await res.json()) as T;
  return {
    data,
    meta: {
      url,
      status: res.status,
      total_results: parseTotalResults(res),
    },
  };
}

export function zoteroPostJson<T>(
  pathname: string,
  body: unknown,
  query?: Record<string, string | number | boolean | undefined>,
  headers?: Record<string, string | undefined>
): Promise<ZoteroApiResponse<T>> {
  return zoteroRequestJson({ pathname, method: 'POST', query, body, headers });
}

export function zoteroPutJson<T>(
  pathname: string,
  body: unknown,
  query?: Record<string, string | number | boolean | undefined>,
  headers?: Record<string, string | undefined>
): Promise<ZoteroApiResponse<T>> {
  return zoteroRequestJson({ pathname, method: 'PUT', query, body, headers });
}

export function zoteroPatchJson<T>(
  pathname: string,
  body: unknown,
  query?: Record<string, string | number | boolean | undefined>,
  headers?: Record<string, string | undefined>
): Promise<ZoteroApiResponse<T>> {
  return zoteroRequestJson({ pathname, method: 'PATCH', query, body, headers });
}

export function zoteroDeleteJson<T>(
  pathname: string,
  query?: Record<string, string | number | boolean | undefined>,
  headers?: Record<string, string | undefined>
): Promise<ZoteroApiResponse<T>> {
  return zoteroRequestJson({ pathname, method: 'DELETE', query, headers });
}

async function zoteroRequestVoid(params: {
  pathname: string;
  method: 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string | undefined>;
}): Promise<{ meta: { url: string; status: number; total_results?: number } }> {
  const url = buildZoteroUrl(params.pathname, params.query);

  let res: Response;
  try {
    res = await fetch(url, {
      method: params.method,
      headers: {
        Accept: '*/*',
        ...Object.fromEntries(Object.entries(params.headers ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>,
      },
      redirect: 'manual',
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.cause) : undefined;
    throw upstreamError('Zotero Local API request failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
      cause,
    });
  }

  if (res.status >= 300 && res.status < 400) {
    throw upstreamError('Zotero Local API redirected unexpectedly', {
      url,
      status: res.status,
      location: res.headers.get('location'),
    });
  }
  if (res.status === 404) {
    throw notFound('Zotero resource not found', { url, status: res.status });
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw upstreamError('Zotero Local API request failed', {
      url,
      status: res.status,
      status_text: res.statusText,
      body,
    });
  }

  return {
    meta: {
      url,
      status: res.status,
      total_results: parseTotalResults(res),
    },
  };
}

export function zoteroDeleteVoid(
  pathname: string,
  query?: Record<string, string | number | boolean | undefined>,
  headers?: Record<string, string | undefined>
): Promise<{ meta: { url: string; status: number; total_results?: number } }> {
  return zoteroRequestVoid({ pathname, method: 'DELETE', query, headers });
}

async function zoteroConnectorRequestJson<T>(params: {
  pathname: string;
  method: 'POST';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string | undefined>;
}): Promise<ZoteroApiResponse<T>> {
  const url = buildZoteroConnectorUrl(params.pathname, params.query);

  let res: Response;
  try {
    res = await fetch(url, {
      method: params.method,
      headers: {
        Accept: 'application/json',
        ...(params.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...Object.fromEntries(Object.entries(params.headers ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>,
      },
      body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
      redirect: 'manual',
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.cause) : undefined;
    throw upstreamError('Zotero connector request failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
      cause,
    });
  }

  if (res.status >= 300 && res.status < 400) {
    throw upstreamError('Zotero connector redirected unexpectedly', {
      url,
      status: res.status,
      location: res.headers.get('location'),
    });
  }
  if (res.status === 404) {
    throw notFound('Zotero connector resource not found', { url, status: res.status });
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw upstreamError('Zotero connector request failed', {
      url,
      status: res.status,
      status_text: res.statusText,
      body,
    });
  }

  const data = (await res.json()) as T;
  return {
    data,
    meta: {
      url,
      status: res.status,
      total_results: parseTotalResults(res),
    },
  };
}

export function zoteroConnectorPostJson<T>(
  pathname: string,
  body: unknown,
  query?: Record<string, string | number | boolean | undefined>,
  headers?: Record<string, string | undefined>
): Promise<ZoteroApiResponse<T>> {
  return zoteroConnectorRequestJson({ pathname, method: 'POST', body, query, headers });
}

async function zoteroConnectorRequestVoid(params: {
  pathname: string;
  method: 'POST';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string | undefined>;
}): Promise<{ meta: { url: string; status: number } }> {
  const url = buildZoteroConnectorUrl(params.pathname, params.query);

  let res: Response;
  try {
    res = await fetch(url, {
      method: params.method,
      headers: {
        Accept: '*/*',
        ...(params.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...Object.fromEntries(Object.entries(params.headers ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>,
      },
      body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
      redirect: 'manual',
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.cause) : undefined;
    throw upstreamError('Zotero connector request failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
      cause,
    });
  }

  if (res.status >= 300 && res.status < 400) {
    throw upstreamError('Zotero connector redirected unexpectedly', {
      url,
      status: res.status,
      location: res.headers.get('location'),
    });
  }
  if (res.status === 404) {
    throw notFound('Zotero connector resource not found', { url, status: res.status });
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw upstreamError('Zotero connector request failed', {
      url,
      status: res.status,
      status_text: res.statusText,
      body,
    });
  }

  return {
    meta: {
      url,
      status: res.status,
    },
  };
}

export function zoteroConnectorPostVoid(
  pathname: string,
  body: unknown,
  query?: Record<string, string | number | boolean | undefined>,
  headers?: Record<string, string | undefined>
): Promise<{ meta: { url: string; status: number } }> {
  return zoteroConnectorRequestVoid({ pathname, method: 'POST', body, query, headers });
}

export type ZoteroBinaryResponse =
  | {
      kind: 'bytes';
      url: string;
      status: number;
      contentType: string | null;
      contentDisposition: string | null;
      bytes: Uint8Array;
    }
  | {
      kind: 'file';
      url: string;
      status: number;
      location: string;
      filePath: string;
    };

export async function zoteroGetBinary(
  pathname: string,
  query?: Record<string, string | number | boolean | undefined>
): Promise<ZoteroBinaryResponse> {
  const url = buildZoteroUrl(pathname, query);

  let res: Response;
  try {
    // Zotero Local API file endpoints return a 302 redirect to a `file://...` URL.
    // Node's fetch cannot follow `file:` redirects, so we handle redirects manually.
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: '*/*',
      },
      redirect: 'manual',
    });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.cause) : undefined;
    throw upstreamError('Zotero Local API request failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
      cause,
    });
  }

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) {
      throw upstreamError('Zotero Local API redirected without Location header', { url, status: res.status });
    }

    if (!location.startsWith('file:')) {
      throw upstreamError('Zotero Local API redirected to unsupported URL', { url, status: res.status, location });
    }

    let filePath: string;
    try {
      filePath = fileURLToPath(location);
    } catch (err) {
      throw upstreamError('Invalid Zotero file URL in redirect', {
        url,
        status: res.status,
        location,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    assertZoteroFileRedirectAllowed({
      url,
      status: res.status,
      location,
      filePath,
    });

    return {
      kind: 'file',
      url,
      status: res.status,
      location,
      filePath,
    };
  }

  if (res.status === 404) {
    throw notFound('Zotero resource not found', { url, status: res.status });
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw upstreamError('Zotero Local API request failed', {
      url,
      status: res.status,
      status_text: res.statusText,
      body,
    });
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    kind: 'bytes',
    url,
    status: res.status,
    contentType: res.headers.get('content-type'),
    contentDisposition: res.headers.get('content-disposition'),
    bytes,
  };
}
