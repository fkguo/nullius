import type { RepEnvelopeByType } from '../model/rep-envelope.js';
import type { RepTransport } from '../transport/rep-transport.js';

export interface AgentAdvertisement {
  sender_id: string;
  message_id: string;
  timestamp: string;
  recipient_id?: string;
  trace_id?: string;
  capabilities: string[];
  domain: string;
  agent_name?: string;
  agent_version?: string;
  supported_check_domains?: string[];
}

export async function discoverAgentAdvertisements(
  transport: RepTransport,
): Promise<AgentAdvertisement[]> {
  const latestBySender = new Map<string, RepEnvelopeByType['hello']>();

  for (const envelope of await transport.readAll()) {
    if (envelope.message_type !== 'hello') {
      continue;
    }
    const current = latestBySender.get(envelope.sender_id);
    if (!current || compareHelloEnvelopes(envelope, current) > 0) {
      latestBySender.set(envelope.sender_id, envelope);
    }
  }

  return [...latestBySender.values()]
    .sort((left, right) => left.sender_id.localeCompare(right.sender_id))
    .map(toAgentAdvertisement);
}

function compareHelloEnvelopes(
  left: RepEnvelopeByType['hello'],
  right: RepEnvelopeByType['hello'],
): number {
  const leftTimestamp = Date.parse(left.timestamp);
  const rightTimestamp = Date.parse(right.timestamp);
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  return left.message_id.localeCompare(right.message_id);
}

function toAgentAdvertisement(envelope: RepEnvelopeByType['hello']): AgentAdvertisement {
  return {
    sender_id: envelope.sender_id,
    message_id: envelope.message_id,
    timestamp: envelope.timestamp,
    ...(envelope.recipient_id !== undefined ? { recipient_id: envelope.recipient_id } : {}),
    ...(envelope.trace_id !== undefined ? { trace_id: envelope.trace_id } : {}),
    ...envelope.payload,
  };
}
