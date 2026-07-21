import { appendFileSync, readFileSync, rmSync } from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  crash,
  currentNode,
  enterReview,
  expectRpcError,
  fresh,
  initCampaign,
  logEntries,
  reviseParams,
  runCli,
} from './helpers/revise-card-test-fixture.js';

describe('node.revise_card crash recovery', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  for (const crashPoint of ['after_prepare', 'after_node', 'during_log', 'after_log']) {
    it(`recovers durably after a real process restart at ${crashPoint}`, () => {
      const { rootDir, service } = fresh(tempDirs, `idea-revise-crash-${crashPoint}-`);
      const { campaignId, nodeId } = initCampaign(service);
      const params = reviseParams(campaignId, nodeId, currentNode(service, campaignId, nodeId), `crash-${crashPoint}`);
      expect(crash(rootDir, params, crashPoint)).toBeGreaterThanOrEqual(91);

      const retry = runCli(rootDir, params);
      expect(retry.status).toBe(0);
      const result = retry.response.result as Record<string, unknown>;
      expect((result.node as Record<string, unknown>).revision).toBe(2);
      expect((result.idempotency as Record<string, unknown>).is_replay).toBe(true);
      expect((result.node as Record<string, unknown>).updated_at).toBe('2026-07-21T08:00:00.000Z');
      const rawLines = readFileSync(service.read.store.nodesLogPath(campaignId), 'utf8').split('\n').filter(Boolean);
      expect(() => rawLines.map((line) => JSON.parse(line))).not.toThrow();
      expect(rawLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.mutation === 'revise_card')).toHaveLength(1);
    });
  }

  it('refuses a late recovery event after a newer same-node mutation', () => {
    const { rootDir, service } = fresh(tempDirs, 'idea-revise-ordering-');
    const { campaignId, nodeId } = initCampaign(service);
    const params = reviseParams(campaignId, nodeId, currentNode(service, campaignId, nodeId), 'ordering-key');
    expect(crash(rootDir, params, 'after_node')).toBe(92);
    enterReview(service, campaignId, nodeId, 'later-review');

    const retry = runCli(rootDir, params);
    expect(retry.status).toBe(1);
    const error = retry.response.error as Record<string, unknown>;
    expect(error).toMatchObject({ code: -32603, message: 'internal_error' });
    expect((error.data as Record<string, unknown>).reason).toBe('idea_card_revision_recovery_conflict');
    expect(logEntries(service, campaignId).filter((entry) => entry.mutation === 'revise_card')).toHaveLength(0);
  });

  it('fails closed on interior JSONL corruption and an unrelated torn final fragment', () => {
    for (const corruption of ['interior', 'unrelated-final']) {
      const { rootDir, service } = fresh(tempDirs, `idea-revise-corrupt-${corruption}-`);
      const { campaignId, nodeId } = initCampaign(service, `init-${corruption}`);
      const params = reviseParams(campaignId, nodeId, currentNode(service, campaignId, nodeId), `corrupt-${corruption}`);
      expect(crash(rootDir, params, 'after_node')).toBe(92);
      appendFileSync(service.read.store.nodesLogPath(campaignId), corruption === 'interior' ? '{malformed}\n' : '{"mutation":"unrelated"', 'utf8');
      const retry = runCli(rootDir, params);
      expect(retry.status).toBe(1);
      const error = retry.response.error as Record<string, unknown>;
      expect((error.data as Record<string, unknown>).reason).toBe('idea_card_revision_recovery_conflict');
    }
  });

  it('refuses a fresh revision before any write when the existing ledger is corrupt', () => {
    const { service } = fresh(tempDirs, 'idea-revise-preflight-corrupt-');
    const { campaignId, nodeId } = initCampaign(service);
    const before = currentNode(service, campaignId, nodeId);
    appendFileSync(service.read.store.nodesLogPath(campaignId), '{malformed}\n', 'utf8');

    expectRpcError(() => service.handle('node.revise_card', reviseParams(campaignId, nodeId, before, 'preflight-corrupt')), -32603, 'idea_card_revision_recovery_conflict');
    expect(currentNode(service, campaignId, nodeId)).toEqual(before);
    const stored = service.read.store.loadIdempotency<Record<string, unknown>>(campaignId)['node.revise_card:preflight-corrupt']!;
    expect(stored.state).toBe('committed');
    expect((stored.response as Record<string, unknown>).kind).toBe('error');
  });
});
