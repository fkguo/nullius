import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEnvelope } from '../src/index.js';
import { createRepClient } from '../src/client/index.js';
import { createRepServer } from '../src/server/index.js';
import { FileTransport } from '../src/transport/index.js';
import { createOutcome, createOutcomePublishedEvent, createStrategy } from './fixtures.js';

describe('client/server API', () => {
  it('lets the thin client and server share the same bounded transport surface', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'rep-sdk-client-server-'));
    const transport = new FileTransport({ filePath: join(workDir, 'messages.jsonl') });
    const client = createRepClient({ senderId: 'agent-alpha', transport });
    const server = createRepServer({ transport });

    const strategy = createStrategy();
    const outcome = createOutcome(strategy);

    await client.hello({ capabilities: ['strategy_publish'], domain: 'hep-th' });
    await client.publish({ asset_type: 'strategy', asset: strategy });
    await client.report({ event: createOutcomePublishedEvent(outcome) });

    const revokeEnvelope = createEnvelope({
      messageType: 'revoke',
      senderId: 'agent-beta',
      payload: {
        target_asset_id: outcome.outcome_id,
        reason: 'outcome replaced by a later revision',
      },
    });

    const ingestResult = await server.ingest(revokeEnvelope);
    const publishMessages = await server.listByType('publish');
    const revokeMessages = await server.listByType('revoke');

    expect(ingestResult.ok).toBe(true);
    expect(publishMessages).toHaveLength(1);
    expect(revokeMessages).toHaveLength(1);
  });
});
