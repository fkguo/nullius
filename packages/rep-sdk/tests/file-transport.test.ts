import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEnvelope } from '../src/index.js';
import { FileTransport } from '../src/transport/index.js';

describe('FileTransport', () => {
  it('round-trips JSONL envelopes through the local file transport', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'rep-sdk-transport-'));
    const transport = new FileTransport({ filePath: join(workDir, 'messages.jsonl') });

    const envelope = createEnvelope({
      messageType: 'hello',
      senderId: 'agent-alpha',
      payload: { capabilities: ['strategy_publish'], domain: 'hep-th' },
    });

    await transport.append(envelope);
    const stored = await transport.readAll();

    expect(stored).toHaveLength(1);
    expect(stored[0]?.message_type).toBe('hello');
    expect(stored[0]?.sender_id).toBe('agent-alpha');
  });

  it('rejects invalid envelopes before they hit disk', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'rep-sdk-transport-'));
    const transport = new FileTransport({ filePath: join(workDir, 'messages.jsonl') });

    const invalidEnvelope = {
      ...createEnvelope({
        messageType: 'hello',
        senderId: 'agent-alpha',
        payload: { capabilities: ['strategy_publish'], domain: 'hep-th' },
      }),
      content_hash: '0'.repeat(64),
    };

    await expect(transport.append(invalidEnvelope)).rejects.toThrow(/content_hash/);
  });

  it('treats a missing JSONL log as an empty envelope list', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'rep-sdk-transport-'));
    const transport = new FileTransport({ filePath: join(workDir, 'missing.jsonl') });

    await expect(transport.readAll()).resolves.toEqual([]);
  });
});
