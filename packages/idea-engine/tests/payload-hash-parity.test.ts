import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { hashWithoutIdempotency, payloadHash } from '../src/hash/payload-hash.js';

interface PayloadCase {
  name: string;
  payload: Record<string, unknown>;
  expected_hash: string;
}

interface MethodCase {
  name: string;
  method: string;
  params: Record<string, unknown>;
  expected_hash: string;
}

interface PayloadHashFixture {
  payload_cases: PayloadCase[];
  method_cases: MethodCase[];
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixturePath = resolve(repoRoot, 'packages/idea-engine/tests/fixtures/payload-hash-golden.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as PayloadHashFixture;

describe('payload hash parity', () => {
  for (const payloadCase of fixture.payload_cases) {
    it(`matches Python hash for ${payloadCase.name}`, () => {
      expect(payloadHash(payloadCase.payload)).toBe(payloadCase.expected_hash);
    });
  }

  for (const methodCase of fixture.method_cases) {
    it(`matches Python _hash_without_idempotency for ${methodCase.name}`, () => {
      expect(hashWithoutIdempotency(methodCase.method, methodCase.params)).toBe(methodCase.expected_hash);
    });
  }

  it('is stable under reordered object keys and nested keys', () => {
    const reordered = {
      alpha: {
        beta: [3, { γ: 1.25, δ: '非ASCII' }, 1],
        omega: '粒子κ',
      },
      zeta: '最后',
    };
    expect(payloadHash(reordered)).toBe(fixture.payload_cases[0]?.expected_hash);
  });

  it('fills method defaults before hashing', () => {
    expect(fixture.method_cases[0]?.expected_hash).toBe(fixture.method_cases[1]?.expected_hash);
  });
});
