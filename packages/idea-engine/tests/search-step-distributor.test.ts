import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { DISTRIBUTOR_POLICY_FAMILY, DISTRIBUTOR_POLICY_ID } from '../src/service/distributor-config.js';
import { IdeaEngineRpcService, RpcError } from '../src/index.js';

const NOW = '2026-03-25T00:00:00Z';
const LATER = '2026-03-25T00:05:00Z';

function createService(rootDir: string, now = NOW): IdeaEngineRpcService {
  return new IdeaEngineRpcService({ now: () => now, rootDir });
}

function campaignInitParams(distributor?: Record<string, unknown>): Record<string, unknown> {
  return {
    charter: {
      campaign_name: 'distributor-test',
      domain: 'hep-ph',
      scope: 'Validate EVO-11 distributor runtime wiring through the TS live search path.',
      approval_gate_ref: 'gate://a0.1',
      ...(distributor ? { distributor } : {}),
    },
    seed_pack: {
      seeds: [
        { seed_type: 'text', content: 'seed-a' },
        { seed_type: 'text', content: 'seed-b' },
      ],
    },
    budget: {
      max_tokens: 100000,
      max_cost_usd: 100,
      max_wall_clock_s: 100000,
      max_steps: 20,
    },
    idempotency_key: 'campaign-init',
  };
}

function searchStepParams(campaignId: string, idempotencyKey: string): Record<string, unknown> {
  return { campaign_id: campaignId, idempotency_key: idempotencyKey, n_steps: 1 };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readJsonLines<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

describe('search.step distributor runtime', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
  });

  it('keeps the existing path unchanged when distributor is absent', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-distributor-absent-'));
    tempDirs.push(rootDir);
    const service = createService(rootDir);
    const init = service.handle('campaign.init', campaignInitParams());
    const campaignId = String(init.campaign_id);
    const result = service.handle('search.step', searchStepParams(campaignId, 'search-step'));
    const nodeId = String((result.new_node_ids as string[])[0]);
    const node = service.search.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;

    expect('distributor_policy_config_ref' in init).toBe(false);
    expect('distributor_policy_config_ref' in result).toBe(false);
    expect(node.operator_id).toBe('hep.anomaly_abduction.v1');
    expect(existsSync(resolve(rootDir, `campaigns/${campaignId}/artifacts/distributor`))).toBe(false);
  });

  it('materializes config, appends events, and resumes from snapshot deterministically', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-distributor-runtime-'));
    tempDirs.push(rootDir);
    const distributor = { factorization: 'factorized', policy_id: DISTRIBUTOR_POLICY_ID };
    const service1 = createService(rootDir, NOW);
    const init = service1.handle('campaign.init', campaignInitParams(distributor));
    const campaignId = String(init.campaign_id);
    const configRef = String(init.distributor_policy_config_ref);
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const configPath = fileURLToPath(configRef);
    const config = readJson<Record<string, unknown>>(configPath);

    expect(configPath).toBe(resolve(campaignDir, 'artifacts/distributor/distributor_policy_config_v1.json'));
    expect(config.policy_id).toBe(DISTRIBUTOR_POLICY_ID);
    expect(config.policy_family).toBe(DISTRIBUTOR_POLICY_FAMILY);
    expect(config.action_space).toEqual({
      backend_ids: [
        'hep.operator.backend.anomaly',
        'hep.operator.backend.limit',
        'hep.operator.backend.symmetry',
      ],
      factorization: 'factorized',
      island_ids: ['island-0'],
      operator_ids: [
        'hep.anomaly_abduction.v1',
        'hep.limit_explorer.v1',
        'hep.symmetry_operator.v1',
      ],
    });

    const step1 = service1.handle('search.step', searchStepParams(campaignId, 'search-step-1'));
    const service2 = createService(rootDir, LATER);
    const step2 = service2.handle('search.step', searchStepParams(campaignId, 'search-step-2'));
    const eventsPath = resolve(campaignDir, 'artifacts/distributor/distributor_events_v1.jsonl');
    const snapshotPath = resolve(campaignDir, 'artifacts/distributor/distributor_state_snapshot_v1.json');
    const events = readJsonLines<Record<string, unknown>>(eventsPath);
    const snapshot = readJson<Record<string, Record<string, unknown>>>(snapshotPath);
    const totalSelections = Object.values(snapshot.action_stats).reduce(
      (sum, stats) => sum + Number((stats as Record<string, unknown>).n ?? 0),
      0,
    );

    expect(String(step1.distributor_policy_config_ref)).toBe(configRef);
    expect(String(step2.distributor_policy_config_ref)).toBe(configRef);
    expect(events).toHaveLength(2);
    expect((events[0]!.selected_action as Record<string, unknown>).operator_id).toBe('hep.anomaly_abduction.v1');
    expect((events[1]!.selected_action as Record<string, unknown>).operator_id).toBe('hep.limit_explorer.v1');
    expect(snapshot.timestamp).toBe(LATER);
    expect(totalSelections).toBe(2);
    expect(eventsPath.startsWith(campaignDir)).toBe(true);
    expect(snapshotPath.startsWith(campaignDir)).toBe(true);
  });

  it('keeps island scheduling authoritative when distributor is enabled across multiple islands', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-distributor-multi-island-'));
    tempDirs.push(rootDir);
    const service = createService(rootDir);
    const params = campaignInitParams({ factorization: 'factorized', policy_id: DISTRIBUTOR_POLICY_ID });

    (params.charter as Record<string, unknown>).extensions = { initial_island_count: 2 };

    const init = service.handle('campaign.init', params);
    const campaignId = String(init.campaign_id);
    service.handle('search.step', { ...searchStepParams(campaignId, 'search-step-multi-island'), n_steps: 2 });

    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const events = readJsonLines<Record<string, unknown>>(resolve(campaignDir, 'artifacts/distributor/distributor_events_v1.jsonl'));
    const snapshot = readJson<Record<string, Record<string, Record<string, unknown>>>>(
      resolve(campaignDir, 'artifacts/distributor/distributor_state_snapshot_v1.json'),
    );

    expect(events).toHaveLength(2);
    expect((events[0]!.selected_action as Record<string, unknown>).island_id).toBe('island-0');
    expect((events[1]!.selected_action as Record<string, unknown>).island_id).toBe('island-1');
    expect(Object.keys(snapshot.action_stats).filter(actionId => actionId.endsWith('::island-0'))).toHaveLength(3);
    expect(Object.keys(snapshot.action_stats).filter(actionId => actionId.endsWith('::island-1'))).toHaveLength(3);
    expect(
      Object.values(snapshot.action_stats).reduce(
        (sum, stats) => sum + Number((stats as Record<string, unknown>).n ?? 0),
        0,
      ),
    ).toBe(2);
  });

  it.each([
    ['missing policy_id', { factorization: 'factorized' }],
    ['unknown policy_id', { factorization: 'factorized', policy_id: 'ts.unknown_policy' }],
    ['joint factorization', { factorization: 'joint', policy_id: DISTRIBUTOR_POLICY_ID }],
    ['explicit policy_config_ref', { factorization: 'factorized', policy_id: DISTRIBUTOR_POLICY_ID, policy_config_ref: 'file:///tmp/override.json' }],
  ])('fails closed for %s', (_label, distributor) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-distributor-invalid-'));
    tempDirs.push(rootDir);
    const service = createService(rootDir);

    try {
      service.handle('campaign.init', campaignInitParams(distributor));
      throw new Error('expected campaign.init to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      const rpcError = error as RpcError;
      expect(rpcError.code).toBe(-32002);
      expect(rpcError.data.reason).toBe('schema_invalid');
    }
  });

  it('fails closed when the saved action space no longer matches the runtime', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-distributor-mismatch-'));
    tempDirs.push(rootDir);
    const service = createService(rootDir);
    const init = service.handle('campaign.init', campaignInitParams({
      factorization: 'factorized',
      policy_id: DISTRIBUTOR_POLICY_ID,
    }));
    const configPath = fileURLToPath(String(init.distributor_policy_config_ref));
    const config = readJson<Record<string, unknown>>(configPath);

    writeFileSync(configPath, `${JSON.stringify({
      ...config,
      action_space: {
        ...(config.action_space as Record<string, unknown>),
        operator_ids: ['hep.anomaly_abduction.v1'],
      },
    }, null, 2)}\n`, 'utf8');

    try {
      service.handle('search.step', searchStepParams(String(init.campaign_id), 'search-step-mismatch'));
      throw new Error('expected search.step to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      const rpcError = error as RpcError;
      expect(rpcError.code).toBe(-32002);
      expect(rpcError.data.reason).toBe('schema_invalid');
    }
  });
});
