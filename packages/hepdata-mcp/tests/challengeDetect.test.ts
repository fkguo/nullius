import { describe, expect, it } from 'vitest';
import {
  isCloudflareChallenge,
  reconstructResponse,
} from '../src/api/transport/challengeDetect.js';

const CHALLENGE_BODY =
  '<!DOCTYPE html><html><head><title>Just a moment...</title></head>' +
  '<body><div id="challenge-platform"></div>' +
  'Enable JavaScript and cookies to continue</body></html>';

describe('isCloudflareChallenge — positive fixtures', () => {
  it('detects 403 + cf-mitigated: challenge (header signal alone)', () => {
    const headers = new Headers({ 'cf-mitigated': 'challenge', server: 'cloudflare' });
    expect(isCloudflareChallenge(403, headers, CHALLENGE_BODY)).toBe(true);
  });

  it('detects 503 + cf-mitigated: challenge', () => {
    const headers = new Headers({ 'cf-mitigated': 'challenge' });
    expect(isCloudflareChallenge(503, headers, '')).toBe(true);
  });

  it('detects 403 + server: cloudflare + challenge body (no cf-mitigated)', () => {
    const headers = new Headers({ server: 'cloudflare' });
    expect(isCloudflareChallenge(403, headers, CHALLENGE_BODY)).toBe(true);
  });

  it('cf-mitigated match is case-insensitive and trims whitespace', () => {
    const headers = new Headers({ 'cf-mitigated': '  CHALLENGE  ' });
    expect(isCloudflareChallenge(403, headers, '')).toBe(true);
  });

  it('body pattern matches "challenge-platform" marker', () => {
    const headers = new Headers({ server: 'cloudflare' });
    const body = '<div class="challenge-platform">…</div>';
    expect(isCloudflareChallenge(503, headers, body)).toBe(true);
  });
});

describe('isCloudflareChallenge — negative fixtures', () => {
  it('returns false for a 200 even with a challenge-looking body', () => {
    const headers = new Headers({ server: 'cloudflare' });
    expect(isCloudflareChallenge(200, headers, CHALLENGE_BODY)).toBe(false);
  });

  it('returns false for a 404 (not a challenge status)', () => {
    const headers = new Headers({ server: 'cloudflare' });
    expect(isCloudflareChallenge(404, headers, CHALLENGE_BODY)).toBe(false);
  });

  it('returns false for 403 from a non-Cloudflare server without cf-mitigated', () => {
    const headers = new Headers({ server: 'nginx' });
    expect(isCloudflareChallenge(403, headers, CHALLENGE_BODY)).toBe(false);
  });

  it('returns false for 403 + cloudflare server but ordinary body (real 403, not a challenge)', () => {
    const headers = new Headers({ server: 'cloudflare' });
    const body = '{"error":"forbidden: you are not allowed to access this record"}';
    expect(isCloudflareChallenge(403, headers, body)).toBe(false);
  });

  it('returns false for 503 + cloudflare server but ordinary maintenance body', () => {
    const headers = new Headers({ server: 'cloudflare' });
    expect(isCloudflareChallenge(503, headers, 'Service temporarily unavailable')).toBe(false);
  });

  it('does not treat cf-mitigated values other than "challenge" as a challenge', () => {
    const headers = new Headers({ 'cf-mitigated': 'block' });
    expect(isCloudflareChallenge(403, headers, CHALLENGE_BODY)).toBe(false);
  });
});

describe('reconstructResponse — body replay preserves .json()/.text()', () => {
  it('reconstructed Response yields the same JSON downstream', async () => {
    const json = { total: 3, results: [{ id: 7 }] };
    const headers = new Headers({ 'content-type': 'application/json' });
    const r = reconstructResponse(JSON.stringify(json), 200, headers);

    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    await expect(r.json()).resolves.toEqual(json);
  });

  it('reconstructed Response yields the same text downstream', async () => {
    const body = 'name: example\nvalues: [1, 2, 3]\n';
    const r = reconstructResponse(body, 200, new Headers());
    await expect(r.text()).resolves.toBe(body);
  });

  it('reconstructed Response yields bytes via .arrayBuffer() (download path)', async () => {
    const body = 'binary-ish-bytes';
    const r = reconstructResponse(body, 200, new Headers());
    const buf = await r.arrayBuffer();
    expect(new TextDecoder().decode(buf)).toBe(body);
  });

  it('passes a null body for 204/304 (forbidden-body statuses) without throwing', () => {
    expect(() => reconstructResponse('ignored', 204, new Headers())).not.toThrow();
    expect(() => reconstructResponse('ignored', 304, new Headers())).not.toThrow();
    expect(reconstructResponse('ignored', 204, new Headers()).status).toBe(204);
  });

  it('preserves the status code (e.g. 200) so response.ok stays correct', () => {
    const ok = reconstructResponse('{}', 200, new Headers());
    expect(ok.ok).toBe(true);
  });
});
