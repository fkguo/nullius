import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// P0-hotfix-3 regression — INSPIRE rate-limiter env override + sanitization
//
// Bug: packages/hep-mcp/src/api/rateLimiter.ts (INSPIRE-HEP fetcher) had
// REQUEST_TIMEOUT_MS = 30000 hard-coded, no env override. Same hardcode +
// same lack of env sanitization as arxiv-mcp / openalex-mcp / hepdata-mcp
// pre-hotfix (now addressed by PRs #14 + #15).
//
// Defense:
//   - parseEnvPositiveInt rejects NaN / Infinity / ≤0 / non-numeric / empty
//   - REQUEST_TIMEOUT_MS default raised 30s -> 90s, env: INSPIRE_REQUEST_TIMEOUT_MS
//   - INSPIRE_MAX_RETRIES, INSPIRE_RATE_LIMIT, INSPIRE_RATE_WINDOW_MS env-configurable
// ─────────────────────────────────────────────────────────────────────────────

describe('P0-hotfix-3 regression — parseEnvPositiveInt sanitization (INSPIRE)', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.INSPIRE_TEST_SAMPLE;
  });
  afterEach(() => {
    if (savedEnv !== undefined) process.env.INSPIRE_TEST_SAMPLE = savedEnv;
    else delete process.env.INSPIRE_TEST_SAMPLE;
  });

  it('rejects all adversarial values; accepts positive ints; floors fractions', async () => {
    const { __testing__ } = await import('../../src/api/rateLimiter.js');
    const { parseEnvPositiveInt } = __testing__;

    delete process.env.INSPIRE_TEST_SAMPLE;
    expect(parseEnvPositiveInt('INSPIRE_TEST_SAMPLE', 333)).toBe(333);

    process.env.INSPIRE_TEST_SAMPLE = '';
    expect(parseEnvPositiveInt('INSPIRE_TEST_SAMPLE', 333)).toBe(333);

    process.env.INSPIRE_TEST_SAMPLE = '   ';
    expect(parseEnvPositiveInt('INSPIRE_TEST_SAMPLE', 333)).toBe(333);

    process.env.INSPIRE_TEST_SAMPLE = 'abc';
    expect(parseEnvPositiveInt('INSPIRE_TEST_SAMPLE', 333)).toBe(333);

    process.env.INSPIRE_TEST_SAMPLE = 'NaN';
    expect(parseEnvPositiveInt('INSPIRE_TEST_SAMPLE', 333)).toBe(333);

    process.env.INSPIRE_TEST_SAMPLE = '-1';
    expect(parseEnvPositiveInt('INSPIRE_TEST_SAMPLE', 333)).toBe(333);

    process.env.INSPIRE_TEST_SAMPLE = '0';
    expect(parseEnvPositiveInt('INSPIRE_TEST_SAMPLE', 333)).toBe(333);

    process.env.INSPIRE_TEST_SAMPLE = '1e999';
    expect(parseEnvPositiveInt('INSPIRE_TEST_SAMPLE', 333)).toBe(333);

    // Accepted forms
    process.env.INSPIRE_TEST_SAMPLE = '5000';
    expect(parseEnvPositiveInt('INSPIRE_TEST_SAMPLE', 333)).toBe(5000);

    process.env.INSPIRE_TEST_SAMPLE = '1.7';
    expect(parseEnvPositiveInt('INSPIRE_TEST_SAMPLE', 333)).toBe(1);

    process.env.INSPIRE_TEST_SAMPLE = ' 90000 ';
    expect(parseEnvPositiveInt('INSPIRE_TEST_SAMPLE', 333)).toBe(90000);
  });
});

describe('P0-hotfix-3 regression — INSPIRE_REQUEST_TIMEOUT_MS env override', () => {
  let savedTimeout: string | undefined;
  let savedMaxRetries: string | undefined;
  let savedRateLimit: string | undefined;
  let savedRateWindow: string | undefined;

  beforeEach(() => {
    // Defend against env-poisoning from a colocated test (per R1 NIT):
    // REQUEST_TIMEOUT_MS is module-level, so we must clear the override
    // env vars AND reset modules before re-importing.
    savedTimeout = process.env.INSPIRE_REQUEST_TIMEOUT_MS;
    savedMaxRetries = process.env.INSPIRE_MAX_RETRIES;
    savedRateLimit = process.env.INSPIRE_RATE_LIMIT;
    savedRateWindow = process.env.INSPIRE_RATE_WINDOW_MS;
    delete process.env.INSPIRE_REQUEST_TIMEOUT_MS;
    delete process.env.INSPIRE_MAX_RETRIES;
    delete process.env.INSPIRE_RATE_LIMIT;
    delete process.env.INSPIRE_RATE_WINDOW_MS;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedTimeout !== undefined) process.env.INSPIRE_REQUEST_TIMEOUT_MS = savedTimeout;
    else delete process.env.INSPIRE_REQUEST_TIMEOUT_MS;
    if (savedMaxRetries !== undefined) process.env.INSPIRE_MAX_RETRIES = savedMaxRetries;
    else delete process.env.INSPIRE_MAX_RETRIES;
    if (savedRateLimit !== undefined) process.env.INSPIRE_RATE_LIMIT = savedRateLimit;
    else delete process.env.INSPIRE_RATE_LIMIT;
    if (savedRateWindow !== undefined) process.env.INSPIRE_RATE_WINDOW_MS = savedRateWindow;
    else delete process.env.INSPIRE_RATE_WINDOW_MS;
    vi.resetModules();
  });

  it('default REQUEST_TIMEOUT_MS is 90s (raised from 30s)', async () => {
    // Direct constant probe — REQUEST_TIMEOUT_MS is an exported module-level
    // const, so we can read it directly. Pre-hotfix this was 30000;
    // post-hotfix the default is 90_000 (with env override).
    const { REQUEST_TIMEOUT_MS } = await import('../../src/api/rateLimiter.js');
    expect(REQUEST_TIMEOUT_MS).toBe(90_000);
  });

  it('INSPIRE_REQUEST_TIMEOUT_MS env override is honored', async () => {
    process.env.INSPIRE_REQUEST_TIMEOUT_MS = '120000';
    vi.resetModules();
    const { REQUEST_TIMEOUT_MS } = await import('../../src/api/rateLimiter.js');
    expect(REQUEST_TIMEOUT_MS).toBe(120_000);
  });

  it('Adversarial env override falls back to default', async () => {
    process.env.INSPIRE_REQUEST_TIMEOUT_MS = 'abc';
    vi.resetModules();
    const { REQUEST_TIMEOUT_MS } = await import('../../src/api/rateLimiter.js');
    expect(REQUEST_TIMEOUT_MS).toBe(90_000);
  });
});
