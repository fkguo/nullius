import { existsSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTRACT_DIR, OPENRPC_PATH } from '../src/contracts/openrpc.js';

describe('runtime asset authority', () => {
  it('keeps the default contract snapshot package-local to idea-engine', () => {
    expect(DEFAULT_CONTRACT_DIR).toContain('/packages/idea-engine/contracts/');
    expect(DEFAULT_CONTRACT_DIR).not.toContain('/packages/idea-core/');
    expect(OPENRPC_PATH).toContain('/packages/idea-engine/contracts/');
    expect(OPENRPC_PATH).not.toContain('/packages/idea-core/');
    expect(existsSync(OPENRPC_PATH)).toBe(true);
  });
});
