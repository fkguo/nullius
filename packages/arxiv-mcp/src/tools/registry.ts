/**
 * Tool Registry — 3 tools: arxiv_search, arxiv_get_metadata, arxiv_paper_source
 *
 * Zod schemas are the SSOT; handlers delegate to source layer functions.
 */

import { z } from 'zod';
import { zodToMcpInputSchema } from './mcpSchema.js';
import {
  ARXIV_SEARCH,
  ARXIV_GET_METADATA,
  ARXIV_PAPER_SOURCE,
  DiscoveryProviderDescriptorSchema,
  type DiscoveryProviderDescriptor,
} from '@autoresearch/shared';
import { ARXIV_ID_REGEX, normalizeArxivId } from '../source/arxivSource.js';
import { searchArxiv, fetchArxivMetadata } from '../api/searchClient.js';
import { accessPaperSource } from '../source/paperSource.js';

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
  handler: (args: z.infer<TSchema>, ctx: Record<string, unknown>) => Promise<unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared Schemas (§3.0)
// ─────────────────────────────────────────────────────────────────────────────

const ArxivIdSchema = z.string()
  .regex(ARXIV_ID_REGEX)
  .describe('arXiv paper ID (e.g. "2301.01234", "hep-ph/0601234", "math.GT/0309136")');

const ArxivCategorySchema = z.string()
  .regex(/^[a-z-]+(\.[a-zA-Z-]+)?$/)
  .describe('arXiv category (e.g. "hep-ph", "cond-mat.str-el", "stat.ML")');

// ─────────────────────────────────────────────────────────────────────────────
// Tool Schemas (§3a, §3b, §3c)
// ─────────────────────────────────────────────────────────────────────────────

const ArxivSearchSchema = z.object({
  query: z.string().min(1).describe('Search query (arXiv API search_query syntax)'),
  categories: z.array(ArxivCategorySchema).optional()
    .describe('Filter by arXiv categories (e.g. ["hep-ph", "hep-th"])'),
  max_results: z.number().int().positive().max(50).default(10)
    .describe('Maximum results to return'),
  start: z.number().int().nonnegative().default(0)
    .describe('Pagination offset'),
  date_from: z.string().regex(/^\d{8}$/).optional()
    .describe('Start date filter (YYYYMMDD)'),
  date_to: z.string().regex(/^\d{8}$/).optional()
    .describe('End date filter (YYYYMMDD)'),
  sort_by: z.enum(['relevance', 'lastUpdatedDate', 'submittedDate']).default('relevance')
    .describe('Sort order'),
}).refine(
  (d) => !d.date_from || !d.date_to || d.date_from <= d.date_to,
  { message: 'date_from must be <= date_to', path: ['date_from'] }
);

const ArxivGetMetadataSchema = z.object({
  arxiv_id: ArxivIdSchema,
});

const ArxivPaperSourceSchema = z.object({
  arxiv_id: ArxivIdSchema,
  mode: z.enum(['urls', 'content', 'metadata', 'auto']).default('auto')
    .describe('Access mode: urls=download links, content=LaTeX/PDF, metadata=arXiv info, auto=smart selection'),
  prefer: z.enum(['latex', 'pdf', 'auto']).optional().default('auto')
    .describe('Preferred content format (content mode only)'),
  extract: z.boolean().optional().default(true)
    .describe('Extract tar.gz archive (content mode only)'),
  max_content_kb: z.number().int().positive().optional()
    .describe('Content size limit in KB'),
  check_availability: z.boolean().optional().default(false)
    .describe('Check source availability via HEAD request (urls/auto mode)'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool Specs
// ─────────────────────────────────────────────────────────────────────────────

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: ARXIV_SEARCH,
    description: 'Search arXiv papers by query, categories, and date range',
    exposure: 'standard',
    zodSchema: ArxivSearchSchema,
    handler: async (args) => {
      return searchArxiv({
        query: args.query,
        categories: args.categories,
        max_results: args.max_results,
        start: args.start,
        date_from: args.date_from,
        date_to: args.date_to,
        sort_by: args.sort_by,
      });
    },
  },
  {
    name: ARXIV_GET_METADATA,
    description: 'Get arXiv paper metadata (title, authors, abstract, categories)',
    exposure: 'standard',
    zodSchema: ArxivGetMetadataSchema,
    handler: async (args) => {
      const metadata = await fetchArxivMetadata(args.arxiv_id);
      if (!metadata) {
        throw new Error(`No metadata found for arXiv ID: ${args.arxiv_id}`);
      }
      return metadata;
    },
  },
  {
    name: ARXIV_PAPER_SOURCE,
    description: 'Access arXiv paper source: download URLs, LaTeX/PDF content, or metadata',
    exposure: 'standard',
    zodSchema: ArxivPaperSourceSchema,
    handler: async (args) => {
      return accessPaperSource({
        identifier: args.arxiv_id,
        mode: args.mode,
        options: {
          prefer: args.prefer,
          extract: args.extract,
          check_availability: args.check_availability,
          max_content_kb: args.max_content_kb,
        },
      });
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Lookup Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function getToolSpec(name: string): ToolSpec | undefined {
  return TOOL_SPECS.find(s => s.name === name);
}

export function getToolSpecs(mode: ToolExposureMode = 'standard'): ToolSpec[] {
  return TOOL_SPECS.filter(s => isToolExposed(s, mode));
}

export function isToolExposed(spec: ToolSpec, mode: ToolExposureMode): boolean {
  if (mode === 'full') return true;
  return spec.exposure === 'standard';
}

export function getTools(mode: ToolExposureMode = 'standard') {
  return getToolSpecs(mode).map(spec => ({
    name: spec.name,
    description: spec.description,
    inputSchema: zodToMcpInputSchema(spec.zodSchema),
  }));
}

// Re-export schemas for external use
export { ArxivIdSchema, ArxivSearchSchema, ArxivGetMetadataSchema, ArxivPaperSourceSchema };
export { normalizeArxivId };

export const ARXIV_DISCOVERY_DESCRIPTOR: DiscoveryProviderDescriptor = DiscoveryProviderDescriptorSchema.parse({
  provider: 'arxiv',
  display_name: 'arXiv',
  capabilities: {
    supports_keyword_search: true,
    supports_semantic_search: false,
    supports_citation_graph: false,
    supports_fulltext: false,
    supports_source_download: true,
    supports_open_access_content: true,
  },
  supported_intents: ['known_item', 'keyword_search', 'fulltext_search'],
  notes: 'Kickoff descriptor for NEW-DISC-01; source download is supported, canonical broker artifacts come later.',
});
