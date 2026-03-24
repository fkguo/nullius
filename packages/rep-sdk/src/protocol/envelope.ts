import { randomUUID } from 'node:crypto';
import type {
  RepEnvelope,
  RepEnvelopeByType,
  RepEnvelopePayloadMap,
  RepMessageType,
  RepSignature,
} from '../model/rep-envelope.js';
import { hashCanonicalValue } from './content-hash.js';

export interface CreateEnvelopeOptions<TType extends RepMessageType> {
  messageType: TType;
  senderId: string;
  payload: RepEnvelopePayloadMap[TType];
  protocolVersion?: string;
  messageId?: string;
  recipientId?: string;
  timestamp?: string;
  traceId?: string;
  signature?: RepSignature;
}

export function createEnvelope<TType extends RepMessageType>(
  options: CreateEnvelopeOptions<TType>,
): RepEnvelopeByType[TType] {
  return {
    protocol: 'rep-a2a',
    protocol_version: options.protocolVersion ?? '1.0',
    message_type: options.messageType,
    message_id: options.messageId ?? randomUUID(),
    sender_id: options.senderId,
    recipient_id: options.recipientId,
    timestamp: options.timestamp ?? new Date().toISOString(),
    content_hash: hashCanonicalValue(options.payload),
    payload: options.payload,
    signature: options.signature,
    trace_id: options.traceId,
  } as RepEnvelopeByType[TType];
}

export function serializeEnvelope(envelope: RepEnvelope): string {
  return JSON.stringify(envelope);
}

export function parseEnvelope(serialized: string): unknown {
  return JSON.parse(serialized) as unknown;
}
