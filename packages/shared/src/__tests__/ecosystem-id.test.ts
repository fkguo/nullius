import { describe, it, expect } from 'vitest';
import {
  parseEcosystemId,
  isValidEcosystemId,
  makeEcosystemId,
  isValidOpaque,
  EcosystemIdError,
  ECOSYSTEM_ID_PREFIXES,
} from '../ecosystem-id.js';

describe('ECOSYSTEM_ID_PREFIXES', () => {
  it('should contain all expected prefixes', () => {
    expect(ECOSYSTEM_ID_PREFIXES.proj).toBe('proj');
    expect(ECOSYSTEM_ID_PREFIXES.run).toBe('run');
    expect(ECOSYSTEM_ID_PREFIXES.art).toBe('art');
    expect(ECOSYSTEM_ID_PREFIXES.evt).toBe('evt');
    expect(ECOSYSTEM_ID_PREFIXES.sig).toBe('sig');
    expect(ECOSYSTEM_ID_PREFIXES.gate).toBe('gate');
    expect(ECOSYSTEM_ID_PREFIXES.step).toBe('step');
    expect(ECOSYSTEM_ID_PREFIXES.camp).toBe('camp');
  });
});

describe('parseEcosystemId', () => {
  it('should parse valid IDs', () => {
    const result = parseEcosystemId('run_a1b2c3d4');
    expect(result.prefix).toBe('run');
    expect(result.opaque).toBe('a1b2c3d4');
    expect(result.raw).toBe('run_a1b2c3d4');
  });

  it('should parse IDs with dots and hyphens', () => {
    const result = parseEcosystemId('art_my-file.json');
    expect(result.prefix).toBe('art');
    expect(result.opaque).toBe('my-file.json');
  });

  it('should reject empty string', () => {
    expect(() => parseEcosystemId('')).toThrow(EcosystemIdError);
  });

  it('should reject missing prefix', () => {
    expect(() => parseEcosystemId('abc123')).toThrow(EcosystemIdError);
  });

  it('should reject unknown prefix', () => {
    expect(() => parseEcosystemId('foo_abc123')).toThrow(/Unknown EcosystemID prefix/);
  });

  it('should reject path separators in opaque', () => {
    expect(() => parseEcosystemId('run_a/b')).toThrow(EcosystemIdError);
    expect(() => parseEcosystemId('run_a\\b')).toThrow(EcosystemIdError);
  });

  it('should reject ".." in opaque', () => {
    expect(() => parseEcosystemId('run_a..b')).toThrow(/must not contain/);
  });

  it('should reject empty opaque', () => {
    expect(() => parseEcosystemId('run_')).toThrow(EcosystemIdError);
  });

  it('should reject spaces in opaque', () => {
    expect(() => parseEcosystemId('run_a b')).toThrow(EcosystemIdError);
  });
});

describe('isValidEcosystemId', () => {
  it('should return true for valid IDs', () => {
    expect(isValidEcosystemId('proj_550e8400')).toBe(true);
    expect(isValidEcosystemId('run_abc-def.123')).toBe(true);
    expect(isValidEcosystemId('gate_my_gate')).toBe(true);
  });

  it('should return false for invalid IDs', () => {
    expect(isValidEcosystemId('')).toBe(false);
    expect(isValidEcosystemId('invalid')).toBe(false);
    expect(isValidEcosystemId('foo_bar')).toBe(false);
    expect(isValidEcosystemId('run_a..b')).toBe(false);
  });
});

describe('makeEcosystemId', () => {
  it('should construct valid IDs', () => {
    const id = makeEcosystemId('run', 'abc123');
    expect(id).toBe('run_abc123');
  });

  it('should reject unknown prefix', () => {
    expect(() => makeEcosystemId('bad' as any, 'abc')).toThrow(EcosystemIdError);
  });

  it('should reject invalid opaque', () => {
    expect(() => makeEcosystemId('run', '')).toThrow(EcosystemIdError);
    expect(() => makeEcosystemId('run', 'a/b')).toThrow(EcosystemIdError);
    expect(() => makeEcosystemId('run', 'a..b')).toThrow(EcosystemIdError);
  });

  it('should produce round-trippable IDs', () => {
    const id = makeEcosystemId('proj', 'my-project.v2');
    const parsed = parseEcosystemId(id);
    expect(parsed.prefix).toBe('proj');
    expect(parsed.opaque).toBe('my-project.v2');
  });
});

describe('isValidOpaque', () => {
  it('should accept valid opaque strings', () => {
    expect(isValidOpaque('abc123')).toBe(true);
    expect(isValidOpaque('my-file.json')).toBe(true);
    expect(isValidOpaque('a_b_c')).toBe(true);
  });

  it('should reject invalid opaque strings', () => {
    expect(isValidOpaque('')).toBe(false);
    expect(isValidOpaque('a/b')).toBe(false);
    expect(isValidOpaque('a..b')).toBe(false);
    expect(isValidOpaque('a b')).toBe(false);
  });
});
