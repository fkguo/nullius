import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeaEngineRpcService } from '../src/service/rpc-service.js';

function createService(prefix: string): { rootDir: string; service: IdeaEngineRpcService } {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  return {
    rootDir,
    service: new IdeaEngineRpcService({ rootDir }),
  };
}

function initParams(maxSteps = 5) {
  return {
    budget: {
      max_cost_usd: 100,
      max_steps: maxSteps,
      max_tokens: 10_000,
      max_wall_clock_s: 3600,
    },
    charter: {
      approval_gate_ref: 'gate://idea.mutation',
      campaign_name: 'mutation-suite',
      domain: 'hep-ph',
      scope: 'mutation coverage for TS idea runtime authority',
    },
    idempotency_key: 'mutation-init',
    seed_pack: {
      seeds: [{ content: 'seed-a', seed_type: 'text' }],
    },
  };
}

describe('campaign mutation RPC', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pauses, resumes, and completes through the write-side RPC surface', () => {
    const { rootDir, service } = createService('idea-engine-mutation-');
    tempDirs.push(rootDir);

    const init = service.handle('campaign.init', initParams()) as Record<string, unknown>;
    const campaignId = String(init.campaign_id);

    const paused = service.handle('campaign.pause', {
      campaign_id: campaignId,
      idempotency_key: 'pause-1',
    }) as Record<string, unknown>;
    expect((paused.transition as Record<string, unknown>).current_status).toBe('paused');

    const resumed = service.handle('campaign.resume', {
      campaign_id: campaignId,
      idempotency_key: 'resume-1',
    }) as Record<string, unknown>;
    expect((resumed.transition as Record<string, unknown>).current_status).toBe('running');

    const completed = service.handle('campaign.complete', {
      campaign_id: campaignId,
      idempotency_key: 'complete-1',
    }) as Record<string, unknown>;
    expect((completed.transition as Record<string, unknown>).current_status).toBe('completed');
    expect((completed.transition as Record<string, unknown>).changed).toBe(true);
  });

  it('tops up an exhausted campaign back to running', () => {
    const { rootDir, service } = createService('idea-engine-topup-');
    tempDirs.push(rootDir);

    const init = service.handle('campaign.init', initParams(1)) as Record<string, unknown>;
    const campaignId = String(init.campaign_id);

    service.handle('search.step', {
      campaign_id: campaignId,
      n_steps: 1,
      idempotency_key: 'search-exhaust',
    });

    const topup = service.handle('campaign.topup', {
      campaign_id: campaignId,
      topup: { add_steps: 2 },
      idempotency_key: 'topup-1',
    }) as Record<string, unknown>;

    expect((topup.transition as Record<string, unknown>).previous_status).toBe('exhausted');
    expect((topup.transition as Record<string, unknown>).current_status).toBe('running');
    expect((topup.transition as Record<string, unknown>).changed).toBe(true);
    expect((topup.campaign_status as Record<string, unknown>).status).toBe('running');
  });
});
