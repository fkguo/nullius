import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeaEngineStore } from '../src/store/engine-store.js';

function collectTempFiles(rootDir: string): string[] {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  return entries.flatMap(entry => {
    const fullPath = resolve(rootDir, entry.name);
    if (entry.isDirectory()) {
      return collectTempFiles(fullPath);
    }
    return entry.name.includes('.tmp') ? [fullPath] : [];
  });
}

describe('store substrate', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists campaign, nodes, JSONL logs, artifacts, and idempotency stores', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-store-'));
    tempDirs.push(rootDir);
    const store = new IdeaEngineStore(rootDir);

    store.saveCampaign({
      campaign_id: '11111111-1111-4111-8111-111111111111',
      status: 'running',
      created_at: '2026-03-14T00:00:00Z',
      budget: { max_tokens: 10, max_cost_usd: 1, max_wall_clock_s: 5 },
      usage: { tokens_used: 0, cost_usd_used: 0, wall_clock_s_elapsed: 0, steps_used: 0, nodes_used: 0 },
      island_states: [],
    });
    expect(store.loadCampaign('11111111-1111-4111-8111-111111111111')).toMatchObject({
      status: 'running',
    });

    store.saveNodes('11111111-1111-4111-8111-111111111111', {
      '22222222-2222-4222-8222-222222222222': {
        campaign_id: '11111111-1111-4111-8111-111111111111',
        node_id: '22222222-2222-4222-8222-222222222222',
        revision: 1,
        created_at: '2026-03-14T00:00:00Z',
      },
    });
    store.appendNodeLog(
      '11111111-1111-4111-8111-111111111111',
      {
        node_id: '22222222-2222-4222-8222-222222222222',
        revision: 1,
      },
      'create',
    );

    const artifactRef = store.writeArtifact(
      '11111111-1111-4111-8111-111111111111',
      'scorecards',
      'scorecards.json',
      { ok: true },
    );
    expect(artifactRef.startsWith('file://')).toBe(true);
    expect(store.loadArtifactFromRef(artifactRef)).toEqual({ ok: true });

    store.saveIdempotency(null, {
      'campaign.init:demo': { payload_hash: 'sha256:abc' },
    });
    store.saveIdempotency('11111111-1111-4111-8111-111111111111', {
      'node.list:demo': { payload_hash: 'sha256:def' },
    });

    expect(store.loadIdempotency(null)).toEqual({
      'campaign.init:demo': { payload_hash: 'sha256:abc' },
    });
    expect(store.loadIdempotency('11111111-1111-4111-8111-111111111111')).toEqual({
      'node.list:demo': { payload_hash: 'sha256:def' },
    });

    const jsonl = readFileSync(store.nodesLogPath('11111111-1111-4111-8111-111111111111'), 'utf8')
      .trim()
      .split('\n');
    expect(jsonl).toHaveLength(1);
    expect(JSON.parse(jsonl[0] ?? '{}')).toMatchObject({ mutation: 'create' });
    expect(collectTempFiles(rootDir)).toEqual([]);
  });

  it('creates and removes the lock boundary around a callback', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-lock-'));
    tempDirs.push(rootDir);
    const store = new IdeaEngineStore(rootDir);
    const lockPath = store.mutationLockPath('11111111-1111-4111-8111-111111111111');

    store.withMutationLock('11111111-1111-4111-8111-111111111111', () => {
      expect(existsSync(lockPath)).toBe(true);
    });

    expect(existsSync(lockPath)).toBe(false);
  });

  it('rejects artifact refs outside the store root', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-artifact-'));
    tempDirs.push(rootDir);
    const store = new IdeaEngineStore(rootDir);
    const outsideRef = pathToFileURL(fileURLToPath(new URL(import.meta.url))).href;

    expect(() => store.loadArtifactFromRef(outsideRef)).toThrow(/outside store root/);
  });

  it('rejects missing artifact refs inside the store root', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-missing-artifact-'));
    tempDirs.push(rootDir);
    const store = new IdeaEngineStore(rootDir);
    const missingRef = pathToFileURL(
      store.artifactPath(
        '11111111-1111-4111-8111-111111111111',
        'scorecards',
        'missing.json',
      ),
    ).href;

    expect(() => store.loadArtifactFromRef(missingRef)).toThrow(/ENOENT/);
  });
});
