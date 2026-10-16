import { describe, expect, it } from 'vitest';
import { riskToAnnotations, structuredContentOf, toolAnnotationsFor } from '../index.js';

describe('riskToAnnotations', () => {
  it('maps a read to read-only, non-destructive and idempotent whatever the entry says', () => {
    expect(riskToAnnotations('read', { idempotent: false, openWorld: true, reason: 'r' })).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('maps an additive write to non-destructive and idempotent only when stated', () => {
    expect(riskToAnnotations('write', { openWorld: false, reason: 'r' })).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(riskToAnnotations('write', { idempotent: true, openWorld: false, reason: 'r' }).idempotentHint).toBe(true);
  });

  it('lets an entry raise destructiveHint for a write, never for a read', () => {
    expect(riskToAnnotations('write', { destructive: true, openWorld: false, reason: 'r' }).destructiveHint).toBe(true);
    expect(riskToAnnotations('read', { destructive: true, openWorld: false, reason: 'r' }).destructiveHint).toBe(false);
  });

  it('maps destructive to destructiveHint true', () => {
    expect(riskToAnnotations('destructive', { openWorld: true, reason: 'r' })).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});

describe('toolAnnotationsFor', () => {
  it('refuses a tool missing from either table', () => {
    expect(() => toolAnnotationsFor('t', {}, { t: { openWorld: false, reason: 'r' } })).toThrow(/risk level/);
    expect(() => toolAnnotationsFor('t', { t: 'read' }, {})).toThrow(/behaviour hints/);
  });
});

describe('structuredContentOf', () => {
  it('returns plain objects and leaves out values that are not JSON objects', () => {
    const obj = { a: 1 };
    expect(structuredContentOf(obj)).toBe(obj);
    for (const value of ['x', 1, null, undefined, [1], new Date(0)]) {
      expect(structuredContentOf(value)).toBeUndefined();
    }
  });
});
