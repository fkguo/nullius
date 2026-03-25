import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverAgentAdvertisements } from '../src/discovery/index.js';
import { createEnvelope } from '../src/index.js';
import { FileTransport } from '../src/transport/index.js';
import { createStrategy } from './fixtures.js';

describe('hello discovery', () => {
  it('dedupes hello advertisements by sender and keeps the latest timestamped message', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'rep-sdk-hello-discovery-'));
    const transport = new FileTransport({ filePath: join(workDir, 'messages.jsonl') });

    await transport.append(
      createEnvelope({
        messageType: 'hello',
        senderId: 'agent-alpha',
        timestamp: '2026-03-25T09:00:00.000Z',
        messageId: '06c2b3f4-2c59-4f05-9b26-3e2b226618c1',
        payload: {
          capabilities: ['strategy_publish'],
          domain: 'hep-th',
          agent_name: 'Agent Alpha',
          agent_version: '0.1.0',
        },
      }),
    );
    await transport.append(
      createEnvelope({
        messageType: 'publish',
        senderId: 'agent-alpha',
        messageId: '9bdb70cb-8be1-460a-8821-a59b15afb80d',
        payload: {
          asset_type: 'strategy',
          asset: createStrategy(),
        },
      }),
    );
    await transport.append(
      createEnvelope({
        messageType: 'hello',
        senderId: 'agent-alpha',
        timestamp: '2026-03-25T10:00:00.000Z',
        messageId: '6a0c96d0-9df8-45fc-b6b8-813fe620688a',
        payload: {
          capabilities: ['strategy_publish', 'outcome_review'],
          domain: 'hep-th',
          agent_name: 'Agent Alpha',
          agent_version: '0.2.0',
        },
      }),
    );
    await transport.append(
      createEnvelope({
        messageType: 'hello',
        senderId: 'agent-beta',
        timestamp: '2026-03-25T09:30:00.000Z',
        messageId: '7789d378-863f-417e-93e6-d8452a5619f7',
        payload: {
          capabilities: ['integrity_check'],
          domain: 'theory',
          agent_name: 'Agent Beta',
          agent_version: '1.0.0',
          supported_check_domains: ['ward'],
        },
      }),
    );

    const advertisements = await discoverAgentAdvertisements(transport);

    expect(advertisements).toEqual([
      {
        sender_id: 'agent-alpha',
        message_id: '6a0c96d0-9df8-45fc-b6b8-813fe620688a',
        timestamp: '2026-03-25T10:00:00.000Z',
        capabilities: ['strategy_publish', 'outcome_review'],
        domain: 'hep-th',
        agent_name: 'Agent Alpha',
        agent_version: '0.2.0',
      },
      {
        sender_id: 'agent-beta',
        message_id: '7789d378-863f-417e-93e6-d8452a5619f7',
        timestamp: '2026-03-25T09:30:00.000Z',
        capabilities: ['integrity_check'],
        domain: 'theory',
        agent_name: 'Agent Beta',
        agent_version: '1.0.0',
        supported_check_domains: ['ward'],
      },
    ]);
    expect('recipient_id' in advertisements[0]).toBe(false);
    expect('trace_id' in advertisements[0]).toBe(false);
  });
});
