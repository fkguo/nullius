/**
 * Cloudflare "Managed Challenge" detection for the HEPData fetch layer.
 *
 * When the egress IP is a Cloudflare-flagged datacenter/proxy IP, HEPData
 * returns HTTP 403 (sometimes 503) with header `cf-mitigated: challenge` and
 * an interstitial HTML body ("Just a moment... / Enable JavaScript and cookies
 * to continue"). Plain HTTP clients (curl / Node fetch / requests) cannot solve
 * it — only a real browser with a JS engine can. On a clean IP the same request
 * returns 200.
 *
 * This module isolates the *recognition* of that condition so both the rate
 * limiter and its tests share one source of truth.
 */

/**
 * Body-substring signatures of the Cloudflare interstitial challenge page.
 * Matched case-insensitively. Kept narrow so a legitimate HEPData page that
 * merely mentions one of these words is unlikely to false-positive — we only
 * even look at the body when the status is 403/503 AND the server is Cloudflare.
 */
const CHALLENGE_BODY_PATTERN = /just a moment|challenge-platform|Enable JavaScript and cookies/i;

/**
 * Returns true when the response looks like a Cloudflare Managed Challenge that
 * a plain HTTP client cannot pass.
 *
 * Decision:
 *   (status === 403 || status === 503)
 *   AND (
 *     header `cf-mitigated` === 'challenge'
 *     OR (header `server` === 'cloudflare' AND body matches the challenge pattern)
 *   )
 *
 * `headers.get` is case-insensitive (WHATWG Headers), so callers may pass a real
 * `Headers` instance or any object exposing a compatible `get`.
 */
export function isCloudflareChallenge(
  status: number,
  headers: Headers,
  bodyText: string,
): boolean {
  if (status !== 403 && status !== 503) return false;

  const cfMitigated = headers.get('cf-mitigated');
  if (cfMitigated !== null && cfMitigated.trim().toLowerCase() === 'challenge') {
    return true;
  }

  const server = headers.get('server');
  if (server !== null && server.trim().toLowerCase() === 'cloudflare') {
    return CHALLENGE_BODY_PATTERN.test(bodyText);
  }

  return false;
}

/**
 * Reconstruct a fresh `Response` from already-consumed body text plus the
 * original status/headers.
 *
 * Reading a `Response` body (`.text()`) consumes the underlying stream, so once
 * `fetchWithRetry` has read the body to run challenge detection it can no longer
 * hand the *same* Response to downstream callers (their `.json()` / `.text()`
 * would throw "Body is unusable"). This rebuilds an equivalent Response whose
 * body is replayable.
 *
 * Note on 204/205/304: those status codes forbid a body, and `new Response`
 * with a non-empty body would throw. HEPData challenge/data responses are never
 * these codes on the paths we cache, but we guard defensively by passing
 * `null` for the body in that case.
 */
export function reconstructResponse(
  bodyText: string,
  status: number,
  headers: Headers,
): Response {
  const nullBodyStatus = status === 101 || status === 204 || status === 205 || status === 304;
  return new Response(nullBodyStatus ? null : bodyText, {
    status,
    headers,
  });
}
