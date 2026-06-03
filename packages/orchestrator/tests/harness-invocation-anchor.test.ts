/**
 * P3-C: orchestrator status writes the harness invocation marker.
 *
 * The research-harness skill already invokes `autoresearch status --json`
 * during recovery. After P3-C, that same call also refreshes the anchor
 * marker that *-mcp dispatchers verify. This test locks the contract:
 * a successful status call leaves a valid marker on disk.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HARNESS_INVOCATION_FILE,
  readHarnessInvocationMarker,
} from '@autoresearch/shared';
import { handleOrchRunStatus } from '../src/orch-tools/create-status-list.js';
import { runInitCommand } from '../src/cli-init.js';

function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-harness-anchor-'));
}

function silentIo(cwd: string) {
  return {
    cwd,
    stderr: (_text: string) => {},
    stdout: (_text: string) => {},
  };
}

describe('handleOrchRunStatus — harness invocation anchor', () => {
  let projectRoot: string;
  beforeEach(async () => {
    projectRoot = makeTempProjectRoot();
    await runInitCommand(projectRoot, projectRoot, [], silentIo(projectRoot));
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes the schema v2 harness invocation marker on success', async () => {
    const markerPath = path.join(projectRoot, HARNESS_INVOCATION_FILE);
    expect(fs.existsSync(markerPath)).toBe(false);

    await handleOrchRunStatus({ project_root: projectRoot });

    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = readHarnessInvocationMarker(projectRoot);
    expect(marker).not.toBeNull();
    // v2 redesign: schema_version is 2; ttl_seconds is gone
    expect(marker?.schema_version).toBe(2);
    expect(marker?.kind).toBe('autoresearch_harness_invocation');
    expect(marker?.host_skill).toBe('research-harness');
    // project_root is persisted as the normalized realpath (gpt-5.5 review B2)
    expect(marker?.project_root).toBe(fs.realpathSync(projectRoot));
    expect(Date.parse(marker!.anchored_at)).toBeGreaterThan(0);
    expect(marker?.ttl_seconds).toBeUndefined();
  });

  it('refreshes anchored_at on each subsequent status call', async () => {
    await handleOrchRunStatus({ project_root: projectRoot });
    const first = readHarnessInvocationMarker(projectRoot);
    expect(first).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 10));
    await handleOrchRunStatus({ project_root: projectRoot });
    const second = readHarnessInvocationMarker(projectRoot);
    expect(second).not.toBeNull();
    expect(Date.parse(second!.anchored_at)).toBeGreaterThanOrEqual(
      Date.parse(first!.anchored_at),
    );
  });
});
