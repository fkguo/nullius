import { z } from 'zod';

// ── Entity enum (shared across tools) ────────────────────────────────────────

export const EntityEnum = z.enum([
  'works', 'authors', 'sources', 'institutions', 'topics', 'publishers', 'funders', 'concepts',
]);

// ── openalex_search ──────────────────────────────────────────────────────────

export const OpenAlexSearchSchema = z.object({
  query: z.string().trim().min(1)
    .describe('Full-text search query (searches title, abstract, fulltext)'),
  filter: z.string().trim().min(1).optional()
    .describe('OpenAlex filter expression (e.g., "publication_year:>2020,is_oa:true")'),
  sort: z.string().trim().min(1).optional()
    .describe('Sort field:direction (e.g., "cited_by_count:desc", "publication_date:asc")'),
  per_page: z.coerce.number().int().min(1).max(200).default(25)
    .describe('Results per page (max 200)'),
  page: z.coerce.number().int().min(1).default(1)
    .describe('Page number (1-indexed). Ignored when cursor is provided.'),
  cursor: z.string().trim().min(1).optional()
    .describe('Cursor token from previous response for deep pagination'),
  select: z.string().trim().min(1).optional()
    .describe(
      'Comma-separated fields to return (e.g., "id,title,doi,cited_by_count"). ' +
      'Note: id and doi are always included automatically for works.',
    ),
  max_results: z.coerce.number().int().min(1).max(100000).optional()
    .describe(
      'Max total results (auto-paginates via cursor). Writes JSONL to data dir if >200. ' +
      'Omit for single page.',
    ),
  sample: z.coerce.number().int().min(1).optional()
    .describe('Return random sample of N results'),
  seed: z.coerce.number().int().optional()
    .describe('Seed for reproducible sampling (requires sample)'),
}).refine(
  data => !(data.seed !== undefined && data.sample === undefined),
  { message: 'seed requires sample to be set', path: ['seed'] },
).refine(
  data => !(data.sample !== undefined && data.max_results !== undefined),
  { message: 'sample and max_results are mutually exclusive', path: ['sample'] },
);

// ── openalex_semantic_search ─────────────────────────────────────────────────

export const OpenAlexSemanticSearchSchema = z.object({
  query: z.string().trim().min(1)
    .describe('Semantic search query (AI-powered similarity). Requires API key.'),
  filter: z.string().trim().min(1).optional()
    .describe('OpenAlex filter expression to scope results'),
  per_page: z.coerce.number().int().min(1).max(200).default(25)
    .describe('Results per page (max 200)'),
  page: z.coerce.number().int().min(1).default(1)
    .describe('Page number (1-indexed)'),
  select: z.string().trim().min(1).optional()
    .describe('Comma-separated fields. id and doi are always auto-included.'),
});

// ── openalex_get ─────────────────────────────────────────────────────────────

export const OpenAlexGetSchema = z.object({
  id: z.string().trim().min(1)
    .describe(
      'Entity ID: OpenAlex (W/A/S/I/T/P/F prefix), DOI, ORCID, ROR, ISSN, PMID, ' +
      'or full OpenAlex URL (https://openalex.org/...)',
    ),
  entity: EntityEnum.optional()
    .describe(
      'Entity type override (auto-detected from ID format if omitted). ' +
      'concepts included for legacy compatibility.',
    ),
  select: z.string().trim().min(1).optional()
    .describe('Comma-separated fields to return'),
});

// ── openalex_filter ──────────────────────────────────────────────────────────

export const OpenAlexFilterSchema = z.object({
  entity: EntityEnum
    .describe('Entity type to filter'),
  filter: z.string().trim().min(1)
    .describe(
      'OpenAlex filter expression. Syntax: "field:value" joined by comma (AND). ' +
      'OR via pipe "|", NOT via "!", range via ">","<". ' +
      'E.g., "publication_year:2023,is_oa:true,type:journal-article"',
    ),
  search: z.string().trim().min(1).optional()
    .describe('Optional text search within filtered results'),
  sort: z.string().trim().min(1).optional()
    .describe('Sort field:direction'),
  per_page: z.coerce.number().int().min(1).max(200).default(25)
    .describe('Results per page (max 200)'),
  page: z.coerce.number().int().min(1).default(1)
    .describe('Page number (1-indexed). Ignored when cursor is provided.'),
  cursor: z.string().trim().min(1).optional()
    .describe('Cursor token from previous response for deep pagination'),
  select: z.string().trim().min(1).optional()
    .describe('Comma-separated fields. id is always auto-included.'),
  max_results: z.coerce.number().int().min(1).max(100000).optional()
    .describe('Max total results (auto-paginates via cursor). Writes JSONL to data dir if >200.'),
});

// ── openalex_group ───────────────────────────────────────────────────────────

export const OpenAlexGroupSchema = z.object({
  entity: EntityEnum
    .describe('Entity type to aggregate'),
  group_by: z.string().trim().min(1)
    .describe(
      'Field to group by (e.g., "publication_year", "type", "is_oa", ' +
      '"open_access.oa_status")',
    ),
  filter: z.string().trim().min(1).optional()
    .describe('Filter expression to scope the aggregation'),
});

// ── openalex_references ──────────────────────────────────────────────────────

export const OpenAlexReferencesSchema = z.object({
  work_id: z.string().trim().min(1)
    .describe(
      'Work ID (OpenAlex W-prefixed, DOI, or full OpenAlex URL) to get outgoing references for',
    ),
  per_page: z.coerce.number().int().min(1).max(200).default(200)
    .describe('Results per page for batch-fetching reference metadata'),
  select: z.string().trim().min(1).optional()
    .describe('Fields to return for each referenced work. id always included.'),
});

// ── openalex_citations ───────────────────────────────────────────────────────

export const OpenAlexCitationsSchema = z.object({
  work_id: z.string().trim().min(1)
    .describe('Work ID to get incoming citations for'),
  sort: z.string().trim().min(1).optional()
    .describe('Sort field:direction (e.g., "cited_by_count:desc")'),
  filter: z.string().trim().min(1).optional()
    .describe('Filter applied to citing works'),
  per_page: z.coerce.number().int().min(1).max(200).default(25)
    .describe('Results per page (max 200)'),
  page: z.coerce.number().int().min(1).default(1)
    .describe('Page number (1-indexed). Ignored when cursor is provided.'),
  cursor: z.string().trim().min(1).optional()
    .describe('Cursor token from previous response for deep pagination'),
  select: z.string().trim().min(1).optional()
    .describe('Comma-separated fields. id always included.'),
  max_results: z.coerce.number().int().min(1).max(100000).optional()
    .describe('Max total results (auto-paginates via cursor). Writes JSONL if >200.'),
});

// ── openalex_batch ───────────────────────────────────────────────────────────

export const OpenAlexBatchSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).max(500)
    .describe(
      'Array of IDs (DOIs, OpenAlex IDs, PMIDs, full OpenAlex URLs). ' +
      'Auto-detects type, groups into batched requests.',
    ),
  select: z.string().trim().min(1).optional()
    .describe('Fields to return for each result. id always included.'),
});

// ── openalex_autocomplete ────────────────────────────────────────────────────

export const OpenAlexAutocompleteSchema = z.object({
  entity: EntityEnum
    .describe('Entity type to autocomplete'),
  query: z.string().trim().min(1)
    .describe('Partial query for type-ahead completion'),
});

// ── openalex_content ─────────────────────────────────────────────────────────

export const OpenAlexContentSchema = z.object({
  work_id: z.string().trim().min(1)
    .describe('Work ID to download content for'),
  type: z.enum(['pdf', 'tei']).default('pdf')
    .describe('Content type: pdf (full-text PDF) or tei (structured TEI-XML)'),
  out_dir: z.string().trim().min(1).optional()
    .describe('Output directory for downloaded file. Defaults to OPENALEX_DATA_DIR/content/.'),
  _confirm: z.literal(true)
    .describe('Must be true to confirm disk write (destructive tool).'),
  max_size_mb: z.coerce.number().min(1).max(200).default(100)
    .describe('Max download size in MB. Aborts if Content-Length exceeds this.'),
});

// ── openalex_rate_limit ──────────────────────────────────────────────────────

export const OpenAlexRateLimitSchema = z.object({
  refresh: z.boolean().default(false)
    .describe(
      'If true, makes a minimal-cost probe request to update cached rate-limit headers. ' +
      'If false (default), returns last-seen cached state (free, no API call).',
    ),
}).describe('Returns current API budget/rate-limit status from cached response headers.');
