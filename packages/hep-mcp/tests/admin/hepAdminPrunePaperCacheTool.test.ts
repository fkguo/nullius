/**
 * MCP-tool-level tests for hep_admin_prune_paper_cache. Same dual-key safety
 * pattern as hep_admin_migrate_papers_cache.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getToolSpec } from '../../src/tools/registry/shared.js';
import { HEP_ADMIN_PRUNE_PAPER_CACHE } from '../../src/tool-names.js';
import { HEP_PAPERS_CACHE_DIR_ENV } from '../../src/data/papersCache.js';

describe('hep_admin_prune_paper_cache MCP tool', () => {
  let tmpProject: string;
  let tmpCacheDir: string;
  let originalCacheDir: string | undefined;

  beforeEach(() => {
    originalCacheDir = process.env[HEP_PAPERS_CACHE_DIR_ENV];
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-tool-project-'));
    tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-tool-cache-'));
    process.env[HEP_PAPERS_CACHE_DIR_ENV] = tmpCacheDir;
  });

  afterEach(() => {
    if (originalCacheDir === undefined) delete process.env[HEP_PAPERS_CACHE_DIR_ENV];
    else process.env[HEP_PAPERS_CACHE_DIR_ENV] = originalCacheDir;
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  });

  function getHandler() {
    const spec = getToolSpec(HEP_ADMIN_PRUNE_PAPER_CACHE);
    if (!spec) throw new Error('tool not registered');
    return spec.handler;
  }

  it('is registered with riskLevel=write', () => {
    const spec = getToolSpec(HEP_ADMIN_PRUNE_PAPER_CACHE);
    expect(spec).toBeDefined();
    expect(spec!.riskLevel).toBe('write');
  });

  it('rejects calls with no project_roots', async () => {
    const handler = getHandler();
    await expect(handler({ project_roots: [] }, {})).rejects.toThrow();
  });

  it('rejects calls with whitespace-only project_root entries', async () => {
    const handler = getHandler();
    await expect(handler({ project_roots: ['   '] }, {})).rejects.toThrow(/non-empty/);
  });

  it('dry-run (apply=false) does not need _confirm and produces a plan', async () => {
    const handler = getHandler();
    const result = (await handler({ project_roots: [tmpProject] }, {})) as {
      dry_run: boolean;
      schema_version: number;
    };
    expect(result.dry_run).toBe(true);
    expect(result.schema_version).toBe(1);
  });

  it('apply=true without _confirm downgrades to dry-run with a warning', async () => {
    const handler = getHandler();
    const result = (await handler({ project_roots: [tmpProject], apply: true }, {})) as {
      dry_run: boolean;
      warning?: string;
    };
    expect(result.dry_run).toBe(true);
    expect(result.warning).toContain('_confirm=true was not provided');
  });

  it('apply=true with _confirm=true performs the prune (no warning)', async () => {
    const handler = getHandler();
    const result = (await handler({ project_roots: [tmpProject], apply: true, _confirm: true }, {})) as {
      dry_run: boolean;
      warning?: string;
    };
    expect(result.dry_run).toBe(false);
    expect(result.warning).toBeUndefined();
  });
});
