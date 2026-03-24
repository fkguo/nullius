import type {
  RepEnvelope,
  RepEnvelopeByType,
  RepEnvelopePayloadMap,
  RepMessageType,
  RepSignature,
} from '../model/rep-envelope.js';
import { createEnvelope } from '../protocol/envelope.js';
import type { RepTransport } from '../transport/rep-transport.js';
import { formatValidationIssues } from '../validation/result.js';
import { validateEnvelope } from '../validation/envelope-validation.js';

export interface RepSendOptions {
  recipientId?: string;
  messageId?: string;
  timestamp?: string;
  traceId?: string;
  signature?: RepSignature;
}

export interface CreateRepClientOptions {
  senderId: string;
  transport: RepTransport;
  protocolVersion?: string;
}

export interface RepClient {
  send<TType extends RepMessageType>(
    messageType: TType,
    payload: RepEnvelopePayloadMap[TType],
    options?: RepSendOptions,
  ): Promise<RepEnvelopeByType[TType]>;
  hello(payload: RepEnvelopePayloadMap['hello'], options?: RepSendOptions): Promise<RepEnvelopeByType['hello']>;
  publish(
    payload: RepEnvelopePayloadMap['publish'],
    options?: RepSendOptions,
  ): Promise<RepEnvelopeByType['publish']>;
  fetch(payload: RepEnvelopePayloadMap['fetch'], options?: RepSendOptions): Promise<RepEnvelopeByType['fetch']>;
  report(payload: RepEnvelopePayloadMap['report'], options?: RepSendOptions): Promise<RepEnvelopeByType['report']>;
  review(payload: RepEnvelopePayloadMap['review'], options?: RepSendOptions): Promise<RepEnvelopeByType['review']>;
  revoke(payload: RepEnvelopePayloadMap['revoke'], options?: RepSendOptions): Promise<RepEnvelopeByType['revoke']>;
  list(): Promise<RepEnvelope[]>;
}

export function createRepClient(options: CreateRepClientOptions): RepClient {
  async function send<TType extends RepMessageType>(
    messageType: TType,
    payload: RepEnvelopePayloadMap[TType],
    sendOptions: RepSendOptions = {},
  ): Promise<RepEnvelopeByType[TType]> {
    const envelope = createEnvelope({
      messageType,
      payload,
      senderId: options.senderId,
      protocolVersion: options.protocolVersion,
      recipientId: sendOptions.recipientId,
      messageId: sendOptions.messageId,
      timestamp: sendOptions.timestamp,
      traceId: sendOptions.traceId,
      signature: sendOptions.signature,
    });

    const validation = validateEnvelope(envelope);
    if (!validation.ok || !validation.data) {
      throw new Error(`Invalid REP envelope: ${formatValidationIssues(validation.issues)}`);
    }

    await options.transport.append(validation.data);
    return validation.data as RepEnvelopeByType[TType];
  }

  return {
    send,
    hello: (payload, sendOptions) => send('hello', payload, sendOptions),
    publish: (payload, sendOptions) => send('publish', payload, sendOptions),
    fetch: (payload, sendOptions) => send('fetch', payload, sendOptions),
    report: (payload, sendOptions) => send('report', payload, sendOptions),
    review: (payload, sendOptions) => send('review', payload, sendOptions),
    revoke: (payload, sendOptions) => send('revoke', payload, sendOptions),
    list: () => options.transport.readAll(),
  };
}
