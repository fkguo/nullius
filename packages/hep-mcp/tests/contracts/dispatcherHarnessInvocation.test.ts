/**
 * P3-C: dispatcher rejects tool calls when the harness invocation marker
 * is missing or stale.
 *
 * The hep-mcp dispatcher is representative — all 7 *-mcp dispatchers share
 * the same wiring (anti-drift CI enforces this). We exercise the rejection
 * path here once; the unit tests in
 * `packages/shared/src/__tests__/harness-invocation.test.ts` cover the
 * marker semantics in detail.
 *
 * The test forces verification ON (overriding the NODE_ENV=test default
 * skip) so the anchor gate actually runs, then drives the dispatcher
 * through the missing / fresh / stale cases.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HARNESS_INVOCATION_FILE,
  writeHarnessInvocationMarker,
} from '@autoresearch/shared';
import { handleToolCall } from '../../src/tools/dispatcher.js';

describe('Contract: dispatcher harness-invocation anchor gate', () => {
  let project: string;
  let prevCwd: string;
  let prevVerify: string | undefined;

  beforeEach(() => {
    prevCwd = process.cwd();
    prevVerify = process.env.AUTORESEARCH_HARNESS_VERIFY;
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-disp-harness-'));
    process.chdir(project);
    process.env.AUTORESEARCH_HARNESS_VERIFY = 'on';
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevVerify === undefined) {
      delete process.env.AUTORESEARCH_HARNESS_VERIFY;
    } else {
      process.env.AUTORESEARCH_HARNESS_VERIFY = prevVerify;
    }
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('rejects tool call with HARNESS_INVOCATION_REQUIRED when marker is missing', async () => {
    expect(fs.existsSync(path.join(project, HARNESS_INVOCATION_FILE))).toBe(false);

    const result = await handleToolCall('hep_health', {});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? '{}');
    expect(payload.error?.code).toBe('HARNESS_INVOCATION_REQUIRED');
    expect(payload.error?.data?.reason).toBe('MARKER_MISSING');
    expect(payload.error?.data?.remediation).toMatch(/research-harness|autoresearch status/);
    expect(payload.error?.data?.marker_path).toBe(HARNESS_INVOCATION_FILE);
  });

  it('rejects tool call with MARKER_STALE when anchor TTL expired', async () => {
    const longAgo = new Date(Date.now() - 24 * 3600 * 1000);
    writeHarnessInvocationMarker(project, { now: longAgo, ttlSeconds: 60 });

    const result = await handleToolCall('hep_health', {});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? '{}');
    expect(payload.error?.code).toBe('HARNESS_INVOCATION_REQUIRED');
    expect(payload.error?.data?.reason).toBe('MARKER_STALE');
    expect(payload.error?.data?.anchored_at).toBe(longAgo.toISOString());
  });

  it('admits tool call when marker is fresh', async () => {
    writeHarnessInvocationMarker(project);

    const result = await handleToolCall('hep_health', {});
    // hep_health may return ok or a benign payload; what matters here is
    // that the harness gate did not reject the call before tool dispatch.
    const payload = JSON.parse(result.content[0]?.text ?? '{}');
    expect(payload.error?.code).not.toBe('HARNESS_INVOCATION_REQUIRED');
  });
});
