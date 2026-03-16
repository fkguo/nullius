import type { LibrarianRecipeBook } from './librarian-recipes.js';
import type { SearchDomainPackRuntime } from './search-operator.js';

export interface DomainPackEntry {
  description?: string;
  domain_prefixes: string[];
  operator_selection_policy?: string;
  operator_source?: string;
  pack_id: string;
}

export interface BuiltinDomainPackProvider {
  buildLibrarianRecipeBook: () => LibrarianRecipeBook;
  entry: DomainPackEntry;
  loadSearchDomainPackRuntime: () => SearchDomainPackRuntime;
}
