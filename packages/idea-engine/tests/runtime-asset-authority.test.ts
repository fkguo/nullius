import { existsSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTRACT_DIR, OPENRPC_PATH } from '../src/contracts/openrpc.js';
import { HEP_BUILTIN_PACK_CATALOG_PATH, loadHepBuiltinDomainPackProviders } from '../src/service/hep-domain-pack.js';

describe('runtime asset authority', () => {
  it('keeps the default contract snapshot package-local to idea-engine', () => {
    expect(DEFAULT_CONTRACT_DIR).toContain('/packages/idea-engine/contracts/');
    expect(DEFAULT_CONTRACT_DIR).not.toContain('/packages/idea-core/');
    expect(OPENRPC_PATH).toContain('/packages/idea-engine/contracts/');
    expect(OPENRPC_PATH).not.toContain('/packages/idea-core/');
    expect(existsSync(OPENRPC_PATH)).toBe(true);
  });

  it('keeps the builtin hep pack catalog package-local to idea-engine', () => {
    expect(HEP_BUILTIN_PACK_CATALOG_PATH).toContain('/packages/idea-engine/assets/');
    expect(HEP_BUILTIN_PACK_CATALOG_PATH).not.toContain('/packages/idea-core/');
    expect(existsSync(HEP_BUILTIN_PACK_CATALOG_PATH)).toBe(true);
    expect(loadHepBuiltinDomainPackProviders().map((provider) => provider.entry.pack_id)).toContain('hep.operators.v1');
  });
});
