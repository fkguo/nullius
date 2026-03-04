import { z } from 'zod';
import {
  OPENALEX_SEARCH,
  OPENALEX_SEMANTIC_SEARCH,
  OPENALEX_GET,
  OPENALEX_FILTER,
  OPENALEX_GROUP,
  OPENALEX_REFERENCES,
  OPENALEX_CITATIONS,
  OPENALEX_BATCH,
  OPENALEX_AUTOCOMPLETE,
  OPENALEX_CONTENT,
  OPENALEX_RATE_LIMIT,
} from '@autoresearch/shared';
import { zodToMcpInputSchema } from './mcpSchema.js';
import {
  OpenAlexSearchSchema,
  OpenAlexSemanticSearchSchema,
  OpenAlexGetSchema,
  OpenAlexFilterSchema,
  OpenAlexGroupSchema,
  OpenAlexReferencesSchema,
  OpenAlexCitationsSchema,
  OpenAlexBatchSchema,
  OpenAlexAutocompleteSchema,
  OpenAlexContentSchema,
  OpenAlexRateLimitSchema,
} from './schemas.js';
import {
  handleSearch,
  handleSemanticSearch,
  handleGet,
  handleFilter,
  handleGroup,
  handleReferences,
  handleCitations,
  handleBatch,
  handleAutocomplete,
} from '../api/client.js';
import { handleContent } from '../api/contentDownload.js';
import { handleRateLimit } from '../api/rateLimitCheck.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ToolExposureMode = 'standard' | 'full';
export type ToolExposure = 'standard' | 'full';

export interface ToolSpec<TSchema extends z.ZodType<any, any> = z.ZodType<any, any>> {
  name: string;
  description: string;
  exposure: ToolExposure;
  zodSchema: TSchema;
  handler: (args: z.infer<TSchema>) => Promise<unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Specs
// ─────────────────────────────────────────────────────────────────────────────

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: OPENALEX_SEARCH,
    exposure: 'standard',
    description: `Search OpenAlex works by full-text (title/abstract/fulltext). Returns paginated results with cursor for deep pagination.

Supports:
- Free-text search across 240M+ scholarly works
- Filter by year, OA status, type, institution, etc. via filter param
- Cursor-based pagination (returns cursor for next page)
- Bulk mode: set max_results > per_page to auto-paginate and write JSONL file
- Random sampling via sample + seed params

Examples:
  { query: "transformer attention mechanism", filter: "publication_year:>2020,is_oa:true" }
  { query: "lattice QCD", sort: "cited_by_count:desc", per_page: 50 }
  { query: "dark matter", max_results: 1000 } → writes results_file JSONL`,
    zodSchema: OpenAlexSearchSchema,
    handler: async args => handleSearch(args),
  },

  {
    name: OPENALEX_SEMANTIC_SEARCH,
    exposure: 'standard',
    description: `AI-powered semantic similarity search for OpenAlex works. Requires OPENALEX_API_KEY.

Unlike keyword search, semantic search finds conceptually related papers even without exact keyword matches.
Best for: finding papers by concept/topic rather than specific terms.`,
    zodSchema: OpenAlexSemanticSearchSchema,
    handler: async args => handleSemanticSearch(args),
  },

  {
    name: OPENALEX_GET,
    exposure: 'standard',
    description: `Get a single OpenAlex entity by any supported ID format (network).

Supported ID types (auto-detected):
- OpenAlex ID: W1234567, A1234567, S1234567, I1234567, T1234567, P1234567, F1234567
- Full OpenAlex URL: https://openalex.org/W1234567
- DOI: 10.1038/nature12373 or https://doi.org/10.1038/nature12373
- ORCID: 0000-0001-2345-6789 or https://orcid.org/0000-0001-2345-6789
- ROR: https://ror.org/04a9tmd77
- ISSN: 1234-5678 or issn:1234-5678
- PMID: pmid:12345678

Returns the full entity object (all fields) unless select is specified.`,
    zodSchema: OpenAlexGetSchema,
    handler: async args => handleGet(args),
  },

  {
    name: OPENALEX_FILTER,
    exposure: 'standard',
    description: `Filter/list any OpenAlex entity type with structured filter syntax (network).

Filter syntax:
- "field:value" — exact match
- "field:value1|value2" — OR (pipe)
- "!field:value" — NOT
- "field:>value" or "field:<value" — numeric range
- Comma-join for AND: "pub_year:2023,is_oa:true"

Examples:
  { entity: "works", filter: "authorships.author.id:A1234567,publication_year:>2020" }
  { entity: "institutions", filter: "country_code:US,type:education" }
  { entity: "works", filter: "concepts.id:C71924100", sort: "cited_by_count:desc" }

Supports cursor pagination and bulk JSONL output via max_results.`,
    zodSchema: OpenAlexFilterSchema,
    handler: async args => handleFilter(args),
  },

  {
    name: OPENALEX_GROUP,
    exposure: 'standard',
    description: `Aggregate OpenAlex entities by a field (group_by) with optional filter (network).

Returns counts grouped by field value — useful for bibliometrics and trends.

Examples:
  { entity: "works", group_by: "publication_year" }                → papers per year
  { entity: "works", group_by: "open_access.oa_status" }          → OA status breakdown
  { entity: "works", group_by: "type", filter: "institution.id:I1234567" }
  { entity: "authors", group_by: "last_known_institutions.country_code" }`,
    zodSchema: OpenAlexGroupSchema,
    handler: async args => handleGroup(args),
  },

  {
    name: OPENALEX_REFERENCES,
    exposure: 'standard',
    description: `Get outgoing references (bibliography) of a work (network).

Returns the list of works cited by the given paper, with metadata.
work_id accepts: OpenAlex W-ID, DOI, or full OpenAlex URL.`,
    zodSchema: OpenAlexReferencesSchema,
    handler: async args => handleReferences(args),
  },

  {
    name: OPENALEX_CITATIONS,
    exposure: 'standard',
    description: `Get incoming citations (citing works) for a work (network).

Returns works that cite the given paper.
Supports cursor pagination and bulk JSONL output via max_results.

work_id accepts: OpenAlex W-ID, DOI, or full OpenAlex URL.`,
    zodSchema: OpenAlexCitationsSchema,
    handler: async args => handleCitations(args),
  },

  {
    name: OPENALEX_BATCH,
    exposure: 'standard',
    description: `Batch lookup up to 500 entities by mixed ID types (network).

Accepts a mix of DOIs, OpenAlex IDs, PMIDs, and full OpenAlex URLs.
Auto-detects each ID type and batches requests efficiently.

Returns per-item status: found / not_found / error.

Example:
  { ids: ["10.1038/nature12373", "W2741809807", "pmid:12345678"] }`,
    zodSchema: OpenAlexBatchSchema,
    handler: async args => handleBatch(args),
  },

  {
    name: OPENALEX_AUTOCOMPLETE,
    exposure: 'standard',
    description: `Fast type-ahead autocomplete for any OpenAlex entity (network).

Returns display names and IDs matching a partial query string.
Useful for resolving partial author/institution/venue names to OpenAlex IDs.`,
    zodSchema: OpenAlexAutocompleteSchema,
    handler: async args => handleAutocomplete(args),
  },

  {
    name: OPENALEX_CONTENT,
    exposure: 'full',
    description: `Download full-text PDF or TEI-XML from content.openalex.org (network, writes files, requires _confirm: true).

Downloads open-access full text for a work. Requires OpenAlex content API access.
File is written atomically to OPENALEX_DATA_DIR/content/ (or out_dir if specified).

Returns: file_path, file_size, mime_type, uri.`,
    zodSchema: OpenAlexContentSchema,
    handler: async args => handleContent(args),
  },

  {
    name: OPENALEX_RATE_LIMIT,
    exposure: 'standard',
    description: `Check current OpenAlex API rate limit and budget status (local-only unless refresh=true).

Returns cached rate-limit state from last API response (free, no API call).
Set refresh=true to make a minimal probe request and update the cached state.

Returns: cumulative_usd, remaining_usd, resets_at, pages_fetched, retries.`,
    zodSchema: OpenAlexRateLimitSchema,
    handler: async args => handleRateLimit(args),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Registry helpers
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_SPECS_BY_NAME = new Map<string, ToolSpec>(TOOL_SPECS.map(s => [s.name, s]));

export function getToolSpec(name: string): ToolSpec | undefined {
  return TOOL_SPECS_BY_NAME.get(name);
}

export function isToolExposed(spec: ToolSpec, mode: ToolExposureMode): boolean {
  return spec.exposure === 'standard' || mode === 'full';
}

export function getToolSpecs(mode: ToolExposureMode = 'standard'): ToolSpec[] {
  return TOOL_SPECS.filter(spec => isToolExposed(spec, mode));
}

export function getTools(mode: ToolExposureMode = 'standard') {
  return getToolSpecs(mode).map(spec => ({
    name: spec.name,
    description: spec.description,
    inputSchema: zodToMcpInputSchema(spec.zodSchema),
  }));
}
