import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const canonicalize = require('canonicalize') as (value: unknown) => string | undefined;

export function canonicalJson(value: unknown): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) {
    throw new TypeError('Unable to canonicalize the provided REP value.');
  }
  return serialized;
}
