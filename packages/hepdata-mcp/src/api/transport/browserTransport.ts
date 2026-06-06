/**
 * Browser-backed fallback transport for the HEPData fetch layer.
 *
 * When a plain HTTP request is met with a Cloudflare Managed Challenge (see
 * `challengeDetect.ts`), the *same* request can be retried through a real
 * headless browser (Playwright/Chromium) whose JS engine solves the challenge.
 * The browser returns the final page status/headers/body, which the rate
 * limiter wraps into a synthetic `Response` so the rest of the code is unchanged.
 *
 * Everything here is CONFINED TO THE FETCH LAYER. No caller knows a browser was
 * involved.
 *
 * Design constraints honored:
 *   - `playwright` is an OPTIONAL peer dependency. It is loaded via a dynamic
 *     `import('playwright')` typed loosely as `any`, so this package builds and
 *     runs WITHOUT playwright (or its Chromium) installed. The dependency is
 *     only touched when `HEPDATA_BROWSER_FETCH` is opted in AND a challenge is hit.
 *   - The solver is INJECTABLE (module-level setter) so unit tests substitute a
 *     mock and never launch a real browser or hit the network.
 *   - Only `www.hepdata.net` URLs may be navigated (host assertion).
 */

import os from 'node:os';
import path from 'node:path';
import { upstreamError } from '@autoresearch/shared';
import { isCloudflareChallenge } from './challengeDetect.js';
import { type CachedResponse, defaultUrlCache, type UrlCache } from './urlCache.js';

/** The only host the browser transport is permitted to navigate to. */
const HEPDATA_ALLOWED_HOST = 'www.hepdata.net';

/** Default budget for the whole browser solve (launch + navigate + clear poll). */
const DEFAULT_SOLVE_TIMEOUT_MS = 60_000;

/** Confined Chromium profile dir; persists cf_clearance cookie within a process. */
const USER_DATA_DIR = path.join(os.tmpdir(), 'hep-mcp-cf-profile');

/**
 * Dynamically load `playwright` WITHOUT a compile-time module dependency.
 *
 * `playwright` is an OPTIONAL peer dep — the default install does not contain
 * it. A bare `import('playwright')` string literal is still resolved by `tsc`
 * under `module: NodeNext` and fails the build when the package is absent
 * (TS2307). Routing the specifier through a runtime-built variable makes the
 * import opaque to the type checker, so the package compiles with or without
 * playwright present; resolution happens purely at runtime, where a missing
 * module surfaces as a caught error (→ PlaywrightUnavailableError).
 *
 * Indirected via a mutable hook so tests can simulate an import failure without
 * uninstalling the package.
 */
function defaultImportPlaywright(): Promise<unknown> {
  // Built at runtime so the literal never reaches the module resolver.
  const specifier = ['play', 'wright'].join('');
  return import(/* @vite-ignore */ specifier);
}

let importPlaywrightImpl: () => Promise<unknown> = defaultImportPlaywright;

function importPlaywright(): Promise<unknown> {
  return importPlaywrightImpl();
}

/**
 * Override the playwright dynamic-import hook (tests inject a failing or stub
 * importer). Pass nothing to restore the real dynamic import.
 */
export function setPlaywrightImporter(fn?: () => Promise<unknown>): void {
  importPlaywrightImpl = fn ?? defaultImportPlaywright;
}

/**
 * Result of a browser solve: the final response observed after the challenge
 * cleared. `body` is the page text (HEPData JSON endpoints render the JSON as
 * the document body once the challenge is passed).
 */
export interface BrowserSolveResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Options handed to a solver for a single navigation. */
export interface BrowserSolveOptions {
  /** Upstream proxy server (e.g. `http://127.0.0.1:7890`), or undefined for direct. */
  proxy?: string;
  /** Persistent Chromium profile directory (confined, under the OS temp dir). */
  userDataDir: string;
  /** Overall solve budget in milliseconds. */
  timeoutMs: number;
}

/**
 * A pluggable browser backend. The default is `PlaywrightSolver`; tests inject a
 * mock implementing this interface.
 */
export interface BrowserSolver {
  solve(url: string, opts: BrowserSolveOptions): Promise<BrowserSolveResult>;
}

/**
 * Assert a URL targets the allowed HEPData host over https. Throws otherwise so
 * the browser is never pointed at an attacker-influenced or downgraded URL.
 */
function assertHepdataUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw upstreamError(`Browser transport: not a parseable URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw upstreamError(`Browser transport blocked (non-https scheme): ${parsed.protocol}`);
  }
  if (parsed.hostname !== HEPDATA_ALLOWED_HOST) {
    throw upstreamError(`Browser transport blocked (host not in allow-list): ${parsed.hostname}`);
  }
}

/**
 * Thrown (as an Error) by `PlaywrightSolver` when `import('playwright')` fails,
 * so `selectAndRun` can surface a precise "npm i playwright" remedy.
 */
export class PlaywrightUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'Playwright is not installed. The Cloudflare browser fallback requires it. ' +
        'Install it in this package, then re-run: `npm i playwright` ' +
        '(or `pnpm add playwright`). A first run will also need Chromium: ' +
        '`npx playwright install chromium`.',
    );
    this.name = 'PlaywrightUnavailableError';
    this.cause = cause;
  }
}

/**
 * Default browser backend. Uses Playwright's persistent Chromium context to
 * solve the Cloudflare interstitial.
 *
 * `playwright` is imported dynamically and typed as `any` so this file compiles
 * with no `@types/playwright` and no `playwright` install. The import is only
 * reached at runtime when the browser path is actually selected.
 */
export class PlaywrightSolver implements BrowserSolver {
  async solve(url: string, opts: BrowserSolveOptions): Promise<BrowserSolveResult> {
    assertHepdataUrl(url);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let playwright: any;
    try {
      playwright = await importPlaywright();
    } catch (err) {
      throw new PlaywrightUnavailableError(err);
    }

    const chromium = playwright.chromium ?? playwright.default?.chromium;
    if (!chromium) {
      throw new PlaywrightUnavailableError(
        new Error('playwright module did not export a `chromium` browser type'),
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let context: any;
    try {
      context = await chromium.launchPersistentContext(opts.userDataDir, {
        headless: true,
        proxy: opts.proxy ? { server: opts.proxy } : undefined,
      });

      const page = await context.newPage();

      // Navigate and let the network settle, then poll until the challenge
      // interstitial is gone (cf_clearance issued) or we run out of budget.
      const deadline = Date.now() + opts.timeoutMs;
      const navTimeout = Math.max(1_000, Math.min(opts.timeoutMs, 30_000));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let lastResponse: any = await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: navTimeout,
      });

      // Poll: re-read the document body and headers; if it still looks like a
      // challenge, wait briefly and re-evaluate. Chromium auto-solves the
      // Managed Challenge and reloads, so the live `page` content converges to
      // the real response.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const status: number = lastResponse?.status?.() ?? 200;
        const headerMap: Record<string, string> =
          typeof lastResponse?.headers === 'function' ? lastResponse.headers() : {};
        const headers = new Headers(headerMap);
        const bodyText: string = await page.content();

        if (!isCloudflareChallenge(status, headers, bodyText)) {
          return { status, headers: headerMap, body: extractDocumentText(bodyText) };
        }

        if (Date.now() >= deadline) {
          throw upstreamError(
            'Browser transport: Cloudflare challenge did not clear within the ' +
              `timeout (${opts.timeoutMs} ms) for ${url}.`,
          );
        }

        // Wait for the next navigation the challenge triggers, bounded by the
        // remaining budget; fall through to re-poll on timeout.
        const remaining = deadline - Date.now();
        try {
          lastResponse = await page.waitForNavigation({
            waitUntil: 'networkidle',
            timeout: Math.max(500, Math.min(remaining, 5_000)),
          });
        } catch {
          // No navigation within the slice; re-evaluate current page state.
          lastResponse = null;
        }
      }
    } finally {
      if (context) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await context.close().catch(() => {});
      }
    }
  }
}

/**
 * HEPData's JSON endpoints, when fetched in a browser, are rendered inside the
 * document. `page.content()` returns full HTML; for a raw JSON document Chromium
 * wraps it as `<html><head>...</head><body><pre>{...}</pre></body></html>`.
 * Extract the text content of the `<pre>` (or body) so downstream `.json()`
 * works. If no wrapper is detected, the body is returned unchanged (already
 * JSON/text).
 */
function extractDocumentText(html: string): string {
  // Fast path: looks like a bare JSON/text document already.
  const trimmed = html.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return html;

  // Chromium JSON viewer wraps the payload in a single <pre>.
  const preMatch = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  if (preMatch) return decodeEntities(preMatch[1]);

  // Otherwise hand back the raw HTML body (callers that wanted HTML/text get it).
  return html;
}

/** Decode the minimal set of HTML entities the JSON viewer escapes. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable solver + URL cache (for tests)
// ─────────────────────────────────────────────────────────────────────────────

let activeSolver: BrowserSolver = new PlaywrightSolver();
let activeCache: UrlCache = defaultUrlCache;

/** Override the browser backend (tests inject a mock; pass nothing to reset). */
export function setBrowserSolver(solver?: BrowserSolver): void {
  activeSolver = solver ?? new PlaywrightSolver();
}

/** Override the URL cache (tests inject a fresh instance; pass nothing to reset). */
export function setUrlCache(cache?: UrlCache): void {
  activeCache = cache ?? defaultUrlCache;
}

/** Current URL cache — used by the rate limiter for the pre-fetch lookup. */
export function getUrlCache(): UrlCache {
  return activeCache;
}

/** Whether the browser fallback is opted in via env. */
export function browserFetchEnabled(): boolean {
  const raw = process.env.HEPDATA_BROWSER_FETCH?.trim().toLowerCase();
  if (!raw) return false;
  return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off';
}

/**
 * Resolve the upstream proxy for the browser, mirroring how shells/curl read it.
 * Precedence: explicit HEPDATA_PROXY, then HTTPS_PROXY, then lower-case
 * https_proxy. Returns undefined for a direct connection.
 */
export function resolveProxy(): string | undefined {
  const candidate =
    process.env.HEPDATA_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const trimmed = candidate?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Build the precise, actionable error thrown when a Cloudflare challenge is hit
 * but the browser fallback is NOT opted in. Includes the `cf-ray` id when
 * present so the user can correlate with Cloudflare logs / support.
 */
export function challengeOptOutError(url: string, headers: Headers): ReturnType<typeof upstreamError> {
  const cfRay = headers.get('cf-ray');
  const rayNote = cfRay ? ` (cf-ray: ${cfRay})` : '';
  return upstreamError(
    `HEPData blocked this request with a Cloudflare Managed Challenge on the ` +
      `current egress IP${rayNote}: ${url}. A plain HTTP client cannot solve it. ` +
      `Remedies: (a) route through a clean/residential proxy node (set HEPDATA_PROXY ` +
      `or HTTPS_PROXY); or (b) enable the browser fallback by setting ` +
      `HEPDATA_BROWSER_FETCH=1 and installing Playwright (\`npm i playwright\` then ` +
      `\`npx playwright install chromium\`); or (c) move egress to a clean exit IP.`,
  );
}

/**
 * Selection + cache + error policy for a detected Cloudflare challenge.
 *
 * Preconditions: the caller has already read the plain-fetch body, run
 * `isCloudflareChallenge`, and confirmed it IS a challenge. This function:
 *   1. If the browser fallback is opted OUT → throws `challengeOptOutError`.
 *   2. If opted IN → runs the active `BrowserSolver`. On `import('playwright')`
 *      failure (surfaced as `PlaywrightUnavailableError`) → throws a precise
 *      "install playwright" upstream error.
 *   3. On solver success → caches the result (when 2xx) and returns it.
 *
 * Returns the `BrowserSolveResult` for the rate limiter to wrap in a Response.
 */
export async function selectAndRun(
  url: string,
  challengeHeaders: Headers,
): Promise<BrowserSolveResult> {
  if (!browserFetchEnabled()) {
    throw challengeOptOutError(url, challengeHeaders);
  }

  let result: BrowserSolveResult;
  try {
    result = await activeSolver.solve(url, {
      proxy: resolveProxy(),
      userDataDir: USER_DATA_DIR,
      timeoutMs: DEFAULT_SOLVE_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof PlaywrightUnavailableError) {
      throw upstreamError(err.message);
    }
    // Re-throw McpErrors (already precise) unchanged; wrap anything else.
    if (err && typeof err === 'object' && 'code' in err) throw err;
    throw upstreamError(
      `Browser transport failed to solve the Cloudflare challenge for ${url}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (result.status >= 200 && result.status < 300) {
    const payload: CachedResponse = {
      status: result.status,
      headers: result.headers,
      body: result.body,
    };
    activeCache.set(url, payload);
  }

  return result;
}

/** Exposed for documentation/tests: the confined Chromium profile directory. */
export const __userDataDir = USER_DATA_DIR;
