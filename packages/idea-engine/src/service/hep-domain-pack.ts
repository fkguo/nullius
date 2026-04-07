import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import type { BuiltinDomainPackProvider, DomainPackEntry } from './domain-pack-types.js';
import { buildHepLibrarianRecipeBook } from './hep-librarian-recipe-book.js';
import { buildHepSearchDomainPackRuntime } from './hep-search-runtime.js';

// Keep the live TS builtin-pack authority package-local to idea-engine rather
// than inheriting default runtime assets from the legacy Python package.
export const HEP_BUILTIN_PACK_CATALOG_PATH = resolve(
  fileURLToPath(new URL('../../assets/hep_builtin_domain_packs.json', import.meta.url)),
);

function hepBuiltinPackCatalogEntries(): DomainPackEntry[] {
  const payload = JSON.parse(readFileSync(HEP_BUILTIN_PACK_CATALOG_PATH, 'utf8')) as { packs?: DomainPackEntry[] };
  return payload.packs ?? [];
}

function buildHepBuiltinProvider(entry: DomainPackEntry): BuiltinDomainPackProvider {
  return {
    entry,
    buildLibrarianRecipeBook: () => buildHepLibrarianRecipeBook(),
    loadSearchDomainPackRuntime: () => {
      if (entry.operator_source !== 'hep_operator_families_m32') {
        throw new Error(`unknown HEP operator_source: ${entry.operator_source ?? '<missing>'}`);
      }
      return buildHepSearchDomainPackRuntime({
        operatorSelectionPolicy: entry.operator_selection_policy,
      });
    },
  };
}

export function loadHepBuiltinDomainPackProviders(): BuiltinDomainPackProvider[] {
  return hepBuiltinPackCatalogEntries().map(entry => buildHepBuiltinProvider(structuredClone(entry)));
}
