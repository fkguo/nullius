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

  it('confines every RPC write to the declared store root inside a populated project root', async () => {
    // Whole-project-root containment: the engine tests above isolate the
    // store root, so a writer that escaped into the surrounding project
    // (front-door files, sibling directories) would never be seen. This
    // fixture plants the store INSIDE a project root carrying front-door
    // files, inventories every byte before and after a realistic RPC
    // sequence, and asserts (i) new files land only under the store root,
    // (ii) front-door bytes are untouched, (iii) no lock/temp residue
    // anywhere in the project.
    const { createHash } = await import('crypto');
    const { writeFileSync, mkdirSync } = await import('fs');
    const { IdeaEngineRpcService } = await import('../src/service/rpc-service.js');

    const projectRoot = mkdtempSync(join(tmpdir(), 'idea-engine-containment-'));
    tempDirs.push(projectRoot);
    const frontDoorFiles = ['project_index.md', 'research_plan.md', 'research_contract.md', 'AGENTS.md'];
    for (const name of frontDoorFiles) {
      writeFileSync(join(projectRoot, name), `# ${name}\n\nfront-door fixture content\n`, 'utf-8');
    }
    mkdirSync(join(projectRoot, 'artifacts', 'runs'), { recursive: true });
    writeFileSync(join(projectRoot, 'artifacts', 'runs', 'README.md'), 'run root fixture\n', 'utf-8');
    const storeRoot = join(projectRoot, 'ideas');
    mkdirSync(storeRoot, { recursive: true });

    const inventory = (): Map<string, string> => {
      // Entry-typed inventory: directories are recorded too (an escaped
      // EMPTY directory outside the store root must fail containment, not
      // slip past a files-only walk).
      const seen = new Map<string, string>();
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const fullPath = resolve(dir, entry.name);
          const relPath = fullPath.slice(projectRoot.length + 1).split('\\').join('/');
          if (entry.isDirectory()) {
            seen.set(`${relPath}/`, 'dir');
            walk(fullPath);
          } else {
            seen.set(relPath, createHash('sha256').update(readFileSync(fullPath)).digest('hex'));
          }
        }
      };
      walk(projectRoot);
      return seen;
    };

    const before = inventory();
    const service = new IdeaEngineRpcService({
      rootDir: storeRoot,
      now: () => '2026-08-02T00:00:00.000Z',
    });
    const { initCampaign, enterReview, setPosterior } = await import('./helpers/revise-card-test-fixture.js');
    const { campaignId, nodeId } = initCampaign(service, 'containment-init');
    enterReview(service, campaignId, nodeId, 'containment-review');
    setPosterior(service, campaignId, nodeId, 'containment-posterior');
    service.handle('rank.compute', {
      campaign_id: campaignId,
      method: 'posterior',
      idempotency_key: 'containment-rank',
    });
    const after = inventory();

    const storePrefix = 'ideas/';
    const newPaths = [...after.keys()].filter(relPath => !before.has(relPath));
    expect(newPaths.length).toBeGreaterThan(0);
    for (const relPath of newPaths) {
      expect(relPath.startsWith(storePrefix), `write escaped the store root: ${relPath}`).toBe(true);
    }
    // EVERY pre-existing entry — not a hand-maintained list — must survive
    // byte-identical (files) or in place (directories) outside the store
    // root; deletions are caught the same way. Inside the store root the
    // engine may legitimately rewrite its own records.
    for (const [relPath, digest] of before.entries()) {
      if (relPath.startsWith(storePrefix)) continue;
      expect(after.get(relPath), `pre-existing entry changed or vanished: ${relPath}`).toBe(digest);
    }
    for (const relPath of after.keys()) {
      expect(/\.lck$|\.tmp(?:$|\.)/.test(relPath), `lock/temp residue: ${relPath}`).toBe(false);
    }
  });
});
