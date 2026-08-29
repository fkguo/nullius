/**
 * P3-C harness invocation marker — redesigned event-driven verifier tests.
 *
 * Covers:
 *   - skip layers (NODE_ENV=test, NULLIUS_HARNESS_VERIFY env,
 *     no .nullius/ at cwd → B, toolIsStateTouching=false → C)
 *   - happy path (marker present, anchored_at ≥ state.json/ledger.jsonl
 *     mtime → no throw)
 *   - rejection paths (missing / invalid JSON / wrong contract / state
 *     mutated since anchor)
 *   - write round-trip (v2 schema; state/ledger mtimes captured)
 *   - readHarnessInvocationMarker passthrough
 *   - v1 backward compat (old markers with ttl_seconds still accepted;
 *     ttl_seconds is ignored; mtime check still applies)
 *   - no clock TTL: marker arbitrarily old is valid if state hasn't moved
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HARNESS_INVOCATION_FILE,
  HARNESS_INVOCATION_SCHEMA_VERSION,
  NULLIUS_STATE_FILE,
  NULLIUS_LEDGER_FILE,
  nulliusStatePath,
  nulliusLedgerPath,
  harnessInvocationMarkerPath,
  isHarnessVerifySkipped,
  readHarnessInvocationMarker,
  verifyHarnessInvocationMarker,
  writeHarnessInvocationMarker,
} from '../harness-invocation.js';
import { McpError } from '../errors.js';

const FORCE_ON_ENV = { NULLIUS_HARNESS_VERIFY: 'on' } as NodeJS.ProcessEnv;

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-inv-'));
  fs.mkdirSync(path.join(root, '.nullius'), { recursive: true });
  return root;
}

function makeBareCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-bare-'));
}

function setMtime(filePath: string, isoTime: string): void {
  const ms = Date.parse(isoTime);
  fs.utimesSync(filePath, ms / 1000, ms / 1000);
}

describe('isHarnessVerifySkipped', () => {
  it('skip when NULLIUS_HARNESS_VERIFY=skip regardless of NODE_ENV', () => {
    expect(isHarnessVerifySkipped({ NULLIUS_HARNESS_VERIFY: 'skip' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isHarnessVerifySkipped({
      NULLIUS_HARNESS_VERIFY: 'skip',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('force-on when NULLIUS_HARNESS_VERIFY=on even in test', () => {
    expect(isHarnessVerifySkipped({
      NULLIUS_HARNESS_VERIFY: 'on',
      NODE_ENV: 'test',
    } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('defaults to skip in NODE_ENV=test', () => {
    expect(isHarnessVerifySkipped({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('defaults to verify when nothing forces skip', () => {
    expect(isHarnessVerifySkipped({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isHarnessVerifySkipped({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('skip layer B — no .nullius at cwd', () => {
  let bare: string;
  beforeEach(() => { bare = makeBareCwd(); });
  afterEach(() => { fs.rmSync(bare, { recursive: true, force: true }); });

  it('skips verification when cwd has no .nullius directory (standalone use)', () => {
    expect(() => verifyHarnessInvocationMarker(bare, { env: FORCE_ON_ENV }))
      .not.toThrow();
  });

  it('skip-B takes precedence even when toolIsStateTouching=true', () => {
    expect(() =>
      verifyHarnessInvocationMarker(bare, { env: FORCE_ON_ENV, toolIsStateTouching: true }),
    ).not.toThrow();
  });
});

describe('skip layer C — caller-supplied toolIsStateTouching=false', () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('skips verification for read-only provider queries even with .nullius present', () => {
    expect(() =>
      verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV, toolIsStateTouching: false }),
    ).not.toThrow();
  });

  it('defaults toolIsStateTouching=true (conservative); fails closed when marker missing', () => {
    expect(() =>
      verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV }),
    ).toThrow(/has not anchored/);
  });

  it('toolIsStateTouching=true explicit fails closed when marker missing', () => {
    expect(() =>
      verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV, toolIsStateTouching: true }),
    ).toThrow(/has not anchored/);
  });
});

describe('verifyHarnessInvocationMarker rejection paths', () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('MARKER_MISSING when no marker file exists', () => {
    try {
      verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const m = err as McpError;
      expect(m.code).toBe('HARNESS_INVOCATION_REQUIRED');
      expect((m.data as { reason: string }).reason).toBe('MARKER_MISSING');
    }
  });

  it('MARKER_INVALID on non-JSON content', () => {
    fs.writeFileSync(harnessInvocationMarkerPath(project), 'not-json', 'utf-8');
    try {
      verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV });
      throw new Error('expected throw');
    } catch (err) {
      const m = err as McpError;
      expect(m.code).toBe('HARNESS_INVOCATION_REQUIRED');
      expect((m.data as { reason: string }).reason).toBe('MARKER_INVALID');
    }
  });

  it('MARKER_INVALID on wrong schema_version (e.g. 99)', () => {
    fs.writeFileSync(
      harnessInvocationMarkerPath(project),
      JSON.stringify({
        schema_version: 99,
        kind: 'nullius_harness_invocation',
        anchored_at: '2026-05-22T00:00:00Z',
        host_skill: 'research-harness',
        project_root: project,
      }),
      'utf-8',
    );
    try {
      verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV });
      throw new Error('expected throw');
    } catch (err) {
      const m = err as McpError;
      expect((m.data as { reason: string }).reason).toBe('MARKER_INVALID');
    }
  });

  it('MARKER_INVALID on missing required field (kind)', () => {
    fs.writeFileSync(
      harnessInvocationMarkerPath(project),
      JSON.stringify({
        schema_version: 2,
        anchored_at: '2026-05-22T00:00:00Z',
        host_skill: 'research-harness',
        project_root: project,
      }),
      'utf-8',
    );
    try {
      verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV });
      throw new Error('expected throw');
    } catch (err) {
      const m = err as McpError;
      expect((m.data as { reason: string }).reason).toBe('MARKER_INVALID');
    }
  });

  it('STATE_CHANGED_SINCE_ANCHOR when state.json mtime > marker.anchored_at', () => {
    const t0 = new Date('2026-05-22T08:00:00Z');
    writeHarnessInvocationMarker(project, { now: t0 });
    const statePath = nulliusStatePath(project);
    fs.writeFileSync(statePath, '{}', 'utf-8');
    setMtime(statePath, '2026-05-22T09:00:00Z');

    try {
      verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV });
      throw new Error('expected throw');
    } catch (err) {
      const m = err as McpError;
      expect(m.code).toBe('HARNESS_INVOCATION_REQUIRED');
      expect((m.data as { reason: string }).reason).toBe('STATE_CHANGED_SINCE_ANCHOR');
      expect((m.data as { latest_state_change_at: string }).latest_state_change_at)
        .toBe('2026-05-22T09:00:00.000Z');
    }
  });

  it('STATE_CHANGED_SINCE_ANCHOR when ledger.jsonl mtime > marker.anchored_at', () => {
    const t0 = new Date('2026-05-22T08:00:00Z');
    writeHarnessInvocationMarker(project, { now: t0 });
    const ledgerPath = nulliusLedgerPath(project);
    fs.writeFileSync(ledgerPath, '{"event":"x"}\n', 'utf-8');
    setMtime(ledgerPath, '2026-05-22T09:30:00Z');

    try {
      verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV });
      throw new Error('expected throw');
    } catch (err) {
      const m = err as McpError;
      expect((m.data as { reason: string }).reason).toBe('STATE_CHANGED_SINCE_ANCHOR');
    }
  });
});

describe('gpt-5.5 review B1 — future anchored_at rejection (clock-skew guard)', () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('MARKER_FUTURE when anchored_at is more than 5s in the future relative to now', () => {
    const fixedNow = new Date('2026-05-22T08:00:00Z');
    writeHarnessInvocationMarker(project, { now: new Date('2026-05-22T08:01:00Z') });
    try {
      verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV, now: fixedNow });
      throw new Error('expected throw');
    } catch (err) {
      const m = err as McpError;
      expect(m.code).toBe('HARNESS_INVOCATION_REQUIRED');
      expect((m.data as { reason: string }).reason).toBe('MARKER_FUTURE');
    }
  });

  it('passes when anchored_at is exactly at now (boundary)', () => {
    const fixedNow = new Date('2026-05-22T08:00:00Z');
    writeHarnessInvocationMarker(project, { now: fixedNow });
    expect(() =>
      verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV, now: fixedNow }),
    ).not.toThrow();
  });

  it('passes when anchored_at is at most 5s ahead of now (skew tolerance)', () => {
    const fixedNow = new Date('2026-05-22T08:00:00Z');
    writeHarnessInvocationMarker(project, { now: new Date('2026-05-22T08:00:04Z') });
    expect(() =>
      verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV, now: fixedNow }),
    ).not.toThrow();
  });

  it('rejects future-anchor that bypasses state-change check (the actual correctness bug)', () => {
    // The bug gpt-5.5 caught: if anchored_at is way in the future, then any
    // realistic state.json mtime is < anchored_at, so STATE_CHANGED_SINCE_ANCHOR
    // never fires. MARKER_FUTURE must fire instead.
    const fixedNow = new Date('2026-05-22T08:00:00Z');
    const farFuture = new Date('2030-01-01T00:00:00Z');
    writeHarnessInvocationMarker(project, { now: farFuture });
    // Simulate a state-change AT now (which would normally invalidate the anchor)
    const statePath = nulliusStatePath(project);
    fs.writeFileSync(statePath, '{}', 'utf-8');
    setMtime(statePath, '2026-05-22T07:30:00Z');
    try {
      verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV, now: fixedNow });
      throw new Error('expected throw');
    } catch (err) {
      const m = err as McpError;
      expect((m.data as { reason: string }).reason).toBe('MARKER_FUTURE');
    }
  });
});

describe('gpt-5.5 review B2 — project_root identity guard', () => {
  let projectA: string;
  let projectB: string;
  beforeEach(() => {
    projectA = makeProject();
    projectB = makeProject();
  });
  afterEach(() => {
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
  });

  it('MARKER_PROJECT_MISMATCH when marker was written for a different project', () => {
    // Write a marker for project A
    writeHarnessInvocationMarker(projectA, { now: new Date('2026-05-22T08:00:00Z') });
    // Copy A's marker to B's .nullius dir (simulating cross-project marker copy)
    fs.copyFileSync(
      harnessInvocationMarkerPath(projectA),
      harnessInvocationMarkerPath(projectB),
    );
    // Verifier at projectB cwd should reject — marker says projectA
    try {
      verifyHarnessInvocationMarker(projectB, { env: FORCE_ON_ENV });
      throw new Error('expected throw');
    } catch (err) {
      const m = err as McpError;
      expect(m.code).toBe('HARNESS_INVOCATION_REQUIRED');
      expect((m.data as { reason: string }).reason).toBe('MARKER_PROJECT_MISMATCH');
    }
  });

  it('passes when project_root in marker matches cwd (round-trip identity)', () => {
    writeHarnessInvocationMarker(projectA, { now: new Date('2026-05-22T08:00:00Z') });
    expect(() =>
      verifyHarnessInvocationMarker(projectA, { env: FORCE_ON_ENV }),
    ).not.toThrow();
  });

  it('passes when cwd has trailing slash or different normalization but same realpath', () => {
    writeHarnessInvocationMarker(projectA, { now: new Date('2026-05-22T08:00:00Z') });
    // Adding trailing slash; realpath should normalize
    expect(() =>
      verifyHarnessInvocationMarker(projectA + '/', { env: FORCE_ON_ENV }),
    ).not.toThrow();
  });
});

describe('verifyHarnessInvocationMarker happy path', () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('passes when marker exists and no state files exist (fresh project)', () => {
    writeHarnessInvocationMarker(project, { now: new Date('2026-05-22T08:00:00Z') });
    expect(() => verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV })).not.toThrow();
  });

  it('passes when marker anchored_at == state.json mtime (boundary equality is OK)', () => {
    const t0 = new Date('2026-05-22T08:00:00Z');
    const statePath = nulliusStatePath(project);
    fs.writeFileSync(statePath, '{}', 'utf-8');
    setMtime(statePath, t0.toISOString());
    writeHarnessInvocationMarker(project, { now: t0 });
    expect(() => verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV })).not.toThrow();
  });

  it('passes when marker anchored_at > state.json mtime (state stable since anchor)', () => {
    const tState = new Date('2026-05-22T08:00:00Z');
    const tAnchor = new Date('2026-05-22T08:30:00Z');
    const statePath = nulliusStatePath(project);
    fs.writeFileSync(statePath, '{}', 'utf-8');
    setMtime(statePath, tState.toISOString());
    writeHarnessInvocationMarker(project, { now: tAnchor });
    expect(() => verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV })).not.toThrow();
  });

  it('NO CLOCK TTL: marker anchored long ago still valid if state stable', () => {
    const tState = new Date('2025-01-01T00:00:00Z');
    const tAnchor = new Date('2025-01-01T01:00:00Z');
    const statePath = nulliusStatePath(project);
    fs.writeFileSync(statePath, '{}', 'utf-8');
    setMtime(statePath, tState.toISOString());
    writeHarnessInvocationMarker(project, { now: tAnchor });
    expect(() => verifyHarnessInvocationMarker(project, {
      env: FORCE_ON_ENV,
      now: new Date('2026-12-31T23:59:59Z'),
    })).not.toThrow();
  });
});

describe('writeHarnessInvocationMarker / round-trip', () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('writes a schema v2 marker with kind + host_skill', () => {
    const m = writeHarnessInvocationMarker(project, { now: new Date('2026-05-22T08:00:00Z') });
    expect(m.schema_version).toBe(HARNESS_INVOCATION_SCHEMA_VERSION);
    expect(m.schema_version).toBe(2);
    expect(m.kind).toBe('nullius_harness_invocation');
    expect(m.host_skill).toBe('research-harness');
    expect(m.anchored_at).toBe('2026-05-22T08:00:00.000Z');
  });

  it('captures state.json mtime when state.json exists at write time (informational)', () => {
    const statePath = nulliusStatePath(project);
    fs.writeFileSync(statePath, '{}', 'utf-8');
    setMtime(statePath, '2026-05-22T07:30:00Z');
    const m = writeHarnessInvocationMarker(project, { now: new Date('2026-05-22T08:00:00Z') });
    expect(m.state_mtime_at_anchor).toBe('2026-05-22T07:30:00.000Z');
  });

  it('omits state_mtime_at_anchor when state.json does not exist', () => {
    const m = writeHarnessInvocationMarker(project, { now: new Date('2026-05-22T08:00:00Z') });
    expect(m.state_mtime_at_anchor).toBeUndefined();
  });

  it('round-trips through readHarnessInvocationMarker', () => {
    const written = writeHarnessInvocationMarker(project, { now: new Date('2026-05-22T08:00:00Z') });
    const read = readHarnessInvocationMarker(project);
    expect(read).not.toBeNull();
    expect(read?.anchored_at).toBe(written.anchored_at);
    expect(read?.schema_version).toBe(2);
  });
});

describe('readHarnessInvocationMarker', () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('returns null when marker missing', () => {
    expect(readHarnessInvocationMarker(project)).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    fs.writeFileSync(harnessInvocationMarkerPath(project), 'garbage', 'utf-8');
    expect(readHarnessInvocationMarker(project)).toBeNull();
  });

  it('returns null on wrong contract', () => {
    fs.writeFileSync(
      harnessInvocationMarkerPath(project),
      JSON.stringify({ schema_version: 99 }),
      'utf-8',
    );
    expect(readHarnessInvocationMarker(project)).toBeNull();
  });
});

describe('v1 backward compat', () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

  it('accepts v1 marker (with ttl_seconds) and applies v2 mtime logic', () => {
    fs.writeFileSync(
      harnessInvocationMarkerPath(project),
      JSON.stringify({
        schema_version: 1,
        kind: 'nullius_harness_invocation',
        anchored_at: '2026-05-22T08:00:00Z',
        ttl_seconds: 3600,
        host_skill: 'research-harness',
        project_root: project,
      }),
      'utf-8',
    );
    expect(() => verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV })).not.toThrow();
  });

  it('v1 marker fails when state changed after anchored_at (ttl_seconds ignored)', () => {
    fs.writeFileSync(
      harnessInvocationMarkerPath(project),
      JSON.stringify({
        schema_version: 1,
        kind: 'nullius_harness_invocation',
        anchored_at: '2026-05-22T08:00:00Z',
        ttl_seconds: 999999,
        host_skill: 'research-harness',
        project_root: project,
      }),
      'utf-8',
    );
    const statePath = nulliusStatePath(project);
    fs.writeFileSync(statePath, '{}', 'utf-8');
    setMtime(statePath, '2026-05-22T09:00:00Z');

    try {
      verifyHarnessInvocationMarker(project, { env: FORCE_ON_ENV });
      throw new Error('expected throw');
    } catch (err) {
      const m = err as McpError;
      expect((m.data as { reason: string }).reason).toBe('STATE_CHANGED_SINCE_ANCHOR');
    }
  });
});

describe('path helpers', () => {
  it('exports the file constants', () => {
    expect(HARNESS_INVOCATION_FILE).toBe('.nullius/HARNESS_INVOCATION');
    expect(NULLIUS_STATE_FILE).toBe('.nullius/state.json');
    expect(NULLIUS_LEDGER_FILE).toBe('.nullius/ledger.jsonl');
  });

  it('nulliusStatePath joins under project root', () => {
    expect(nulliusStatePath('/proj')).toBe(path.join('/proj', NULLIUS_STATE_FILE));
  });

  it('nulliusLedgerPath joins under project root', () => {
    expect(nulliusLedgerPath('/proj')).toBe(path.join('/proj', NULLIUS_LEDGER_FILE));
  });
});
