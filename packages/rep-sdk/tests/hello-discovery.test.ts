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
        messageId: '06c2b3f4',
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
        messageId: '9bdb70cb',
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
        messageId: '6a0c96d0',
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
        messageId: '7789d378',
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
        message_id: '6a0c96d0',
        timestamp: '2026-03-25T10:00:00.000Z',
        capabilities: ['strategy_publish', 'outcome_review'],
        domain: 'hep-th',
        agent_name: 'Agent Alpha',
        agent_version: '0.2.0',
      },
      {
        sender_id: 'agent-beta',
        message_id: '7789d378',
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
