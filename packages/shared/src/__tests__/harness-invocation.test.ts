/**
 * P3-C: harness invocation marker verifier tests.
 *
 * Covers:
 *   - skip semantics (NODE_ENV=test, AUTORESEARCH_HARNESS_VERIFY env values)
 *   - happy path (marker present, fresh → no throw)
 *   - rejection paths (missing / invalid JSON / wrong contract / stale)
 *   - write round-trip
 *   - readHarnessInvocationMarker passthrough
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HARNESS_INVOCATION_FILE,
  DEFAULT_HARNESS_INVOCATION_TTL_SECONDS,
  harnessInvocationMarkerPath,
  isHarnessVerifySkipped,
  readHarnessInvocationMarker,
  verifyHarnessInvocationMarker,
  writeHarnessInvocationMarker,
} from '../harness-invocation.js';
import { McpError } from '../errors.js';

const FORCE_ON_ENV = { AUTORESEARCH_HARNESS_VERIFY: 'on' } as NodeJS.ProcessEnv;

function makeProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-inv-'));
}

describe('isHarnessVerifySkipped', () => {
  it('skip when AUTORESEARCH_HARNESS_VERIFY=skip regardless of NODE_ENV', () => {
    expect(isHarnessVerifySkipped({ AUTORESEARCH_HARNESS_VERIFY: 'skip' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isHarnessVerifySkipped({
      AUTORESEARCH_HARNESS_VERIFY: 'skip',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('force-on when AUTORESEARCH_HARNESS_VERIFY=on even in test', () => {
    expect(isHarnessVerifySkipped({
      AUTORESEARCH_HARNESS_VERIFY: 'on',
      NODE_ENV: 'test',
    } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('defaults to skip in NODE_ENV=test', () => {
    expect(isHarnessVerifySkipped({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('defaults to verify (not skip) in production', () => {
    expect(isHarnessVerifySkipped({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isHarnessVerifySkipped({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('treats AUTORESEARCH_HARNESS_VERIFY case-insensitively and trims whitespace', () => {
    expect(isHarnessVerifySkipped({ AUTORESEARCH_HARNESS_VERIFY: ' SKIP ' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isHarnessVerifySkipped({
      AUTORESEARCH_HARNESS_VERIFY: ' ON ',
      NODE_ENV: 'test',
    } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('harnessInvocationMarkerPath', () => {
  it('joins project root with .autoresearch/HARNESS_INVOCATION', () => {
    const p = harnessInvocationMarkerPath('/tmp/proj');
    expect(p).toBe(path.join('/tmp/proj', HARNESS_INVOCATION_FILE));
  });
});

describe('writeHarnessInvocationMarker', () => {
  let proj: string;
  beforeEach(() => { proj = makeProject(); });
  afterEach(() => { fs.rmSync(proj, { recursive: true, force: true }); });

  it('writes a valid marker JSON file with default TTL', () => {
    const marker = writeHarnessInvocationMarker(proj);
    const markerPath = path.join(proj, HARNESS_INVOCATION_FILE);
    expect(fs.existsSync(markerPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    expect(onDisk).toEqual(marker);
    expect(marker.schema_version).toBe(1);
    expect(marker.kind).toBe('autoresearch_harness_invocation');
    expect(marker.host_skill).toBe('research-harness');
    expect(marker.project_root).toBe(proj);
    expect(marker.ttl_seconds).toBe(DEFAULT_HARNESS_INVOCATION_TTL_SECONDS);
    expect(Date.parse(marker.anchored_at)).toBeGreaterThan(0);
  });

  it('honors custom TTL and timestamp', () => {
    const fixedNow = new Date('2026-01-15T10:00:00.000Z');
    const marker = writeHarnessInvocationMarker(proj, { ttlSeconds: 60, now: fixedNow });
    expect(marker.ttl_seconds).toBe(60);
    expect(marker.anchored_at).toBe('2026-01-15T10:00:00.000Z');
  });

  it('creates the .autoresearch parent dir if missing', () => {
    fs.rmSync(path.join(proj, '.autoresearch'), { recursive: true, force: true });
    writeHarnessInvocationMarker(proj);
    expect(fs.existsSync(path.join(proj, '.autoresearch'))).toBe(true);
  });

  it('overwrites existing marker atomically', () => {
    writeHarnessInvocationMarker(proj, { now: new Date('2026-01-15T10:00:00.000Z') });
    writeHarnessInvocationMarker(proj, { now: new Date('2026-01-15T11:00:00.000Z') });
    const marker = readHarnessInvocationMarker(proj);
    expect(marker?.anchored_at).toBe('2026-01-15T11:00:00.000Z');
  });
});

describe('verifyHarnessInvocationMarker — skip semantics', () => {
  it('returns silently when env opts into skip even with no marker on disk', () => {
    const proj = '/nonexistent/path/should-not-be-read';
    expect(() => verifyHarnessInvocationMarker(proj, {
      env: { AUTORESEARCH_HARNESS_VERIFY: 'skip' } as NodeJS.ProcessEnv,
    })).not.toThrow();
  });

  it('respects NODE_ENV=test default (skip) even with no marker', () => {
    const proj = '/nonexistent/path/should-not-be-read';
    expect(() => verifyHarnessInvocationMarker(proj, {
      env: { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
    })).not.toThrow();
  });
});

describe('verifyHarnessInvocationMarker — happy path', () => {
  let proj: string;
  beforeEach(() => { proj = makeProject(); });
  afterEach(() => { fs.rmSync(proj, { recursive: true, force: true }); });

  it('returns silently when marker is fresh', () => {
    writeHarnessInvocationMarker(proj, { now: new Date('2026-01-15T10:00:00.000Z'), ttlSeconds: 3600 });
    expect(() => verifyHarnessInvocationMarker(proj, {
      env: FORCE_ON_ENV,
      now: new Date('2026-01-15T10:30:00.000Z'),
    })).not.toThrow();
  });

  it('allows marker exactly at the freshness boundary', () => {
    const anchored = new Date('2026-01-15T10:00:00.000Z');
    writeHarnessInvocationMarker(proj, { now: anchored, ttlSeconds: 100 });
    const boundary = new Date(anchored.getTime() + 100 * 1000);
    expect(() => verifyHarnessInvocationMarker(proj, {
      env: FORCE_ON_ENV,
      now: boundary,
    })).not.toThrow();
  });
});

describe('verifyHarnessInvocationMarker — rejection paths', () => {
  let proj: string;
  beforeEach(() => { proj = makeProject(); });
  afterEach(() => { fs.rmSync(proj, { recursive: true, force: true }); });

  function expectHarnessError(fn: () => void, reason: string): unknown {
    let caught: unknown = null;
    try { fn(); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(McpError);
    const mcpErr = caught as McpError;
    expect(mcpErr.code).toBe('HARNESS_INVOCATION_REQUIRED');
    expect(mcpErr.retryable).toBe(false);
    expect((mcpErr.data as Record<string, unknown>).reason).toBe(reason);
    expect((mcpErr.data as Record<string, unknown>).remediation).toMatch(/research-harness|autoresearch status/);
    expect((mcpErr.data as Record<string, unknown>).marker_path).toBe(HARNESS_INVOCATION_FILE);
    return mcpErr.data;
  }

  it('MARKER_MISSING when file absent', () => {
    expectHarnessError(
      () => verifyHarnessInvocationMarker(proj, { env: FORCE_ON_ENV }),
      'MARKER_MISSING',
    );
  });

  it('MARKER_INVALID when file is not JSON', () => {
    fs.mkdirSync(path.join(proj, '.autoresearch'), { recursive: true });
    fs.writeFileSync(path.join(proj, HARNESS_INVOCATION_FILE), 'not json {{{');
    expectHarnessError(
      () => verifyHarnessInvocationMarker(proj, { env: FORCE_ON_ENV }),
      'MARKER_INVALID',
    );
  });

  it('MARKER_INVALID when schema_version drifts', () => {
    fs.mkdirSync(path.join(proj, '.autoresearch'), { recursive: true });
    fs.writeFileSync(path.join(proj, HARNESS_INVOCATION_FILE), JSON.stringify({
      schema_version: 2,
      kind: 'autoresearch_harness_invocation',
      anchored_at: new Date().toISOString(),
      ttl_seconds: 3600,
      host_skill: 'research-harness',
      project_root: proj,
    }));
    expectHarnessError(
      () => verifyHarnessInvocationMarker(proj, { env: FORCE_ON_ENV }),
      'MARKER_INVALID',
    );
  });

  it('MARKER_INVALID when required field missing', () => {
    fs.mkdirSync(path.join(proj, '.autoresearch'), { recursive: true });
    fs.writeFileSync(path.join(proj, HARNESS_INVOCATION_FILE), JSON.stringify({
      schema_version: 1,
      kind: 'autoresearch_harness_invocation',
      anchored_at: new Date().toISOString(),
      // ttl_seconds missing
      host_skill: 'research-harness',
      project_root: proj,
    }));
    expectHarnessError(
      () => verifyHarnessInvocationMarker(proj, { env: FORCE_ON_ENV }),
      'MARKER_INVALID',
    );
  });

  it('MARKER_INVALID when anchored_at is unparseable', () => {
    fs.mkdirSync(path.join(proj, '.autoresearch'), { recursive: true });
    fs.writeFileSync(path.join(proj, HARNESS_INVOCATION_FILE), JSON.stringify({
      schema_version: 1,
      kind: 'autoresearch_harness_invocation',
      anchored_at: 'not-a-real-date',
      ttl_seconds: 3600,
      host_skill: 'research-harness',
      project_root: proj,
    }));
    expectHarnessError(
      () => verifyHarnessInvocationMarker(proj, { env: FORCE_ON_ENV }),
      'MARKER_INVALID',
    );
  });

  it('MARKER_STALE when anchored_at + ttl < now', () => {
    const anchored = new Date('2026-01-15T10:00:00.000Z');
    writeHarnessInvocationMarker(proj, { now: anchored, ttlSeconds: 60 });
    const data = expectHarnessError(
      () => verifyHarnessInvocationMarker(proj, {
        env: FORCE_ON_ENV,
        now: new Date('2026-01-15T10:02:00.000Z'), // 120s later, ttl 60s
      }),
      'MARKER_STALE',
    ) as Record<string, unknown>;
    expect(data.anchored_at).toBe('2026-01-15T10:00:00.000Z');
    expect(data.ttl_seconds).toBe(60);
    expect(data.expires_at).toBe('2026-01-15T10:01:00.000Z');
  });
});

describe('readHarnessInvocationMarker', () => {
  let proj: string;
  beforeEach(() => { proj = makeProject(); });
  afterEach(() => { fs.rmSync(proj, { recursive: true, force: true }); });

  it('returns null when marker absent', () => {
    expect(readHarnessInvocationMarker(proj)).toBeNull();
  });

  it('returns null when marker malformed', () => {
    fs.mkdirSync(path.join(proj, '.autoresearch'), { recursive: true });
    fs.writeFileSync(path.join(proj, HARNESS_INVOCATION_FILE), '{not valid');
    expect(readHarnessInvocationMarker(proj)).toBeNull();
  });

  it('returns the parsed marker when valid', () => {
    const written = writeHarnessInvocationMarker(proj);
    expect(readHarnessInvocationMarker(proj)).toEqual(written);
  });
});
