import type { RepEnvelope, RepMessageType } from '../model/rep-envelope.js';
import type { RepTransport } from '../transport/rep-transport.js';
import { validateEnvelope } from '../validation/envelope-validation.js';
import type { ValidationResult } from '../validation/result.js';

export interface CreateRepServerOptions {
  transport: RepTransport;
}

export interface RepServer {
  ingest(input: unknown): Promise<ValidationResult<RepEnvelope>>;
  list(): Promise<RepEnvelope[]>;
  listByType(messageType: RepMessageType): Promise<RepEnvelope[]>;
}

export function createRepServer(options: CreateRepServerOptions): RepServer {
  return {
    async ingest(input: unknown): Promise<ValidationResult<RepEnvelope>> {
      const validation = validateEnvelope(input);
      if (validation.ok && validation.data) {
        await options.transport.append(validation.data);
      }
      return validation;
    },
    list: () => options.transport.readAll(),
    async listByType(messageType: RepMessageType): Promise<RepEnvelope[]> {
      const envelopes = await options.transport.readAll();
      return envelopes.filter((envelope) => envelope.message_type === messageType);
    },
  };
}
