export { LRUCache, type CacheStats } from './lruCache.js';

export {
  INSPIRE_BASE_URL,
  INSPIRE_API_URL,
  INSPIRE_LITERATURE_URL,
  ARXIV_BASE_URL,
  ARXIV_ABS_URL,
  DOI_ORG_URL,
  extractRecidFromUrl,
  extractRecidFromRecordRef,
  extractRecidFromUrls,
  normalizeArxivID,
  normalizeArxivCategories,
  buildInspireUrl,
  buildArxivUrl,
  buildDoiUrl,
} from './identifiers.js';

export {
  normalizeSearchText,
  buildVariantSet,
  buildSearchIndexText,
} from './textUtils.js';

export {
  normalizeInitials,
  buildInitials,
  formatAuthorName,
  formatAuthors,
} from './formatters.js';

export { cleanMathTitle } from './mathTitle.js';
