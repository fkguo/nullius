import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashCanonicalValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function hashWithoutField<T extends object>(value: T, field: string): string {
  const clone = { ...value } as Record<string, unknown>;
  delete clone[field];
  return hashCanonicalValue(clone);
}

export function assignContentAddress<T extends object, K extends keyof T & string>(
  value: T,
  field: K,
): T {
  return {
    ...value,
    [field]: hashWithoutField(value, field),
  };
}
