import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISCOVERY_PROVIDER_DESCRIPTORS as registryDiscoveryProviderDescriptors,
  INSPIRE_DISCOVERY_DESCRIPTOR as registryInspireDiscoveryDescriptor,
} from '../../src/tools/registry/shared.js';
import {
  DISCOVERY_PROVIDER_DESCRIPTORS as discoveryProviderDescriptors,
  INSPIRE_DISCOVERY_DESCRIPTOR as discoveryInspireDiscoveryDescriptor,
} from '../../src/tools/research/discovery/providerDescriptors.js';

function readUtf8(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

describe('provider discovery descriptor boundaries', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.resolve(here, '../..');
  const registrySharedPath = path.resolve(pkgRoot, 'src/tools/registry/shared.ts');
  const discoveryProviderDescriptorsPath = path.resolve(pkgRoot, 'src/tools/research/discovery/providerDescriptors.ts');

  it('reuses the same INSPIRE descriptor object across registry and discovery surfaces', () => {
    expect(registryInspireDiscoveryDescriptor).toBe(discoveryInspireDiscoveryDescriptor);
    expect(registryDiscoveryProviderDescriptors[0]).toBe(discoveryInspireDiscoveryDescriptor);
    expect(discoveryProviderDescriptors[0]).toBe(discoveryInspireDiscoveryDescriptor);
    expect(registryDiscoveryProviderDescriptors.map(descriptor => descriptor.provider)).toEqual(['inspire', 'openalex', 'arxiv']);
    expect(discoveryProviderDescriptors.map(descriptor => descriptor.provider)).toEqual(['inspire', 'openalex', 'arxiv']);
  });

  it('keeps provider-neutral INSPIRE descriptor definition centralized in the discovery submodule', () => {
    const registryShared = readUtf8(registrySharedPath);
    const discoveryProviderDescriptorsSource = readUtf8(discoveryProviderDescriptorsPath);

    expect(discoveryProviderDescriptorsSource).toContain('export const INSPIRE_DISCOVERY_DESCRIPTOR');
    expect(registryShared).toContain("import { INSPIRE_DISCOVERY_DESCRIPTOR } from '../research/discovery/providerDescriptors.js'");
    expect(registryShared).not.toContain('export const INSPIRE_DISCOVERY_DESCRIPTOR');

    const inspireDefinitionMatches = [
      ...registryShared.matchAll(/DiscoveryProviderDescriptorSchema\.parse\(\{\s*provider:\s*'inspire'/g),
      ...discoveryProviderDescriptorsSource.matchAll(/DiscoveryProviderDescriptorSchema\.parse\(\{\s*provider:\s*'inspire'/g),
    ];
    expect(inspireDefinitionMatches).toHaveLength(1);
  });
});
