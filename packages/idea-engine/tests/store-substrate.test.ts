import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
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
      campaign_id: 'stcmp001',
      status: 'running',
      created_at: '2026-03-14T00:00:00Z',
      budget: { max_tokens: 10, max_cost_usd: 1, max_wall_clock_s: 5 },
      usage: { tokens_used: 0, cost_usd_used: 0, wall_clock_s_elapsed: 0, steps_used: 0, nodes_used: 0 },
    });
    expect(store.loadCampaign('stcmp001')).toMatchObject({
      status: 'running',
    });

    store.saveNodes('stcmp001', {
      'stnde001': {
        campaign_id: 'stcmp001',
        node_id: 'stnde001',
        revision: 1,
        created_at: '2026-03-14T00:00:00Z',
      },
    });
    store.appendNodeLog(
      'stcmp001',
      {
        node_id: 'stnde001',
        revision: 1,
      },
      'create',
    );

    const artifactRef = store.writeArtifact(
      'stcmp001',
      'handoff',
      'handoff.json',
      { ok: true },
    );
    expect(artifactRef.startsWith('file://')).toBe(true);
    expect(store.loadArtifactFromRef(artifactRef)).toEqual({ ok: true });

    store.saveIdempotency(null, {
      'campaign.init:demo': { payload_hash: 'sha256:abc' },
    });
    store.saveIdempotency('stcmp001', {
      'node.list:demo': { payload_hash: 'sha256:def' },
    });

    expect(store.loadIdempotency(null)).toEqual({
      'campaign.init:demo': { payload_hash: 'sha256:abc' },
    });
    expect(store.loadIdempotency('stcmp001')).toEqual({
      'node.list:demo': { payload_hash: 'sha256:def' },
    });

    const jsonl = readFileSync(store.nodesLogPath('stcmp001'), 'utf8')
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
    const lockPath = store.mutationLockPath('stcmp001');

    store.withMutationLock('stcmp001', () => {
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

  it('rejects malformed or escaping project artifact refs', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'idea-engine-bad-project-ref-'));
    tempDirs.push(projectRoot);
    const store = new IdeaEngineStore(join(projectRoot, 'idea-store'));
    const hash = `sha256:${'a'.repeat(64)}`;

    for (const badRef of [
      'project://idea-store/campaigns/stcmp001/artifacts/generation/pack-demo.json',
      `project://idea-store/../outside.json#${hash}`,
      `project://idea-store//campaigns/stcmp001#${hash}`,
      `project://idea-store/%ZZ#${hash}`,
      `project://idea-store/campaigns/stcmp001/artifacts/generation/pack-demo.json#sha256:${'A'.repeat(64)}`,
      `project://ideas/gaia/demo#${hash}`,
    ]) {
      expect(() => store.artifactPathFromRef(badRef)).toThrow();
    }
  });

  it('emits and resolves project-root-relative content-pinned artifact refs', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'idea-engine-project-'));
    tempDirs.push(projectRoot);
    const rootDir = join(projectRoot, 'idea-store');
    const store = new IdeaEngineStore(rootDir);
    const artifactPath = store.artifactPath('stcmp001', 'generation', 'pack-demo.json');
    const artifactHash = `sha256:${'a'.repeat(64)}`;
    store.writeArtifact('stcmp001', 'generation', 'pack-demo.json', { ok: true });

    const portableRef = store.portableArtifactRef(artifactPath, artifactHash);

    expect(portableRef).toBe(`project://idea-store/campaigns/stcmp001/artifacts/generation/pack-demo.json#${artifactHash}`);
    expect(store.artifactHashFromRef(portableRef)).toBe(artifactHash);
    expect(store.artifactPathFromRef(portableRef)).toBe(artifactPath);
    expect(store.loadArtifactFromRef(portableRef)).toEqual({ ok: true });
  });

  it('discovers a managed project root by .nullius before falling back to idea-store parent', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'idea-engine-managed-project-'));
    tempDirs.push(projectRoot);
    const managedMarker = join(projectRoot, '.nullius');
    const rootDir = join(projectRoot, 'data', 'idea-store');
    const store = new IdeaEngineStore(rootDir);
    const artifactHash = `sha256:${'b'.repeat(64)}`;

    expect(existsSync(managedMarker)).toBe(false);
    expect(store.projectRoot).toBe(join(projectRoot, 'data'));

    rmSync(rootDir, { recursive: true, force: true });
    const markerStore = new IdeaEngineStore(rootDir, { projectRoot });
    markerStore.writeArtifact('stcmp001', 'generation', 'pack-demo.json', { ok: true });
    const explicitRef = markerStore.portableArtifactRef(
      markerStore.artifactPath('stcmp001', 'generation', 'pack-demo.json'),
      artifactHash,
    );
    expect(explicitRef).toBe(`project://data/idea-store/campaigns/stcmp001/artifacts/generation/pack-demo.json#${artifactHash}`);

    rmSync(rootDir, { recursive: true, force: true });
    mkdirSync(managedMarker, { recursive: true });
    const discoveredStore = new IdeaEngineStore(rootDir);
    discoveredStore.writeArtifact('stcmp001', 'generation', 'pack-demo.json', { ok: true });
    const discoveredRef = discoveredStore.portableArtifactRef(
      discoveredStore.artifactPath('stcmp001', 'generation', 'pack-demo.json'),
      artifactHash,
    );
    expect(discoveredRef).toBe(explicitRef);
  });

  it('rejects missing artifact refs inside the store root', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-missing-artifact-'));
    tempDirs.push(rootDir);
    const store = new IdeaEngineStore(rootDir);
    const missingRef = pathToFileURL(
      store.artifactPath(
        'stcmp001',
        'handoff',
        'missing.json',
      ),
    ).href;

    expect(() => store.loadArtifactFromRef(missingRef)).toThrow(/ENOENT/);
  });
});
