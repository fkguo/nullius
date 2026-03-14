import { createHash } from 'crypto';
import { createRequire } from 'module';
import { getMethodContract } from '../contracts/openrpc.js';

const require = createRequire(import.meta.url);
const canonicalize = require('canonicalize') as (input: unknown) => string | undefined;

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export function canonicalJson(value: unknown): string {
  const canonical = canonicalize(value);
  if (typeof canonical !== 'string') {
    throw new TypeError('canonicalization_failed');
  }
  return canonical;
}

export function payloadHash(value: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

export function hashWithoutIdempotency(
  method: string,
  params: Record<string, unknown>,
): string {
  const filtered = Object.fromEntries(
    Object.entries(params)
      .filter(([key]) => key !== 'idempotency_key')
      .map(([key, value]) => [key, cloneValue(value)]),
  );

  for (const param of getMethodContract(method)?.params ?? []) {
    if (param.name in filtered) {
      continue;
    }
    if (param.schema && 'default' in param.schema) {
      filtered[param.name] = cloneValue(param.schema.default);
    }
  }

  return payloadHash(filtered);
}
