/**
 * MCP-tool-level tests for hep_admin_migrate_papers_cache. Exercises the
 * dispatched path that goes through withProjectRootContract + the H-11a
 * destructive-tool gate, NOT just the pure migratePapersCache() function.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getToolSpec } from '../../src/tools/registry/shared.js';
import { HEP_ADMIN_MIGRATE_PAPERS_CACHE } from '../../src/tool-names.js';
import { HEP_PAPERS_CACHE_DIR_ENV } from '../../src/data/papersCache.js';

describe('hep_admin_migrate_papers_cache MCP tool', () => {
  let tmpProjectRoot: string;
  let tmpCacheDir: string;
  let originalCacheDir: string | undefined;

  beforeEach(() => {
    originalCacheDir = process.env[HEP_PAPERS_CACHE_DIR_ENV];
    tmpProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-tool-project-'));
    tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-tool-cache-'));
    process.env[HEP_PAPERS_CACHE_DIR_ENV] = tmpCacheDir;
  });

  afterEach(() => {
    if (originalCacheDir === undefined) delete process.env[HEP_PAPERS_CACHE_DIR_ENV];
    else process.env[HEP_PAPERS_CACHE_DIR_ENV] = originalCacheDir;
    fs.rmSync(tmpProjectRoot, { recursive: true, force: true });
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  });

  function getHandler() {
    const spec = getToolSpec(HEP_ADMIN_MIGRATE_PAPERS_CACHE);
    if (!spec) throw new Error('tool not registered');
    return spec.handler;
  }

  it('is registered with riskLevel=write (not destructive) so dry-run flows without the dispatcher _confirm gate', () => {
    const spec = getToolSpec(HEP_ADMIN_MIGRATE_PAPERS_CACHE);
    expect(spec).toBeDefined();
    expect(spec!.riskLevel).toBe('write');
  });

  it('rejects calls with no project_root (regression for withProjectRootContract optional override)', async () => {
    // withProjectRootContract.extend() makes project_root optional at the
    // schema layer. Without a handler-level guard, the call would reach
    // migratePapersCache(undefined) and crash with TypeError. We assert the
    // handler returns a friendly invalidParams instead.
    const handler = getHandler();
    await expect(handler({}, {})).rejects.toThrow(/project_root/);
  });

  it('rejects calls with empty/whitespace project_root', async () => {
    const handler = getHandler();
    await expect(handler({ project_root: '   ' }, {})).rejects.toThrow(/project_root/);
  });

  it('dry-run (apply=false) does not need _confirm and produces a plan', async () => {
    const handler = getHandler();
    const result = (await handler({ project_root: tmpProjectRoot }, {})) as { dry_run: boolean; schema_version: number };
    expect(result.dry_run).toBe(true);
    expect(result.schema_version).toBe(1);
  });

  it('apply=true without _confirm downgrades to dry-run with a warning', async () => {
    const handler = getHandler();
    const result = (await handler({ project_root: tmpProjectRoot, apply: true }, {})) as {
      dry_run: boolean;
      warning?: string;
    };
    expect(result.dry_run).toBe(true);
    expect(result.warning).toContain('_confirm=true was not provided');
  });

  it('apply=true with _confirm=true performs the migration (no warning)', async () => {
    const handler = getHandler();
    const result = (await handler({ project_root: tmpProjectRoot, apply: true, _confirm: true }, {})) as {
      dry_run: boolean;
      warning?: string;
    };
    expect(result.dry_run).toBe(false);
    expect(result.warning).toBeUndefined();
  });
});
