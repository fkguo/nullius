/**
 * P3-C (redesigned 2026-05-23): dispatcher rejects state-touching tool
 * calls when the harness invocation marker is missing, project-mismatched,
 * future-dated, or older than current state.json / ledger.jsonl mtime.
 *
 * The hep-mcp dispatcher is representative — all 7 *-mcp dispatchers share
 * the same wiring (anti-drift CI enforces this). We exercise the rejection
 * paths here once; unit tests in
 * `packages/shared/src/__tests__/harness-invocation.test.ts` cover the
 * marker semantics in detail.
 *
 * The test forces verification ON (overriding the NODE_ENV=test default
 * skip) so the anchor gate actually runs, then drives the dispatcher
 * through the missing / fresh / state-changed cases.
 *
 * IMPORTANT: `hep_health` is **no-state-touch** per the audit-backed
 * classifier (`packages/hep-mcp/src/tools/state-touch-classification.ts`),
 * so it takes skip layer C and is NOT a valid test subject for the
 * rejection path. We use `hep_project_list` instead — it is
 * `ALWAYS_STATE_TOUCHING` (lists `<hep_data_root>/projects/`).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HARNESS_INVOCATION_FILE,
  AUTORESEARCH_STATE_FILE,
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
    // Create .autoresearch/ so skip-layer B does not fire (this is an
    // in-lifecycle scenario, not standalone).
    fs.mkdirSync(path.join(project, '.autoresearch'), { recursive: true });
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

  it('rejects state-touching tool with MARKER_MISSING when no marker', async () => {
    expect(fs.existsSync(path.join(project, HARNESS_INVOCATION_FILE))).toBe(false);

    // hep_project_list is ALWAYS_STATE_TOUCHING per audit.
    const result = await handleToolCall('hep_project_list', {});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? '{}');
    expect(payload.error?.code).toBe('HARNESS_INVOCATION_REQUIRED');
    expect(payload.error?.data?.reason).toBe('MARKER_MISSING');
    expect(payload.error?.data?.remediation).toMatch(/research-harness|autoresearch status/);
    expect(payload.error?.data?.marker_path).toBe(HARNESS_INVOCATION_FILE);
  });

  it('rejects state-touching tool with STATE_CHANGED_SINCE_ANCHOR when state mtime > marker', async () => {
    // Anchor first, then bump state.json mtime past anchored_at to simulate
    // an out-of-band lifecycle event.
    const anchored = new Date('2026-05-22T08:00:00Z');
    writeHarnessInvocationMarker(project, { now: anchored });
    const statePath = path.join(project, AUTORESEARCH_STATE_FILE);
    fs.writeFileSync(statePath, '{}', 'utf-8');
    const futureStateTime = new Date('2026-05-22T09:00:00Z');
    fs.utimesSync(statePath, futureStateTime.getTime() / 1000, futureStateTime.getTime() / 1000);

    const result = await handleToolCall('hep_project_list', {});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? '{}');
    expect(payload.error?.code).toBe('HARNESS_INVOCATION_REQUIRED');
    expect(payload.error?.data?.reason).toBe('STATE_CHANGED_SINCE_ANCHOR');
    expect(payload.error?.data?.anchored_at).toBe(anchored.toISOString());
  });

  it('admits state-touching tool when marker is fresh against state', async () => {
    writeHarnessInvocationMarker(project);

    const result = await handleToolCall('hep_project_list', {});
    // Tool may return an empty list or other benign payload; what matters
    // here is that the harness gate did not reject the call.
    const payload = JSON.parse(result.content[0]?.text ?? '{}');
    expect(payload.error?.code).not.toBe('HARNESS_INVOCATION_REQUIRED');
  });

  it('admits no-state-touch tool (hep_health) even without marker (skip layer C)', async () => {
    expect(fs.existsSync(path.join(project, HARNESS_INVOCATION_FILE))).toBe(false);

    // hep_health is NO_STATE_TOUCH per audit → skip layer C fires;
    // anchor not required even though .autoresearch/ exists.
    const result = await handleToolCall('hep_health', {});
    const payload = JSON.parse(result.content[0]?.text ?? '{}');
    expect(payload.error?.code).not.toBe('HARNESS_INVOCATION_REQUIRED');
  });
});
