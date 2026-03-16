import type { LibrarianRecipeBook } from './librarian-recipes.js';
import type { SearchDomainPackRuntime } from './search-operator.js';
import type { BuiltinDomainPackProvider, DomainPackEntry } from './domain-pack-types.js';
import { loadHepBuiltinDomainPackProviders } from './hep-domain-pack.js';

const BUILTIN_DOMAIN_PACK_PROVIDERS: readonly BuiltinDomainPackProvider[] = loadHepBuiltinDomainPackProviders();
const LIBRARIAN_RECIPE_BOOK_CACHE = new Map<string, LibrarianRecipeBook>();
const SEARCH_RUNTIME_CACHE = new Map<string, SearchDomainPackRuntime>();

function providerById(packId: string): BuiltinDomainPackProvider | undefined {
  return BUILTIN_DOMAIN_PACK_PROVIDERS.find(provider => provider.entry.pack_id === packId);
}

export function builtinDomainPacks(): DomainPackEntry[] {
  return BUILTIN_DOMAIN_PACK_PROVIDERS.map(({ entry }) => structuredClone(entry));
}

export function builtinDomainPackById(packId: string): DomainPackEntry | undefined {
  const provider = providerById(packId);
  return provider ? structuredClone(provider.entry) : undefined;
}

export function loadBuiltinLibrarianRecipeBook(packId: string): LibrarianRecipeBook {
  const cached = LIBRARIAN_RECIPE_BOOK_CACHE.get(packId);
  if (cached) {
    return cached;
  }
  const provider = providerById(packId);
  if (!provider) {
    throw new Error(`unknown built-in pack: ${packId}`);
  }
  const recipeBook = provider.buildLibrarianRecipeBook();
  LIBRARIAN_RECIPE_BOOK_CACHE.set(packId, recipeBook);
  return recipeBook;
}

export function loadBuiltinSearchDomainPackRuntime(packId: string): SearchDomainPackRuntime {
  const cached = SEARCH_RUNTIME_CACHE.get(packId);
  if (cached) {
    return cached;
  }
  const provider = providerById(packId);
  if (!provider) {
    throw new Error(`unknown built-in pack: ${packId}`);
  }
  const runtime = provider.loadSearchDomainPackRuntime();
  SEARCH_RUNTIME_CACHE.set(packId, runtime);
  return runtime;
}
