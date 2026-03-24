import type { RepEnvelope } from '../model/rep-envelope.js';

export interface RepTransport {
  append(envelope: RepEnvelope): Promise<void>;
  readAll(): Promise<RepEnvelope[]>;
}
