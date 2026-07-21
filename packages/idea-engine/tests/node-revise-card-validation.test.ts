import { rmSync } from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentNode,
  enterReview,
  expectRpcError,
  fresh,
  initCampaign,
  logEntries,
  replacementCard,
  reviseParams,
} from './helpers/revise-card-test-fixture.js';

describe('node.revise_card validation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('persists the first stale error and never turns the same key into a later mutation', () => {
    const { service } = fresh(tempDirs, 'idea-revise-error-replay-');
    const { campaignId, nodeId } = initCampaign(service);
    const node = currentNode(service, campaignId, nodeId);
    const params = {
      ...reviseParams(campaignId, nodeId, node, 'stale-error-replay'),
      expected_revision: Number(node.revision) + 1,
    };
    const first = expectRpcError(() => service.handle('node.revise_card', params), -32019, 'stale_revision');

    enterReview(service, campaignId, nodeId, 'intervening-review');
    const second = expectRpcError(() => service.handle('node.revise_card', params), -32019, 'stale_revision');
    expect(second.message).toBe(first.message);
    expect(second.data).toEqual(first.data);
    expect(currentNode(service, campaignId, nodeId).revision).toBe(params.expected_revision);
    expect(logEntries(service, campaignId).filter((entry) => entry.mutation === 'revise_card')).toHaveLength(0);
    const stored = service.read.store.loadIdempotency<Record<string, unknown>>(campaignId)['node.revise_card:stale-error-replay']!;
    expect(stored.state).toBe('committed');
    expect((stored.response as Record<string, unknown>).kind).toBe('error');
  });

  it('uses authoritative card validation, rejects blank and canonically unchanged replacements, and preserves string bytes', () => {
    const { service } = fresh(tempDirs, 'idea-revise-validation-');
    const { campaignId, nodeId } = initCampaign(service);
    const node = currentNode(service, campaignId, nodeId);
    const card = structuredClone(node.idea_card) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(card).reverse());
    expectRpcError(
      () =>
        service.handle('node.revise_card', {
          ...reviseParams(campaignId, nodeId, node, 'same-card'),
          replacement_idea_card: reordered,
        }),
      -32002,
      'replacement_idea_card_unchanged',
    );
    expectRpcError(
      () =>
        service.handle('node.revise_card', {
          ...reviseParams(campaignId, nodeId, node, 'blank-reason'),
          reason: '   ',
        }),
      -32002,
      'schema_invalid',
    );
    const invalid = replacementCard(node, 'too short');
    expectRpcError(
      () =>
        service.handle('node.revise_card', {
          ...reviseParams(campaignId, nodeId, node, 'invalid-card'),
          replacement_idea_card: invalid,
        }),
      -32002,
      'schema_invalid',
    );
  });
});
