// Public API re-exports for library consumers (e.g., hep-mcp)

export {
  TOOL_SPECS,
  getToolSpec,
  getToolSpecs,
  getTools,
  type ToolExposureMode,
  type ToolSpec,
} from './tools/index.js';

// Source layer
export { normalizeArxivId, ARXIV_ID_REGEX, checkSourceAvailability, getArxivSource } from './source/arxivSource.js';
export type { ArxivMetadata, ArxivSourceResult } from './source/arxivSource.js';

export { getDownloadUrls } from './source/downloadUrls.js';
export type { GetDownloadUrlsParams, GetDownloadUrlsResult, SourceAvailability } from './source/downloadUrls.js';

export { getPaperContent } from './source/paperContent.js';
export type { GetPaperContentParams, GetPaperContentResult } from './source/paperContent.js';

export { accessPaperSource } from './source/paperSource.js';
export type { PaperSourceParams, PaperSourceResult, SourceMode, SourceOptions } from './source/paperSource.js';

// API layer
export { arxivFetch } from './api/rateLimiter.js';
export { searchArxiv, fetchArxivMetadata, parseArxivAtomEntry } from './api/searchClient.js';
export type { ArxivSearchResult, SearchParams } from './api/searchClient.js';
